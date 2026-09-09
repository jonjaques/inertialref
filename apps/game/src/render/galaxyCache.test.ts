import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 } from '@inertialref/spatial'
import { rootSeed } from '@inertialref/procedural'
import { createGalaxyField, SUN_POSITION } from '@inertialref/universe'
import { GalaxyCacheSchedule } from './galaxyCache.ts'

const field = createGalaxyField(rootSeed('inertialref'))
const finish = (cache: GalaxyCacheSchedule) => {
  for (let tile = cache.next(); tile !== null; tile = cache.next())
    expect(cache.complete(tile)).toBe(true)
}

it('publishes only complete cubes and reuses them for rotations and local travel', () => {
  const cache = new GalaxyCacheSchedule({ faceSize: 128, tileSize: 32 })
  cache.configure(SUN_POSITION, field)
  expect(cache.selected).toBeNull()
  for (let i = 0; i < 95; i++) {
    const tile = cache.next()!
    expect(tile.width * tile.height).toBeLessThanOrEqual(32 ** 2)
    expect(cache.complete(tile)).toBe(true)
    expect(cache.selected).toBeNull()
  }
  expect(cache.complete(cache.next()!)).toBe(true)
  expect(cache.selected).not.toBeNull()
  const selected = cache.selected
  cache.configure(UV.translate(SUN_POSITION, vec3(0.1 * PARSEC, 0, 0)), field)
  expect(cache.selected).toBe(selected)
  expect(cache.next()).toBeNull()
  expect(cache.report).toMatchObject({
    tiles: 96,
    published: 1,
    cancellations: 0,
  })
  // Camera orientation, lens, output size and exposure cannot invalidate a
  // physical direction field: none is an input accepted by the scheduler.
})

it('rejects canceled work, keeps two completed locations, and recovers one on return', () => {
  const cache = new GalaxyCacheSchedule({ faceSize: 32, tileSize: 16 })
  cache.configure(SUN_POSITION, field)
  finish(cache)
  const first = cache.selected
  const next = UV.translate(SUN_POSITION, vec3(PARSEC, 0, 0))
  cache.configure(next, field)
  expect(cache.selected).toBeNull()
  const canceled = cache.next()!
  cache.configure(UV.translate(next, vec3(PARSEC, 0, 0)), field)
  expect(cache.complete(canceled)).toBe(false)
  finish(cache)
  expect(cache.selected).not.toBe(first)
  cache.configure(SUN_POSITION, field)
  expect(cache.selected).toBe(first)
  expect(cache.report.cancellations).toBe(1)
})

it('invalidates by field identity and never publishes an inactive or retired request', () => {
  const cache = new GalaxyCacheSchedule({ faceSize: 32, tileSize: 16 })
  cache.configure(SUN_POSITION, field)
  finish(cache)
  cache.configure(SUN_POSITION, createGalaxyField(field.seed, { dustScale: 0 }))
  expect(cache.selected).toBeNull()
  const canceled = cache.next()!
  cache.configure(null, field)
  expect(cache.complete(canceled)).toBe(false)
  cache.configure(SUN_POSITION, field)
  const retired = cache.next()!
  cache.dispose()
  expect(cache.complete(retired)).toBe(false)
  cache.configure(SUN_POSITION, field)
  expect(cache.next()).toBeNull()
  expect(cache.selected).toBeNull()
})

it('covers every texel exactly once without exceeding the tile budget', () => {
  for (const faceSize of [32, 128, 512, 1024]) {
    const cache = new GalaxyCacheSchedule({ faceSize, tileSize: 32 })
    cache.configure(SUN_POSITION, field)
    const covered = new Uint8Array(6 * faceSize ** 2)
    for (let tile = cache.next(); tile !== null; tile = cache.next()) {
      for (let y = tile.y; y < tile.y + tile.height; y++)
        for (let x = tile.x; x < tile.x + tile.width; x++)
          covered[tile.face * faceSize ** 2 + y * faceSize + x]!++
      cache.complete(tile)
    }
    expect(covered.every((count) => count === 1)).toBe(true)
  }
  expect(() => new GalaxyCacheSchedule({ faceSize: 0 })).toThrow()
  expect(() => new GalaxyCacheSchedule({ tileSize: 2048 })).toThrow()
})

it('publishes a complete coarse sky while the final cube continues in the spare slot', () => {
  const cache = new GalaxyCacheSchedule({
    faceSize: 128,
    tileSize: 16,
    initialFaceSize: 32,
  })
  cache.configure(SUN_POSITION, field)
  for (let i = 0; i < 24; i++) cache.complete(cache.next()!)
  const coarse = cache.selected
  expect(coarse?.faceSize).toBe(32)
  // Repeated camera frames keep the coarse cube selected and the refinement
  // alive, including while the observer drifts inside the validity budget.
  for (let i = 0; i < 384; i++) {
    cache.configure(UV.translate(SUN_POSITION, vec3(i * 1000, 0, 0)), field)
    expect(cache.selected).toBe(coarse)
    cache.complete(cache.next()!)
  }
  expect(cache.selected?.faceSize).toBe(128)
  expect(cache.report).toMatchObject({
    tiles: 408,
    published: 2,
    pending: false,
  })
  expect(cache.next()).toBeNull()
})

it('publishes a complete middle tier before the final tier', () => {
  const schedule = new GalaxyCacheSchedule({
    initialFaceSize: 32,
    refinements: [128],
    faceSize: 512,
    tileSize: 32,
  })
  const field = createGalaxyField(rootSeed('inertialref'))
  schedule.configure(SUN_POSITION, field)
  for (const size of [32, 128, 512]) {
    const count = 6 * (size / 32) ** 2
    for (let i = 0; i < count; i++)
      expect(schedule.complete(schedule.next()!)).toBe(true)
    expect(schedule.selected?.faceSize).toBe(size)
  }
  expect(schedule.next()).toBe(null)
  expect(schedule.report.tiles).toBe(6 + 96 + 1536)
  schedule.dispose()
})

it('retires completed and pending light when the resolved selection changes', () => {
  const cache = new GalaxyCacheSchedule({ faceSize: 32, tileSize: 16 })
  const first = {
    origin: SUN_POSITION,
    apparentMagnitudeLimit: 8,
    levelMask: 511,
  }
  cache.configure(SUN_POSITION, field, first)
  finish(cache)
  cache.configure(SUN_POSITION, field, { ...first, levelMask: 3 })
  expect(cache.selected).toBeNull()
  const canceled = cache.next()!
  cache.configure(SUN_POSITION, field, first)
  expect(cache.complete(canceled)).toBe(false)
  finish(cache)
  cache.configure(SUN_POSITION, field, first)
  expect(cache.selected).not.toBeNull()
  expect(cache.next()).toBeNull()
})

it('publishes an archived cube only into its still-current request', () => {
  const cache = new GalaxyCacheSchedule({
    initialFaceSize: 16,
    faceSize: 32,
    tileSize: 8,
  })
  cache.configure(SUN_POSITION, field)
  const request = cache.next()!
  expect(cache.restore(request, SUN_POSITION, 32)).toBe(true)
  expect(cache.selected?.faceSize).toBe(32)
  expect(cache.next()).toBeNull()
  expect(cache.complete(request)).toBe(false)
  cache.configure(UV.translate(SUN_POSITION, vec3(PARSEC, 0, 0)), field)
  const canceled = cache.next()!
  cache.configure(SUN_POSITION, field)
  expect(cache.restore(canceled, canceled.position, 32)).toBe(false)
  cache.dispose()
  expect(cache.restore(request, SUN_POSITION, 32)).toBe(false)
})

it('keeps the reduced eye allowance of a restored source partition', () => {
  const cache = new GalaxyCacheSchedule({ faceSize: 32 })
  const at = (pc: number) => UV.translate(SUN_POSITION, vec3(pc * PARSEC, 0, 0))
  cache.configure(at(0.07), field)
  expect(cache.restore(cache.next()!, SUN_POSITION, 32, 0.08)).toBe(true)
  cache.configure(at(0.079), field)
  expect(cache.selected).not.toBeNull()
  cache.configure(at(0.081), field)
  expect(cache.selected).toBeNull()
  cache.configure(at(0.07), field)
  expect(cache.selected).not.toBeNull()
  cache.dispose()
})
