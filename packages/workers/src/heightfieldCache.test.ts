import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  generateHeightfield,
  regionAddress,
  surfaceGrammar,
  surfaceIdentity,
} from '@inertialref/universe'
import type { ArchivedSource } from './tasks.ts'
import {
  HeightfieldArchive,
  heightfieldArchiveVersion,
  heightfieldCacheKey,
  type HeightfieldStore,
} from './heightfieldCache.ts'

const seed = rootSeed('generated-world-cache')
const surface = {
  seed,
  maxElevation: 8000,
  roughness: 3,
  seaLevel: 10,
  grammar: surfaceGrammar(seed, {
    mass: 7.35e22,
    meanRadius: 1.737e6,
    atmosphere: null,
    temperature: 270,
    tidalProxy: 0,
    hasOcean: true,
    hadOcean: true,
    reliefSpent: 1,
    publishedRelief: 8000,
  }),
}
const request = { region: regionAddress(0, 2, 0, 0), resolution: 3, border: 1 }
function clone(value: unknown): unknown {
  if (value === null) return null
  const row = value as import('./heightfieldCache.ts').HeightfieldCacheRecord
  return {
    ...row,
    field: {
      ...row.field,
      region: { ...row.field.region },
      elevations: row.field.elevations.slice(),
      cover: row.field.cover.slice(),
      water: row.field.water.slice(),
    },
  }
}
function fixture() {
  const rows = new Map<string, unknown>()
  const store: HeightfieldStore = {
    read: vi.fn(async (key) => clone(rows.get(key) ?? null)),
    write: vi.fn(async (record) => {
      rows.set(record.key, clone(record))
    }),
    remove: vi.fn(async (key) => {
      rows.delete(key)
    }),
    clear: vi.fn(async () => {
      rows.clear()
    }),
    stats: async () => ({
      entries: rows.size,
      bytes: 0,
      maxEntries: 100,
      maxBytes: 1000000,
    }),
    close: vi.fn(),
  }
  const source: ArchivedSource = {
    kind: 'pool',
    archive: 'cpu@test',
    available: true,
    submit: vi.fn((s, r) => ({
      id: 1,
      result: Promise.resolve(generateHeightfield(s, r)),
      cancel: vi.fn(),
    })),
  }
  const archive = new HeightfieldArchive(store)
  return { rows, store, source, archive, cache: archive.wrap(source) }
}

/** The path to every leaf of a plain record: each number, string, boolean and null in it. */
function leaves(value: unknown, path: readonly string[] = []): string[][] {
  if (value === null || typeof value !== 'object') return [[...path]]
  return Object.entries(value).flatMap(([key, item]) =>
    leaves(item, [...path, key]),
  )
}

/** A copy of `value` with one leaf replaced, every record on the way to it new. */
function replaced(
  value: unknown,
  path: readonly string[],
  leaf: unknown,
): unknown {
  const [head, ...rest] = path
  if (head === undefined) return leaf
  const record = value as Record<string, unknown>
  return { ...record, [head]: replaced(record[head], rest, leaf) }
}

describe('regenerable heightfield cache', () => {
  /*
   * The archive key is the surface's identity, the request's, the canonical
   * terrain version and the producer's namespace, and the property is that it
   * moves exactly when one input field does — over every leaf of the surface,
   * its grammar included, and of the request, read off the records rather than
   * listed, so a field added to either is a field this already covers.
   *
   * The values are weighted to the ones a serializer collapses:
   * `JSON.stringify` writes `null` for NaN and both infinities and `0` for −0,
   * and an absent field and `undefined` are the same hole. Two of those at
   * one leaf sharing a key is a lookup answered with a tile generated from
   * different arithmetic.
   */
  it('moves the key exactly when a field of the surface or the request moves', () => {
    // `seabed` spelled out, so the one optional request member is a leaf too.
    const inputs = { surface, request: { ...request, seabed: false } }
    const awkward = fc.constantFrom<unknown>(
      null,
      undefined,
      Number.NaN,
      Infinity,
      -Infinity,
      0,
      -0,
      '',
      'null',
      'NaN',
      false,
    )
    const value = fc.oneof(awkward, fc.double(), fc.integer(), fc.string())
    const key = (changed: unknown): string => {
      const { surface: s, request: r } = changed as typeof inputs
      return heightfieldCacheKey(s, r, 'cpu')
    }
    fc.assert(
      fc.property(
        fc.constantFrom(...leaves(inputs)),
        value,
        value,
        (path, a, b) => {
          const x = replaced(inputs, path, a)
          const y = replaced(inputs, path, b)
          expect(key(x) === key(y)).toBe(Object.is(a, b))
          if (path[0] === 'surface') {
            const sx = (x as typeof inputs).surface
            const sy = (y as typeof inputs).surface
            expect(surfaceIdentity(sx) === surfaceIdentity(sy)).toBe(
              Object.is(a, b),
            )
          }
        },
      ),
      { numRuns: 2_000 },
    )
  })
  it('keys a surface and a request rebuilt in another order alike, under its version and namespace', () => {
    const key = heightfieldCacheKey(surface, request, 'cpu')
    // A worker rebuilds the surface from its payload, and a request may be
    // spread in any order; neither is a different tile.
    expect(
      heightfieldCacheKey(
        { ...surface, grammar: { ...surface.grammar } },
        { border: 1, resolution: 3, region: request.region },
        'cpu',
      ),
    ).toBe(key)
    expect(heightfieldCacheKey(surface, request, 'gpu')).not.toBe(key)
    // The canonical terrain version leads the key, under every namespace.
    expect(
      key.startsWith(JSON.stringify(heightfieldArchiveVersion('cpu'))),
    ).toBe(true)
  })
  it('restores every typed array exactly across archives without generating', async () => {
    const f = fixture()
    const first = await f.cache.submit(surface, request).result
    await f.archive.flush()
    // A reload: a new archive over the same store.
    const next = new HeightfieldArchive(f.store)
    const second = await next.wrap(f.source).submit(surface, request).result
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(f.source.submit).toHaveBeenCalledTimes(1)
    expect(next.stats().hits).toBe(1)
  })
  it('regenerates a corrupt finite elevation and a truncated water record', async () => {
    const f = fixture()
    await f.cache.submit(surface, request).result
    await f.archive.flush()
    const key = [...f.rows.keys()][0]!
    const record = f.rows.get(key) as {
      field: { elevations: Float32Array; water: Float32Array }
    }
    record.field.elevations[0] = 123
    await f.cache.submit(surface, request).result
    await f.archive.flush()
    ;(f.rows.get(key) as typeof record).field.water = new Float32Array(0)
    await f.cache.submit(surface, request).result
    expect(f.source.submit).toHaveBeenCalledTimes(3)
    expect(f.archive.stats().invalid).toBe(2)
  })
  it('continues generation when reads or quota-limited writes fail', async () => {
    const f = fixture()
    vi.mocked(f.store.read).mockRejectedValue(new Error('unavailable'))
    vi.mocked(f.store.write).mockRejectedValue(new Error('quota'))
    await expect(
      f.cache.submit(surface, request).result,
    ).resolves.toHaveProperty('water')
    await f.archive.flush()
    expect(f.archive.stats()).toMatchObject({ readErrors: 1, writeErrors: 1 })
  })
  it('cancels during a disk lookup without submitting generation or writing', async () => {
    const f = fixture()
    let release!: (value: unknown) => void
    vi.mocked(f.store.read).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const job = f.cache.submit(surface, request)
    job.cancel()
    await expect(job.result).rejects.toThrow('canceled')
    release(null)
    await Promise.resolve()
    expect(f.source.submit).not.toHaveBeenCalled()
    expect(f.store.write).not.toHaveBeenCalled()
  })
  it('forwards cancellation after a miss and preserves producer capability checks', async () => {
    const f = fixture()
    let reject!: (cause: Error) => void
    const cancel = vi.fn(() => reject(new Error('canceled')))
    vi.mocked(f.source.submit).mockReturnValue({
      id: 1,
      result: new Promise((_, fail) => {
        reject = fail
      }),
      cancel,
    })
    const job = f.cache.submit(surface, request)
    await Promise.resolve()
    job.cancel()
    await expect(job.result).rejects.toThrow('canceled')
    expect(cancel).toHaveBeenCalledOnce()
    expect(f.cache.kind).toBe('pool')
    expect(f.cache.available).toBe(true)
  })
})

/** A producer whose one tile arrives when the test says. */
function deferred(namespace: string) {
  let resolve!: (field: ReturnType<typeof generateHeightfield>) => void
  const source: ArchivedSource = {
    kind: 'gpu',
    archive: namespace,
    available: true,
    submit: () => ({
      id: 2,
      result: new Promise((done) => {
        resolve = done
      }),
      cancel() {},
    }),
  }
  return {
    source,
    arrive: () => resolve(generateHeightfield(surface, request)),
  }
}

describe('the archive', () => {
  it('retires every producer’s lookups on clear, so none repopulates it', async () => {
    const f = fixture()
    const gpu = deferred('gpu:test')
    const job = f.archive.wrap(gpu.source).submit(surface, request)
    await Promise.resolve()
    // Cleared through the archive the pool's wrapper also belongs to.
    await f.archive.clear()
    gpu.arrive()
    await job.result
    await f.archive.flush()
    expect(f.rows.size).toBe(0)
  })

  it('counts both producers’ traffic in one place', async () => {
    const f = fixture()
    await f.cache.submit(surface, request).result
    const gpu = deferred('gpu:test')
    const job = f.archive.wrap(gpu.source).submit(surface, request)
    await Promise.resolve()
    gpu.arrive()
    await job.result
    await f.archive.flush()
    // Different namespaces: the GPU's lookup missed the pool's tile.
    expect(f.archive.stats()).toMatchObject({ misses: 2, writes: 2, hits: 0 })
    expect(f.rows.size).toBe(2)
    expect(await f.archive.storage()).toMatchObject({ entries: 2 })
  })

  it('closes after its writes land, and passes straight through afterward', async () => {
    const f = fixture()
    let land!: () => void
    vi.mocked(f.store.write).mockImplementationOnce(
      (record) =>
        new Promise<void>((done) => {
          land = () => {
            f.rows.set(record.key, clone(record))
            done()
          }
        }),
    )
    await f.cache.submit(surface, request).result
    const closing = f.archive.close()
    await Promise.resolve()
    expect(f.store.close).not.toHaveBeenCalled()
    land()
    await closing
    expect(f.rows.size).toBe(1)
    expect(f.store.close).toHaveBeenCalledOnce()
    // A request after the close never touches the store it released.
    vi.mocked(f.store.read).mockClear()
    await f.cache.submit(surface, request).result
    expect(f.store.read).not.toHaveBeenCalled()
    expect(f.source.submit).toHaveBeenCalledTimes(2)
    await f.archive.close()
    expect(f.store.close).toHaveBeenCalledOnce()
    // Nor does a clear or a storage query, either of which reopens a disk store.
    await expect(f.archive.clear()).rejects.toThrow('closed')
    await expect(f.archive.storage()).rejects.toThrow('closed')
    expect(f.store.clear).not.toHaveBeenCalled()
  })
})

it('a synchronous storage write failure still delivers the generated field', async () => {
  const f = fixture()
  vi.mocked(f.store.write).mockImplementation(() => {
    throw new Error('storage closed')
  })
  await expect(f.cache.submit(surface, request).result).resolves.toHaveProperty(
    'elevations',
  )
  await f.archive.flush()
  expect(f.archive.stats().writeErrors).toBe(1)
})

it('does not report a persisted write when the store refuses an oversized record', async () => {
  const f = fixture()
  vi.mocked(f.store.write).mockResolvedValue(false)
  await expect(f.cache.submit(surface, request).result).resolves.toHaveProperty(
    'elevations',
  )
  await f.archive.flush()
  expect(f.archive.stats()).toMatchObject({ writes: 0, writeErrors: 0 })
})
