import { afterAll, beforeAll, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { int, uniformArray, uv, vec3, vec4 } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, vec3 as spatialVec3 } from '@inertialref/spatial'
import {
  createGalaxyField,
  integrateStarExtinction,
  integrateGalaxyRay,
  LOCAL_CLOUDS,
  SUN_POSITION,
} from '@inertialref/universe'
import { createStarExtinction, starExtinctionOrigin } from './starExtinction.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(16, 1)
})
afterAll(() => gpu.dispose())

it('holds source-bounded dust columns to CPU quadrature and fine transport', async () => {
  const cloud = LOCAL_CLOUDS.find((c) => c.name === 'Aquila Rift')!
  const ray = new Vector3(
    cloud.center.x + 8178,
    cloud.center.y - 20.8,
    cloud.center.z,
  ).normalize()
  const origins = [
    SUN_POSITION,
    SUN_POSITION,
    SUN_POSITION,
    SUN_POSITION,
    SUN_POSITION,
    UV.fromMeters(0, 30000 * PARSEC, 0),
    UV.fromMeters(-8178 * PARSEC, 30000 * PARSEC, 0),
  ]
  const displacements = [
    new Vector3(0, 0, 0),
    ray.clone().multiplyScalar(100),
    ray.clone().multiplyScalar(1000),
    new Vector3(8178, 0, 0),
    new Vector3(0, 20000, 0),
    new Vector3(0, -30000, 0),
    new Vector3(0, -40000, 0),
  ]
  const os = uniformArray<'vec3'>(origins.map(starExtinctionOrigin), 'vec3')
  const ds = uniformArray<'vec3'>(displacements, 'vec3')
  const index = int(uv().x.mul(origins.length))
  const field = createGalaxyField(rootSeed('inertialref'))
  const extinction = createStarExtinction(field)
  const graph = vec4(extinction.along(os.element(index), ds.element(index)), 1)
  const result = await gpu.drawGraph(graph, {
    width: origins.length,
    height: 1,
    float: true,
  })
  origins.forEach((origin, i) => {
    const displacement = displacements[i]!
    const offset = spatialVec3(
      displacement.x * PARSEC,
      displacement.y * PARSEC,
      displacement.z * PARSEC,
    )
    const expected = integrateStarExtinction(
      field,
      origin,
      UV.translate(origin, offset),
    )
    expected.transmittanceRgb.forEach((t, c) =>
      expect(Math.abs(result.at(i, 0)[c]! - t)).toBeLessThan(
        Math.max(1e-4, t * 0.01),
      ),
    )
    if (displacement.length() > 0) {
      const reference = integrateGalaxyRay(field, origin, offset, {
        distanceParsecs: displacement.length(),
        maxStepParsecs: 0.25,
      })
      reference.transmittanceRgb.forEach((t, c) =>
        expect(Math.abs(result.at(i, 0)[c]! - t)).toBeLessThan(
          Math.max(0.001, t * 0.01),
        ),
      )
    }
  })
  expect(result.at(1, 0)[1]).toBeGreaterThan(0.98)
  expect(result.at(2, 0)[0]).toBeGreaterThan(result.at(2, 0)[1])
  expect(result.at(2, 0)[1]).toBeGreaterThan(result.at(2, 0)[2])
  expect(result.at(2, 0)[1]).toBeLessThan(0.2)
  expect(result.at(3, 0)[0]).toBeLessThan(1e-9)
  extinction.setField(
    createGalaxyField(rootSeed('inertialref'), { dustScale: 0 }),
  )
  const clear = await gpu.drawGraph(graph, {
    width: origins.length,
    height: 1,
    float: true,
  })
  for (let i = 0; i < origins.length; i++)
    expect(clear.at(i, 0).slice(0, 3)).toEqual([1, 1, 1])
})

it('keeps a sub-parsec ray finite at a distant origin and rejects a zero optical path', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const extinction = createStarExtinction(field)
  const zero = await gpu.drawGraph(
    vec4(
      extinction.transmittance(vec3(-8178, 20.8, 0), vec3(-8178, 20.8, 0)),
      1,
    ),
    { width: 1, height: 1, float: true },
  )
  expect(zero.at(0, 0)).toEqual([1, 1, 1, 1])
  const tiny = await gpu.drawGraph(
    vec4(extinction.along(vec3(-8178, 20.8, 0), vec3(0.001, 0.001, 0.001)), 1),
    { width: 1, height: 1, float: true },
  )
  for (const t of tiny.at(0, 0).slice(0, 3)) {
    expect(t).toBeGreaterThan(0.999)
    expect(t).toBeLessThanOrEqual(1)
  }
})
