import { afterAll, beforeAll, expect, it } from 'vitest'
import { uint, uv, vec4 } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 } from '@inertialref/spatial'
import { rootSeed } from '@inertialref/procedural'
import {
  createGalaxyField,
  integrateStarExtinction,
  LOCAL_CLOUDS,
  SUN_POSITION,
} from '@inertialref/universe'
import {
  StarExtinctionCache,
  type StarExtinctionSelection,
} from './starExtinctionCache.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'
let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(4, 1)
})
afterAll(() => gpu.dispose())

it('retains physical columns through travel and blends each finite refresh without hiding established sources', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const cloud = LOCAL_CLOUDS.find((c) => c.name === 'Aquila Rift')!
  const length = Math.hypot(
    cloud.center.x + 8178,
    cloud.center.y - 20.8,
    cloud.center.z,
  )
  const direction = vec3(
    (cloud.center.x + 8178) / length,
    (cloud.center.y - 20.8) / length,
    cloud.center.z / length,
  )
  const at = (pc: number) =>
    UV.translate(
      SUN_POSITION,
      vec3(
        direction.x * pc * PARSEC,
        direction.y * pc * PARSEC,
        direction.z * pc * PARSEC,
      ),
    )
  const initial: StarExtinctionSelection = {
    ids: ['catalogue', 'procedural', 'foreground', 'coincident'],
    positions: [at(1000), at(1000), at(100), SUN_POSITION],
    catalogued: [true, false, false, true],
  }
  const cache = new StarExtinctionCache(4, field, { batchSize: 1 })
  const draw = (count: number) =>
    gpu.drawGraph(vec4(cache.sample(uint(uv().x.mul(count))), 1), {
      width: count,
      height: 1,
      float: true,
    })
  try {
    cache.configure(initial, SUN_POSITION)
    await cache.warm(gpu.renderer)
    const unwritten = await draw(4)
    expect(unwritten.at(0, 0).slice(0, 3)).toEqual([1, 1, 1])
    expect(unwritten.at(3, 0).slice(0, 3)).toEqual([1, 1, 1])
    for (const i of [1, 2])
      expect(unwritten.at(i, 0).slice(0, 3)).toEqual([0, 0, 0])
    expect(cache.advance(gpu.renderer)).toBe(true)
    const first = await draw(4)
    expect(first.at(0, 0)[1]).toBe(1)
    expect(first.at(1, 0)[1]).toBeLessThan(0.03)
    expect(first.at(2, 0).slice(0, 3)).toEqual([0, 0, 0])
    for (let i = 0; i < 7; i++) cache.advance(gpu.renderer)
    const ready = await draw(4)
    expect(ready.at(0, 0).slice(0, 3)).toEqual([1, 1, 1])
    expect(ready.at(3, 0).slice(0, 3)).toEqual([1, 1, 1])
    expect(ready.at(1, 0)[1]).toBeLessThan(0.2)
    expect(ready.at(2, 0)[1]).toBeGreaterThan(0.98)
    const reordered: StarExtinctionSelection = {
      ids: ['procedural', 'catalogue'],
      positions: [initial.positions[1]!, initial.positions[0]!],
      catalogued: [false, true],
    }
    cache.configure(reordered, SUN_POSITION)
    expect(cache.diagnostics.pending).toBe(0)
    const reorderedLight = await draw(2)
    expect(reorderedLight.at(0, 0)).toEqual(ready.at(1, 0))
    expect(reorderedLight.at(1, 0)).toEqual(ready.at(0, 0))
    const moved = at(250)
    cache.configure(reordered, moved)
    const retained = await draw(2)
    expect(retained.at(0, 0)).toEqual(reorderedLight.at(0, 0))
    expect(retained.at(1, 0)).toEqual(reorderedLight.at(1, 0))
    cache.advance(gpu.renderer)
    const intermediate = await draw(2)
    expect(intermediate.at(0, 0)[1]).toBeGreaterThan(retained.at(0, 0)[1])
    expect(intermediate.at(1, 0).slice(0, 3)).toEqual([1, 1, 1])
    const generation = cache.schedule.generation
    cache.configure(reordered, at(300))
    expect(cache.schedule.generation).toBe(generation)
    cache.advance(gpu.renderer)
    expect(cache.diagnostics.pending).toBe(0)
    for (let i = 0; i < 7; i++) cache.advance(gpu.renderer)
    const corrected = await draw(2)
    const current = integrateStarExtinction(
      field,
      moved,
      at(1000),
    ).opticalDepthRgb
    const reference = integrateStarExtinction(
      field,
      SUN_POSITION,
      at(1000),
    ).opticalDepthRgb
    for (let c = 0; c < 3; c++) {
      expect(corrected.at(0, 0)[c]).toBeCloseTo(Math.exp(-current[c]!), 3)
      expect(corrected.at(1, 0)[c]).toBeCloseTo(
        Math.exp(reference[c]! - current[c]!),
        2,
      )
    }
    cache.configure(reordered, null)
    const inactive = await draw(2)
    expect(inactive.at(0, 0).slice(0, 3)).toEqual([0, 0, 0])
    expect(inactive.at(1, 0).slice(0, 3)).toEqual([0, 0, 0])
    cache.configure(
      reordered,
      moved,
      createGalaxyField(rootSeed('inertialref'), { dustScale: 0 }),
    )
    for (let i = 0; i < 7; i++) cache.advance(gpu.renderer)
    const clear = await draw(2)
    for (let i = 0; i < 2; i++)
      expect(clear.at(i, 0).slice(0, 3)).toEqual([1, 1, 1])
  } finally {
    cache.dispose()
  }
  expect(cache.diagnostics.bytes).toBe(0)
  expect(cache.advance(gpu.renderer)).toBe(false)
})
