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
