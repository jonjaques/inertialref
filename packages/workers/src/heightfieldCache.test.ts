import { describe, expect, it, vi } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  generateHeightfield,
  regionAddress,
  surfaceGrammar,
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

describe('regenerable heightfield cache', () => {
  it('keys the full surface, request, producer and arithmetic versions independent of object order', () => {
    const key = heightfieldCacheKey(surface, request, 'cpu')
    expect(
      heightfieldCacheKey(
        { ...surface, grammar: { ...surface.grammar } },
        { border: 1, resolution: 3, region: request.region },
        'cpu',
      ),
    ).toBe(key)
    for (const changed of [
      { ...request, seabed: true },
      { ...request, border: 0 },
      { ...request, resolution: 4 },
      { ...request, region: regionAddress(1, 2, 0, 0) },
    ])
      expect(heightfieldCacheKey(surface, changed, 'cpu')).not.toBe(key)
    for (const changed of [
      { ...surface, maxElevation: 8001 },
      { ...surface, roughness: 4 },
      { ...surface, seaLevel: null },
      { ...surface, seed: rootSeed('other') },
      {
        ...surface,
        grammar: {
          ...surface.grammar,
          meanRadius: surface.grammar.meanRadius + 1,
        },
      },
    ])
      expect(heightfieldCacheKey(changed, request, 'cpu')).not.toBe(key)
    expect(heightfieldCacheKey(surface, request, 'gpu')).not.toBe(key)
    // The canonical terrain version leads the key, under every namespace.
    expect(
      key.startsWith(JSON.stringify(heightfieldArchiveVersion('cpu'))),
    ).toBe(true)
  })
  it('separates a non-finite number from null and from the other non-finites', () => {
    // `JSON.stringify` writes `null` for NaN and for either infinity, so four
    // distinct sea levels would have shared one key and the cache would have
    // answered a lookup with a tile generated from different arithmetic.
    const keys = [null, Number.NaN, Infinity, -Infinity].map((seaLevel) =>
      heightfieldCacheKey({ ...surface, seaLevel }, request, 'cpu'),
    )
    expect(new Set(keys).size).toBe(4)
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
