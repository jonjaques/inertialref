import { afterAll, beforeAll, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { int, uniformArray, uv, vec3, vec4 } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, vec3 as spatialVec3 } from '@inertialref/spatial'
import { createGalaxyField, SUN_POSITION } from '@inertialref/universe'
import { GalaxySkyCache, GALAXY_RADIANCE_UNIT } from './galaxySkyCache.ts'
import { createGalaxyKernel, GALAXY_MAX_STEP_PARSECS } from './galaxyKernel.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(12, 1)
})
afterAll(() => gpu.dispose())

it.each([SUN_POSITION, UV.fromMeters(0, 12000 * PARSEC, 0)])(
  'stores the same physical rays on all six cube faces at %j',
  async (position) => {
    const field = createGalaxyField(rootSeed('inertialref'))
    const cache = new GalaxySkyCache(field, { faceSize: 16, tileSize: 8 })
    cache.configure(position, field)
    try {
      await cache.warm(gpu.renderer)
      // Off-center texel directions detect mirrored and swapped cube faces.
      const a = -0.4375,
        b = 0.3125
      const directions = [
        [1, -b, -a],
        [-1, -b, a],
        [a, 1, b],
        [a, -1, -b],
        [a, -b, 1],
        [-a, -b, -1],
        [1, -a, -b],
        [-1, -a, b],
        [b, 1, a],
        [b, -1, -a],
        [b, -a, 1],
        [-b, -a, -1],
      ].map(([x, y, z]) => new Vector3(x, y, z))
      const d = uniformArray<'vec3'>(directions, 'vec3').element(
        int(uv().x.mul(12)),
      )
      const p = UV.approxMeters(position)
      const live = createGalaxyKernel(field)
        .integrate(
          vec3(p.x / PARSEC, p.y / PARSEC, p.z / PARSEC),
          d,
          100000,
          'settled',
          GALAXY_MAX_STEP_PARSECS,
          cache.pixelAngle,
        )
        .rgb.div(GALAXY_RADIANCE_UNIT)
      for (let i = 0; i < cache.schedule.totalTiles; i++)
        expect(cache.advance(gpu.renderer)).toBe(true)
      expect(cache.available).toBe(true)
      const difference = await gpu.drawGraph(
        vec4(cache.sample(d).rgb.sub(live).abs().div(live.max(1e-10)), 1),
        { float: true, width: 12, height: 1 },
      )
      for (let x = 0; x < 12; x++)
        for (const error of difference.at(x, 0).slice(0, 3))
          expect(error).toBeLessThan(0.01)
      const translated = UV.translate(
        position,
        spatialVec3(0.14 * PARSEC, 0, 0),
      )
      cache.configure(translated, field)
      expect(cache.available).toBe(true)
      const shifted = createGalaxyKernel(field)
        .integrate(
          vec3(p.x / PARSEC + 0.14, p.y / PARSEC, p.z / PARSEC),
          d,
          100000,
          'settled',
          GALAXY_MAX_STEP_PARSECS,
          cache.pixelAngle,
        )
        .rgb.div(GALAXY_RADIANCE_UNIT)
      const drift = await gpu.drawGraph(
        vec4(cache.sample(d).rgb.sub(shifted).abs().div(shifted.max(1e-10)), 1),
        { float: true, width: 12, height: 1 },
      )
      for (let x = 0; x < 12; x++)
        for (const error of drift.at(x, 0).slice(0, 3))
          expect(error).toBeLessThan(0.01)
      expect(cache.diagnostics).toMatchObject({
        ready: true,
        tiles: 24,
        published: 1,
      })
    } finally {
      cache.dispose()
    }
  },
)
