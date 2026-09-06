import { afterAll, beforeAll, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { int, uniformArray, uv, vec4 } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, vec3 } from '@inertialref/spatial'
import { createGalaxyField, integrateGalaxyRay } from '@inertialref/universe'
import { createGalaxyKernel } from './galaxyKernel.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => gpu.dispose())

function within(actual: number, expected: number, absolute = 1e-7) {
  expect(Number.isFinite(actual)).toBe(true)
  expect(actual).toBeGreaterThanOrEqual(0)
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    Math.max(absolute, Math.abs(expected) * 0.01),
  )
}

it('holds the seeded dust lattice to the CPU across seeds, negative cells and the rim', async () => {
  const points = Array.from(
    { length: 192 },
    (_, i) =>
      new Vector3(
        ((i * 7919) % 60000) - 30000 + 0.127,
        ((i * 151) % 600) - 300 + 0.031,
        ((i * 3571) % 60000) - 30000 + 0.719,
      ),
  )
  points.push(
    new Vector3(-8178, 20.8, 0),
    new Vector3(0, 0, 0),
    new Vector3(30001, 0, 0),
  )
  const positions = uniformArray<'vec3'>(points, 'vec3')
  const kernel = createGalaxyKernel(createGalaxyField(rootSeed('inertialref')))
  const graph = vec4(
    kernel.extinction(positions.element(int(uv().x.mul(points.length)))),
    1,
  )
  let previous: number[] | undefined
  for (const seed of ['inertialref', 'dust-clouds', 'inertialref']) {
    const field = createGalaxyField(rootSeed(seed))
    kernel.setField(field)
    const pixels = await gpu.drawGraph(graph, {
      width: points.length,
      height: 1,
      float: true,
    })
    const result: number[] = []
    points.forEach((p, i) => {
      const k = field.sample(
        UV.fromMeters(p.x * PARSEC, p.y * PARSEC, p.z * PARSEC),
      ).extinctionPerParsec
      const actual = pixels.at(i, 0)
      ;[k.r, k.g, k.b].forEach((value, c) => within(actual[c]!, value, 1e-10))
      result.push(...actual)
    })
    if (previous === undefined) previous = result
    else if (seed === 'inertialref') expect(result).toEqual(previous)
    else expect(result).not.toEqual(previous)
  }
})

it('matches transported radiance and transmittance on complete, clipped, empty and settled rays', async () => {
  const rays = [
    [-8178, 20.8, 0, 1, 0, 0],
    [-8178, 20.8, 0, -1, 0, 0],
    [-8178, 20.8, 0, 0, 1, 0],
    [-7900, 1000, 0, 1, -0.1, 0.1],
    [3000, -20, 1000, -1, 0.01, 0.2],
    [0, 30000, 0, 0, -1, 0],
    [0, 0, 40000, 0, 0, -1],
    [8000, 30, 40000, 0, 0, -1],
    [4000, 1200, 40000, 0, 0, -1],
    [0, 9500, 40000, 0, 0, -1],
    [-24000, 600, 3000, 0.5, -0.05, -1],
    [0, 30000, 0, 1, 0, 0],
  ]
  const origins = uniformArray<'vec3'>(
    rays.map((r) => new Vector3(r[0], r[1], r[2])),
    'vec3',
  )
  const directions = uniformArray<'vec3'>(
    rays.map((r) => new Vector3(r[3], r[4], r[5])),
    'vec3',
  )
  const index = int(uv().x.mul(rays.length))
  // The last case is the live volume's texel angle at a 240×135 target
  // under the edge-on lens, which filters the dust texture and floors the
  // settled intervals; the port has to agree with the CPU there too.
  const cases: [number, number][] = [
    [0, 0],
    [100, 0],
    [100000, 0],
    [100000, 0.0071],
  ]
  for (const dustScale of [0, 1, 2]) {
    const field = createGalaxyField(rootSeed('inertialref'), { dustScale })
    const kernel = createGalaxyKernel(field)
    for (const [distance, pixelAngle] of cases) {
      const light = await gpu.drawGraph(
        kernel.integrate(
          origins.element(index),
          directions.element(index),
          distance,
          'settled',
          100,
          pixelAngle,
        ),
        { width: rays.length, height: 1, float: true },
      )
      const transmission = await gpu.drawGraph(
        vec4(
          kernel.transmittance(
            origins.element(index),
            directions.element(index),
            distance,
            'settled',
            100,
            pixelAngle,
          ),
          1,
        ),
        { width: rays.length, height: 1, float: true },
      )
      rays.forEach((r, i) => {
        const cpu = integrateGalaxyRay(
          field,
          UV.fromMeters(r[0]! * PARSEC, r[1]! * PARSEC, r[2]! * PARSEC),
          vec3(r[3]!, r[4]!, r[5]!),
          {
            distanceParsecs: distance,
            sampling: 'settled',
            maxStepParsecs: 100,
            pixelAngle,
          },
        )
        expect(cpu.samples).toBeLessThan(16384)
        if (cpu.rgbNanowatts[0] > 0)
          expect(
            light.at(i, 0)[0],
            `dust=${dustScale}, distance=${distance}, pixel=${pixelAngle}, ray=${i}`,
          ).toBeGreaterThan(0)
        ;[...cpu.rgbNanowatts, cpu.starsPerSquareParsec].forEach((v, c) =>
          within(light.at(i, 0)[c]!, v, 1e-5),
        )
        cpu.transmittanceRgb.forEach((v, c) => {
          within(transmission.at(i, 0)[c]!, v)
          expect(transmission.at(i, 0)[c]).toBeLessThanOrEqual(1)
        })
      })
    }
  }
})

it('converges on a short structured cloud ray as both CPU and GPU intervals shrink', async () => {
  const field = createGalaxyField(rootSeed('dust-clouds'))
  const kernel = createGalaxyKernel(field)
  const origin = new Vector3(-8000.17, 12.31, 45.29)
  const direction = new Vector3(1, 0.05, -0.2)
  const origins = uniformArray<'vec3'>([origin], 'vec3')
  const directions = uniformArray<'vec3'>([direction], 'vec3')
  const reference = integrateGalaxyRay(
    field,
    UV.fromMeters(origin.x * PARSEC, origin.y * PARSEC, origin.z * PARSEC),
    vec3(direction.x, direction.y, direction.z),
    { distanceParsecs: 128, maxStepParsecs: 0.25, sampling: 'observer' },
  )
  const errors = []
  for (const step of [10, 1, 0.5]) {
    const pixels = await gpu.drawGraph(
      kernel.integrate(
        origins.element(0),
        directions.element(0),
        128,
        'observer',
        step,
      ),
      { width: 1, height: 1, float: true },
    )
    errors.push(
      Math.max(
        ...reference.rgbNanowatts.map((v, c) =>
          Math.abs(pixels.at(0, 0)[c]! / v - 1),
        ),
      ),
    )
  }
  expect(errors[2]).toBeLessThan(errors[0]!)
  expect(errors[2]).toBeLessThan(0.001)
})
