import { afterAll, beforeAll, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { int, uniformArray, uv, vec3 } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, vec3 as v3 } from '@inertialref/spatial'
import {
  createGalaxyField,
  integrateGalaxyRay,
  SUN_POSITION,
} from '@inertialref/universe'
import { createGalaxyKernel } from './galaxyKernel.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'
let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(5, 1)
})
afterAll(() => gpu?.dispose())
it('uses the actual selection origin and magnitude bands for diffuse transport', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const kernel = createGalaxyKernel(field)
  const directions = [
    v3(1, 0, 0),
    v3(1, 0.1, 0.3),
    v3(0, 1, 0),
    v3(-1, 0.1, 0.2),
    v3(0, 0.05, 1),
  ]
  const d = uniformArray<'vec3'>(
    directions.map((p) => new Vector3(p.x, p.y, p.z)),
    'vec3',
  ).element(int(uv().x.mul(5)))
  for (const levelMask of [511, 3, 0]) {
    const resolved = {
      origin: UV.translate(SUN_POSITION, v3(20 * PARSEC, 0, 0)),
      apparentMagnitudeLimit: 8,
      levelMask,
    }
    kernel.setResolved(resolved)
    const pixels = await gpu.drawGraph(
      kernel.integrate(vec3(-8178, 20.8, 0), d),
      { float: true, width: 5, height: 1 },
    )
    for (let i = 0; i < 5; i++) {
      const expected = integrateGalaxyRay(field, SUN_POSITION, directions[i]!, {
        sampling: 'observer',
        resolved,
      }).rgbNanowatts
      for (const [c, v] of expected.entries())
        expect(Math.abs(pixels.at(i, 0)[c]! / v - 1)).toBeLessThan(0.01)
    }
  }
})

it('keeps cached partitioned rays within one percent when eye and envelope share the reuse budget', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const old = createGalaxyKernel(field),
    moved = createGalaxyKernel(field)
  old.setResolved({
    origin: SUN_POSITION,
    apparentMagnitudeLimit: 8,
    levelMask: 511,
  })
  moved.setResolved({
    origin: UV.translate(SUN_POSITION, v3(0, 0.07 * PARSEC, 0)),
    apparentMagnitudeLimit: 8,
    levelMask: 511,
  })
  const directions = uniformArray<'vec3'>(
    [
      new Vector3(1, 0, 0),
      new Vector3(1, 0.03, 0.6),
      new Vector3(0, 1, 0),
      new Vector3(-1, 0.1, 0.2),
      new Vector3(0, 0.05, 1),
    ],
    'vec3',
  ).element(int(uv().x.mul(5)))
  const a = old.integrate(vec3(-8178, 20.8, 0), directions).rgb
  const b = moved.integrate(vec3(-8178 + 0.07, 20.8, 0), directions).rgb
  const pixels = await gpu.drawGraph(a.sub(b).abs().div(b.max(1e-8)), {
    float: true,
    width: 5,
    height: 1,
  })
  for (let x = 0; x < 5; x++)
    for (const error of pixels.at(x, 0).slice(0, 3))
      expect(error).toBeLessThan(0.01)
})
