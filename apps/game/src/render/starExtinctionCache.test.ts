import { expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { WebGPURenderer } from 'three/webgpu'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 } from '@inertialref/spatial'
import { rootSeed } from '@inertialref/procedural'
import {
  createGalaxyField,
  integrateStarExtinction,
  SUN_POSITION,
} from '@inertialref/universe'
import {
  StarExtinctionCache,
  StarExtinctionSchedule,
  type StarExtinctionSelection,
} from './starExtinctionCache.ts'
const field = createGalaxyField(rootSeed('inertialref'))
const selection = (ids: readonly string[]): StarExtinctionSelection => ({
  ids,
  positions: ids.map((id) =>
    UV.translate(SUN_POSITION, vec3((Number(id) + 1) * 10 * PARSEC, 0, 0)),
  ),
  catalogued: ids.map(() => false),
})

it('preserves source slots and completed columns through selection reorder and local observer motion', () => {
  const schedule = new StarExtinctionSchedule(12),
    stars = selection(['0', '1', '2'])
  schedule.configure(stars, SUN_POSITION, field)
  const batch = schedule.next(2)!
  expect(schedule.complete(batch)).toBe(true)
  const slots = new Map(
    schedule.selected.map((source) => [source.id, source.slot]),
  )
  schedule.configure(
    selection(['2', '1', '0', '3']),
    UV.translate(SUN_POSITION, vec3(0.14 * PARSEC, 0, 0)),
    field,
  )
  expect(schedule.diagnostics.pending).toBe(2)
  for (const source of schedule.selected.filter((s) => slots.has(s.id)))
    expect(source.slot).toBe(slots.get(source.id))
  expect(schedule.next(12)!.sources.map((s) => s.id)).toEqual(['2', '3'])
})

it('rejects canceled inactive, replaced source and retired batches', () => {
  const schedule = new StarExtinctionSchedule(3),
    stars = selection(['0', '1', '2'])
  schedule.configure(stars, SUN_POSITION, field)
  const stale = schedule.next(3)!
  schedule.configure(stars, null, field)
  expect(schedule.complete(stale)).toBe(false)
  schedule.configure(stars, SUN_POSITION, field)
  const moved = schedule.next(3)!
  schedule.configure(
    selection(['0', '1', '3']),
    UV.translate(SUN_POSITION, vec3(PARSEC, 0, 0)),
    field,
  )
  expect(schedule.complete(moved)).toBe(false)
  const replacement = schedule.next(3)!
  schedule.dispose()
  expect(schedule.complete(replacement)).toBe(false)
  expect(schedule.next(3)).toBeNull()
  expect(schedule.diagnostics.retained).toBe(0)
})

it('never assigns one slot to two current identities across bounded replacements', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.uniqueArray(fc.integer({ min: 0, max: 63 }), {
          minLength: 1,
          maxLength: 16,
        }),
        { minLength: 1, maxLength: 20 },
      ),
      (rows) => {
        const schedule = new StarExtinctionSchedule(16)
        for (const row of rows) {
          schedule.configure(selection(row.map(String)), SUN_POSITION, field)
          expect(new Set(schedule.selected.map((s) => s.slot)).size).toBe(
            row.length,
          )
          expect(
            schedule.selected.every((s) => s.slot >= 0 && s.slot < 16),
          ).toBe(true)
          let batch = schedule.next(3)
          while (batch !== null) {
            expect(batch.sources.length).toBeLessThanOrEqual(3)
            expect(schedule.complete(batch)).toBe(true)
            batch = schedule.next(3)
          }
          expect(schedule.diagnostics.pending).toBe(0)
        }
      },
    ),
    { numRuns: 25 },
  )
})

it('keeps catalogue flux calibrated at Sol and reuses its reference column on the CPU fallback', async () => {
  const cache = new StarExtinctionCache(4, field, {
    cpu: true,
    cpuBatchSize: 2,
  })
  const stars = {
      ...selection(['0', '1', '2', '3']),
      catalogued: [true, true, true, true],
    },
    renderer = {} as WebGPURenderer
  cache.configure(stars, SUN_POSITION)
  expect(cache.advance(renderer)).toBe(false)
  await cache.warm(renderer)
  cache.advance(renderer)
  expect(cache.diagnostics.pending).toBe(0)
  cache.advance(renderer)
  expect(
    cache.schedule.selected.every((source) =>
      source.corrected?.every((t) => t === 1),
    ),
  ).toBe(true)
  const moved = UV.translate(SUN_POSITION, vec3(100 * PARSEC, 0, 0))
  cache.configure(stars, moved)
  cache.advance(renderer)
  const source = cache.schedule.selected[0]!
  const reference = source.reference
  const current = integrateStarExtinction(
    field,
    moved,
    source.position,
  ).opticalDepthRgb
  reference!.forEach((depth, c) =>
    expect(source.corrected![c]).toBeCloseTo(Math.exp(depth - current[c]!), 12),
  )
  cache.configure(stars, UV.translate(moved, vec3(PARSEC, 0, 0)))
  cache.advance(renderer)
  expect(cache.schedule.selected[0]!.reference).toBe(reference)
  cache.dispose()
  expect(cache.diagnostics.bytes).toBe(0)
  expect(cache.advance(renderer)).toBe(false)
})

it('rejects a warm-up result that arrives after renderer retirement', async () => {
  let resolve!: () => void
  const renderer = {
    computeAsync: vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    ),
  } as unknown as WebGPURenderer
  const cache = new StarExtinctionCache(1, field)
  cache.configure(selection(['0']), SUN_POSITION)
  const warm = cache.warm(renderer)
  cache.dispose()
  resolve()
  await warm
  expect(cache.diagnostics.ready).toBe(false)
  expect(cache.advance(renderer)).toBe(false)
})

it('finishes a finite observer cycle during continuous travel before refreshing at the latest observer', () => {
  const schedule = new StarExtinctionSchedule(12),
    stars = selection(Array.from({ length: 12 }, (_, i) => String(i)))
  schedule.configure(stars, SUN_POSITION, field)
  const generation = schedule.generation
  for (let frame = 0; frame < 6; frame++) {
    schedule.configure(
      stars,
      UV.translate(SUN_POSITION, vec3((frame + 1) * PARSEC, 0, 0)),
      field,
    )
    expect(schedule.generation).toBe(generation)
    expect(UV.distance(schedule.origin!, SUN_POSITION)).toBe(0)
    const batch = schedule.next(2)!
    expect(batch.sources.map((s) => s.id)).toEqual([
      String(frame * 2),
      String(frame * 2 + 1),
    ])
    expect(schedule.complete(batch)).toBe(true)
  }
  expect(schedule.diagnostics.pending).toBe(0)
  expect(schedule.diagnostics.lagParsecs).toBeCloseTo(6, 10)
  const latest = UV.translate(SUN_POSITION, vec3(7 * PARSEC, 0, 0))
  schedule.configure(stars, latest, field)
  expect(schedule.generation).toBe(generation + 1)
  expect(UV.distance(schedule.origin!, latest)).toBe(0)
  expect(schedule.diagnostics.pending).toBe(12)
})

it('does not rewrite catalogue reference columns during idle Sol frames', () => {
  const schedule = new StarExtinctionSchedule(3)
  const stars = {
    ...selection(['0', '1', '2']),
    catalogued: [true, true, true],
  }
  schedule.configure(stars, SUN_POSITION, field)
  const columns = schedule.selected.map((source) => source.corrected)
  for (let frame = 0; frame < 100; frame++) {
    expect(
      schedule.configure(
        stars,
        UV.translate(SUN_POSITION, vec3(frame, 0, 0)),
        field,
      ),
    ).toBe(false)
    schedule.selected.forEach((source, index) =>
      expect(source.corrected).toBe(columns[index]),
    )
  }
})
