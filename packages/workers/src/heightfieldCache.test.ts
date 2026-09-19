import { describe, expect, it, vi } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  generateHeightfield,
  regionAddress,
  surfaceGrammar,
} from '@inertialref/universe'
import type { HeightfieldSource } from './tasks.ts'
import {
  CachedHeightfieldSource,
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
  }
  const source: HeightfieldSource = {
    kind: 'pool',
    available: true,
    submit: vi.fn((s, r) => ({
      id: 1,
      result: Promise.resolve(generateHeightfield(s, r)),
      cancel: vi.fn(),
    })),
  }
  return {
    rows,
    store,
    source,
    cache: new CachedHeightfieldSource(source, store, 'cpu'),
  }
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
    expect(heightfieldCacheKey(surface, request, 'cpu', 'future')).not.toBe(key)
  })
  it('restores every typed array exactly across source instances without generating', async () => {
    const f = fixture()
    const first = await f.cache.submit(surface, request).result
    await f.cache.flush()
    const next = new CachedHeightfieldSource(f.source, f.store, 'cpu')
    const second = await next.submit(surface, request).result
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(f.source.submit).toHaveBeenCalledTimes(1)
    expect(next.stats().hits).toBe(1)
  })
  it('regenerates a corrupt finite elevation and a truncated water record', async () => {
    const f = fixture()
    await f.cache.submit(surface, request).result
    await f.cache.flush()
    const key = [...f.rows.keys()][0]!
    const record = f.rows.get(key) as {
      field: { elevations: Float32Array; water: Float32Array }
    }
    record.field.elevations[0] = 123
    await f.cache.submit(surface, request).result
    await f.cache.flush()
    ;(f.rows.get(key) as typeof record).field.water = new Float32Array(0)
    await f.cache.submit(surface, request).result
    expect(f.source.submit).toHaveBeenCalledTimes(3)
    expect(f.cache.stats().invalid).toBe(2)
  })
  it('continues generation when reads or quota-limited writes fail', async () => {
    const f = fixture()
    vi.mocked(f.store.read).mockRejectedValue(new Error('unavailable'))
    vi.mocked(f.store.write).mockRejectedValue(new Error('quota'))
    await expect(
      f.cache.submit(surface, request).result,
    ).resolves.toHaveProperty('water')
    await f.cache.flush()
    expect(f.cache.stats()).toMatchObject({ readErrors: 1, writeErrors: 1 })
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

it('clearing a shared store prevents an older GPU request from repopulating it', async () => {
  const f = fixture()
  let resolve!: (field: ReturnType<typeof generateHeightfield>) => void
  const gpu = new CachedHeightfieldSource(
    {
      kind: 'gpu',
      available: true,
      submit: () => ({
        id: 2,
        result: new Promise((done) => {
          resolve = done
        }),
        cancel() {},
      }),
    },
    f.store,
    'gpu:terrain-tsl@1',
  )
  const job = gpu.submit(surface, request)
  await Promise.resolve()
  await f.cache.clear()
  resolve(generateHeightfield(surface, request))
  await job.result
  await gpu.flush()
  expect(f.rows.size).toBe(0)
})

it('a synchronous storage write failure still delivers the generated field', async () => {
  const f = fixture()
  vi.mocked(f.store.write).mockImplementation(() => {
    throw new Error('storage closed')
  })
  await expect(f.cache.submit(surface, request).result).resolves.toHaveProperty(
    'elevations',
  )
  await f.cache.flush()
  expect(f.cache.stats().writeErrors).toBe(1)
})
