import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  StorageBufferAttribute,
  type Texture,
} from 'three/webgpu'
import { float, Fn, If, instanceIndex, storage, uint, vec3 } from 'three/tsl'
import {
  MULTI_SCATTER_FLOOR,
  SKY_BLOCK_COLUMNS,
  SKY_BLOCK_GUARD,
  SKY_TABLE_HEIGHT,
  SKY_TABLE_WIDTH,
  type ScatteringLut,
  skyMomentsAt,
} from '@inertialref/rendering'
import { SOLAR_PLANETS } from '@inertialref/universe'
import { scatteringFor } from './atmosphereLuts.ts'
import type { CloudSample } from './cloudNodes.ts'
import { createCloudSky } from './cloudSky.ts'
import { type CloudBodyUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The sky table's node on the GPU, in a compute kernel as the march reads
 * it, held to `skyMomentsAt` on the same half-float texels: the node's
 * addressing, its guards and its logarithm are the CPU reader's, and the
 * Node suite holds the CPU reader to the quadrature it summed
 * (`skyIrradiance.test.ts`).
 *
 * What is left between the two is the sampler's own filtering, which
 * interpolates in a fixed-point weight (Metal's is 8 bits) and filters a
 * half-float texture in half floats: a bound of the blended texels' spread
 * over 2⁸ and two half-float steps of the value, as the droplet phase's
 * test takes it (`cloudLight.gpu.test.ts`).
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu()
})

afterAll(() => {
  gpu.dispose()
})

const f32 = Math.fround
const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')!
const haze = earth.haze!
const scattering = scatteringFor(haze, 1 + haze.height / earth.radius, {
  rayleigh: earth.atmosphere!.scaleHeight / earth.radius,
  aerosol: haze.aerosolHeight / earth.radius,
})

/** A seeded uniform draw, so a failure reproduces. */
function draws(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A half-float texture's texels as the Float32 table the CPU reader takes. */
function tableOf(map: Texture): ScatteringLut {
  const image = map.image as {
    readonly data: Uint16Array
    readonly width: number
    readonly height: number
  }
  return {
    width: image.width,
    height: image.height,
    data: Float32Array.from(image.data, (h) => DataUtils.fromHalfFloat(h)),
  }
}

/** The served body's uniforms on Earth's datum, its air bound to `sky`. */
function earthBody(sky: Texture | undefined): CloudBodyUniforms {
  const body = createCloudUniforms().served
  body.datumRadius.value = earth.radius
  body.air.bind({
    recipe: scattering.recipe,
    transmittance: scattering.transmittance,
    multiScatter: scattering.multiScatter,
    ...(sky === undefined ? {} : { sky }),
  })
  return body
}

/**
 * The node at each (altitude, sun cosine) pair, in a compute kernel: the
 * mean's three bands, then Δ's, then Δ_s's.
 */
async function sampled(
  body: CloudBodyUniforms,
  cases: readonly (readonly [number, number])[],
): Promise<Float32Array> {
  const count = cases.length
  const input = new StorageBufferAttribute(new Float32Array(cases.flat()), 1)
  const output = new StorageBufferAttribute(new Float32Array(count * 9), 1)
  const from = storage(input, 'float', count * 2)
  const into = storage(output, 'float', count * 9)
  const sky = createCloudSky()
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const at = instanceIndex.mul(2)
      const sample: CloudSample = {
        offset: vec3(0),
        distance: float(0),
        altitude: from.element(at),
        sunMu: from.element(at.add(1)),
        footprint: float(1),
      }
      const read = sky.at(sample, body)
      const to = instanceIndex.mul(9)
      ;[read.mean, read.up, read.sunward].forEach((term, block) => {
        into.element(to.add(block * 3)).assign(term.x)
        into.element(to.add(block * 3 + 1)).assign(term.y)
        into.element(to.add(block * 3 + 2)).assign(term.z)
      })
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

/** The sample's height as a share of the air's, in float32 as the node forms it. */
function heightShare(altitude: number): number {
  const height = f32(f32(Math.max(altitude, 0)) / f32(earth.radius))
  const ceiling = f32(f32(scattering.recipe.topRatio) - 1)
  return Math.min(Math.max(f32(height / ceiling), 0), 1)
}

/**
 * The largest difference among the texels a read at (height share, sun
 * cosine) blends in one block and band: what a weight's rounding can move
 * the read by.
 */
function spread(
  table: ScatteringLut,
  block: number,
  band: number,
  share: number,
  mu: number,
): number {
  const x = Math.min(Math.max((mu + 1) / 2, 0), 1) * (SKY_BLOCK_COLUMNS - 1)
  const y = share * (table.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const values: number[] = []
  for (const column of [x0, Math.min(x0 + 1, SKY_BLOCK_COLUMNS - 1)])
    for (const row of [y0, Math.min(y0 + 1, table.height - 1)]) {
      const texel =
        block * (SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD) +
        SKY_BLOCK_GUARD +
        column
      values.push(table.data[(row * table.width + texel) * 4 + band]!)
    }
  return Math.max(...values) - Math.min(...values)
}

/** The worst error over every case, block and band, as a share of its bound. */
function worst(
  table: ScatteringLut,
  cases: readonly (readonly [number, number])[],
  out: Float32Array,
): number {
  let ratio = 0
  cases.forEach(([altitude, mu], k) => {
    const share = heightShare(altitude)
    const expected = skyMomentsAt(table, share, f32(mu))
    // The mean is held in its logarithm, the value the table blends.
    const gpu = [
      [0, 1, 2].map((c) => Math.log(out[k * 9 + c]!)),
      [3, 4, 5].map((c) => out[k * 9 + c]!),
      [6, 7, 8].map((c) => out[k * 9 + c]!),
    ]
    const cpu = [expected.mean.map(Math.log), expected.up, expected.sunward]
    for (let block = 0; block < 3; block += 1)
      for (let band = 0; band < 3; band += 1) {
        const value = cpu[block]![band]!
        const bound =
          spread(table, block, band, share, mu) / 256 +
          2 * 2 ** -10 * Math.abs(value) +
          1e-6
        ratio = Math.max(ratio, Math.abs(gpu[block]![band]! - value) / bound)
      }
  })
  return ratio
}

describe('the sky’s node', () => {
  it('equals the table at 100 samples, through the air and over its top', async () => {
    const next = draws(41)
    const top = (scattering.recipe.topRatio - 1) * earth.radius
    const cases: [number, number][] = []
    for (let i = 0; i < 100; i += 1) {
      // Mostly where clouds stand, some to the air's top and past it, and
      // the sun's whole range with both ends.
      const altitude =
        i < 60 ? 20_000 * next() : i < 90 ? top * next() : top * (1 + next())
      const mu = i % 25 === 0 ? 1 : i % 25 === 1 ? -1 : 2 * next() - 1
      cases.push([f32(altitude), f32(mu)])
    }
    const out = await sampled(earthBody(scattering.sky), cases)
    expect(worst(tableOf(scattering.sky!), cases, out)).toBeLessThanOrEqual(1)
  })

  it('never blends two blocks, even at both ends of the sun’s range', async () => {
    /*
     * A table whose guards hold 50 and whose blocks hold values of their
     * own, distinct per block and column: a read that reached a guard or
     * the next block would carry a share of 50 or of another block's
     * values. The cosines are both ends of the range, a step inside each,
     * and the middle.
     */
    const data = new Float32Array(SKY_TABLE_WIDTH * SKY_TABLE_HEIGHT * 4)
    for (let y = 0; y < SKY_TABLE_HEIGHT; y += 1)
      for (let x = 0; x < SKY_TABLE_WIDTH; x += 1) {
        const block = Math.floor(x / (SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD))
        const column = (x % (SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD)) - 1
        const guard = column < 0 || column >= SKY_BLOCK_COLUMNS
        for (let c = 0; c < 3; c += 1)
          data[(y * SKY_TABLE_WIDTH + x) * 4 + c] = guard
            ? 50
            : -1 - block + column / 64 + c / 8
        data[(y * SKY_TABLE_WIDTH + x) * 4 + 3] = 1
      }
    const half = Uint16Array.from(data, (v) => DataUtils.toHalfFloat(v))
    const map = new DataTexture(
      half,
      SKY_TABLE_WIDTH,
      SKY_TABLE_HEIGHT,
      RGBAFormat,
      HalfFloatType,
    )
    map.magFilter = LinearFilter
    map.minFilter = LinearFilter
    map.needsUpdate = true
    try {
      const cases: [number, number][] = []
      for (const mu of [-1, -0.999, 1, 0.999, 0])
        for (const altitude of [0, 7000]) cases.push([altitude, mu])
      const out = await sampled(earthBody(map), cases)
      expect(worst(tableOf(map), cases, out)).toBeLessThanOrEqual(1)
      // And outright: nothing read reaches a guard's 50, or the logarithm
      // of the mean's block, whose values stand between −1 and 0.
      for (let k = 0; k < cases.length; k += 1)
        for (let block = 0; block < 3; block += 1)
          for (let c = 0; c < 3; c += 1) {
            const value = out[k * 9 + block * 3 + c]!
            const read = block === 0 ? Math.log(value) : value
            expect(read).toBeGreaterThan(-1 - block - 0.01)
            expect(read).toBeLessThan(-block + 0.5)
          }
    } finally {
      map.dispose()
    }
  })

  it('reads no sky from a body whose table has not arrived', async () => {
    const cases: [number, number][] = [
      [0, 1],
      [3000, 0.2],
      [90_000, -1],
    ]
    const out = await sampled(earthBody(undefined), cases)
    for (let k = 0; k < cases.length; k += 1)
      for (let c = 0; c < 3; c += 1) {
        // ln of the floor, −69.08, is −69.06 in a half float.
        expect(out[k * 9 + c]! / MULTI_SCATTER_FLOOR).toBeCloseTo(1, 1)
        expect(out[k * 9 + 3 + c]).toBe(0)
        expect(out[k * 9 + 6 + c]).toBe(0)
      }
  })
})
