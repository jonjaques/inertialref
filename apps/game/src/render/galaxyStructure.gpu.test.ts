import { afterAll, beforeAll, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { int, uniformArray, uv, vec3, vec4 } from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import { createGalaxyField } from '@inertialref/universe'
import { createGalaxyKernel } from './galaxyKernel.ts'
import { GalaxyStructureTable } from './galaxyStructure.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(12, 1)
})
afterAll(() => gpu.dispose())

it('keeps interpolated structure rays within one percent of the analytic field', async () => {
  const table = new GalaxyStructureTable(2048)
  const field = createGalaxyField(rootSeed('inertialref'))
  try {
    await table.warm(gpu.renderer)
    expect(table.ready).toBe(true)
    const exact = createGalaxyKernel(field)
    const cached = createGalaxyKernel(field, {
      structure: (p) => table.sample(p),
    })
    const directions = uniformArray<'vec3'>(
      [
        new Vector3(1, 0, 0),
        new Vector3(1, 0.02, 0.3),
        new Vector3(1, 0.2, 0.1),
        new Vector3(0, 1, 0),
        new Vector3(-1, 0.01, 0.3),
        new Vector3(0, 0, 1),
        new Vector3(0, -1, 0),
        new Vector3(0.4, -1, 0.2),
        new Vector3(-0.4, -1, 0.2),
        new Vector3(0, 0, -1),
        new Vector3(0.2, 0.02, -1),
        new Vector3(-0.2, -0.03, -1),
      ],
      'vec3',
    ).element(int(uv().x.mul(12)))
    for (const origin of [
      vec3(-8178, 20.8, 0),
      vec3(0, 30000, 0),
      vec3(0, 50, 40000),
    ]) {
      const a = exact.integrate(
        origin,
        directions,
        100000,
        'settled',
        100,
        0.002,
      ).rgb
      const b = cached.integrate(
        origin,
        directions,
        100000,
        'settled',
        100,
        0.002,
      ).rgb
      const result = await gpu.drawGraph(
        vec4(a.sub(b).abs().div(a.max(1e-8)), 1),
        { float: true, width: 12, height: 1 },
      )
      for (let x = 0; x < 12; x++)
        for (const error of result.at(x, 0).slice(0, 3))
          expect(error).toBeLessThan(0.01)
    }
  } finally {
    table.dispose()
  }
  expect(table.ready).toBe(false)
  expect(table.bytes).toBe(0)
})
