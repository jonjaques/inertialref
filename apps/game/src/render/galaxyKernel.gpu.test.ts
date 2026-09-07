import { afterAll, beforeAll, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { int, uniformArray, uv } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, vec3 } from '@inertialref/spatial'
import {
  armRadius,
  createGalaxyField,
  GALAXY_ARMS,
  galaxyWarp,
  integrateGalaxyRay,
} from '@inertialref/universe'
import { createGalaxyKernel } from './galaxyKernel.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => gpu.dispose())

function within(actual: number, expected: number, absolute: number) {
  expect(Number.isFinite(actual)).toBe(true)
  expect(actual).toBeGreaterThanOrEqual(0)
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    Math.max(absolute, Math.abs(expected) * 0.01),
  )
}

it.each(['inertialref', 'another-galaxy'])(
  'matches nonzero CPU emission and density, including the arm kinks: %s',
  async (seed) => {
    const field = createGalaxyField(rootSeed(seed))
    const kernel = createGalaxyKernel(field)
    const points = [
      new Vector3(0, 0, 0),
      new Vector3(-8178, 20.8, 0),
      new Vector3(22000, 4000, -10000),
      new Vector3(31000, 0, 0),
      new Vector3(-12000.123, -214.6, 3300.234),
    ]
    for (const z of [29900, 24000, 15000, 10000, 9500, -15000])
      points.push(new Vector3(0, 0, z))
    for (const sign of [-1, 1])
      for (const epsilon of [-0.001, 0, 0.001]) {
        points.push(new Vector3(sign * 15000, 50, epsilon))
        points.push(new Vector3(epsilon, 50, sign * 15000))
      }
    // The extrapolated winding and its Hermite join are outside the measured kinks.
    for (const degrees of [-450, -240.001, -239.999, -170, -100.001, -99.999]) {
      const beta = (degrees * Math.PI) / 180
      const radius = armRadius(GALAXY_ARMS[1]!, beta)
      points.push(
        new Vector3(
          -radius * Math.cos(beta),
          galaxyWarp(radius, beta),
          -radius * Math.sin(beta),
        ),
      )
    }
    for (const arm of GALAXY_ARMS) {
      for (const offset of [-1.001, -0.001, 0.001, 1.001]) {
        const beta = ((arm.kinkDegrees + offset) * Math.PI) / 180
        const radius = armRadius(arm, beta) + 150
        points.push(
          new Vector3(
            -radius * Math.cos(beta),
            galaxyWarp(radius, beta) + 9,
            -radius * Math.sin(beta),
          ),
        )
      }
    }
    const positions = uniformArray<'vec3'>(points, 'vec3')
    const structurePixels = await gpu.drawGraph(
      kernel.structure(positions.element(int(uv().x.mul(points.length)))),
      { width: points.length, height: 1, float: true },
    )
    const graph = kernel.sample(
      positions.element(int(uv().x.mul(points.length))),
    )
    const pixels = await gpu.drawGraph(graph, {
      width: points.length,
      height: 1,
      float: true,
    })
    points.forEach((p, i) => {
      const expected = field.sample(
        UV.fromMeters(p.x * PARSEC, p.y * PARSEC, p.z * PARSEC),
      )
      const actual = pixels.at(i, 0)
      const values = [
        expected.emissionRgb.r,
        expected.emissionRgb.g,
        expected.emissionRgb.b,
        expected.totalPerCubicParsec,
      ]
      values.forEach((v, j) => within(actual[j]!, v, 1e-8))
      const structure = structurePixels.at(i, 0)
      within(structure[0], expected.armStrength, 1e-6)
      expect(Math.abs(structure[1] - expected.warpParsecs)).toBeLessThan(
        Math.max(0.005, Math.abs(expected.warpParsecs) * 0.01),
      )
    })
  },
)

it('matches complete CPU rays, clipped paths, misses, and faint halo light', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const kernel = createGalaxyKernel(field)
  const rays = [
    [0, 30000, 0, 0, -1, 0],
    [-3000, 30000, -1000, 0, -1, 0],
    [-12000, 30000, 4000, 0, -1, 0],
    [0, 0, 40000, 0, 0, -1],
    [8000, 30, 40000, 0, 0, -1],
    [4000, 1200, 40000, 0, 0, -1],
    [0, 9500, 40000, 0, 0, -1],
    [0, 30000, 0, 1, 0, 0],
    [0, 30000, 0, 0, 1, 0],
    [0, 30000, 0, 0.35, -1, -0.2],
    [-8178, 20.8, 0, 1, 0, -0.1],
  ]
  const origins = uniformArray<'vec3'>(
    rays.map((r) => new Vector3(r[0], r[1], r[2])),
  )
  const directions = uniformArray<'vec3'>(
    rays.map((r) => new Vector3(r[3], r[4], r[5])),
    'vec3',
  )
  const index = int(uv().x.mul(rays.length))
  for (const distance of [100000, 30500, 0]) {
    const pixels = await gpu.drawGraph(
      kernel.integrate(
        origins.element(index),
        directions.element(index),
        distance,
      ),
      { width: rays.length, height: 1, float: true },
    )
    rays.forEach((r, i) => {
      const expected = integrateGalaxyRay(
        field,
        UV.fromMeters(r[0]! * PARSEC, r[1]! * PARSEC, r[2]! * PARSEC),
        vec3(r[3]!, r[4]!, r[5]!),
        { distanceParsecs: distance },
      )
      const values = [...expected.rgbNanowatts, expected.starsPerSquareParsec]
      values.forEach((v, j) => within(pixels.at(i, 0)[j]!, v, 1e-5))
    })
  }
})
