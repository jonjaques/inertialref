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
