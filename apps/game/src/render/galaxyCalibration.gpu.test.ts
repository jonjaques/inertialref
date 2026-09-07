import { afterAll, beforeAll, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { int, uniformArray, uv, vec3 } from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import {
  createGalaxyField,
  galaxySkyDirections,
  galaxyVMagnitude,
  integrateGalaxyRay,
  SKY_REGION_REFERENCES,
  SUN_POSITION,
} from '@inertialref/universe'
import { createGalaxyKernel } from './galaxyKernel.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => gpu?.dispose())

it('holds linear GPU sky regions to their CPU integrals and the supported V targets', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const kernel = createGalaxyKernel(field)
  for (const region of SKY_REGION_REFERENCES) {
    const rays = galaxySkyDirections(region)
    const directions = uniformArray<'vec3'>(
      rays.map((d) => new Vector3(d.x, d.y, d.z)),
      'vec3',
    )
    const pixels = await gpu.drawGraph(
      kernel.integrate(
        vec3(-8178, 20.8, 0),
        directions.element(int(uv().x.mul(rays.length))),
        60000,
        'settled',
      ),
      { width: rays.length, height: 1, float: true },
    )
    let actual = 0,
      expected = 0
    rays.forEach((d, i) => {
      const cpu = integrateGalaxyRay(field, SUN_POSITION, d, {
        sampling: 'settled',
      }).radianceNanowatts
      const v = pixels.at(i, 0)[1]
      expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(v / cpu - 1)).toBeLessThan(0.01)
      actual += v / rays.length
      expected += cpu / rays.length
    })
    expect(
      Math.abs(galaxyVMagnitude(actual) - galaxyVMagnitude(expected)),
    ).toBeLessThan(0.01)
    expect(
      Math.abs(galaxyVMagnitude(actual) - galaxyVMagnitude(region.vNanowatts)),
    ).toBeLessThan(0.3)
  }
})
