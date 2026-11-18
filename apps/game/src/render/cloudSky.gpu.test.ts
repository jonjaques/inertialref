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
import {
  float,
  Fn,
  If,
  instanceIndex,
  max,
  saturate,
  storage,
  uint,
  vec3,
} from 'three/tsl'
import {
  bakeMultipleScattering,
  bakeTransmittance,
  type HazeAuthoring,
  MULTI_SCATTER_FLOOR,
  marchSkyMoments,
  SKY_BLOCK_COLUMNS,
  SKY_BLOCK_GUARD,
  SKY_TABLE_HEIGHT,
  SKY_TABLE_WIDTH,
  type SkyTable,
  type SkyTableMoments,
  skyMomentsAt,
  skyRowAt,
  skyRowsOf,
} from '@inertialref/rendering'
import { SOLAR_PLANETS } from '@inertialref/universe'
import { skyTableAt } from './air.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import type { CloudSample } from './cloudNodes.ts'
import { createCloudSky } from './cloudSky.ts'
import { type CloudBodyUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The sky table's node on the GPU, in a compute kernel as the march reads
 * it, held to `skyMomentsAt` on the same half-float texels: the node's
 * addressing, its rows, its guards, its logarithm and its alphas are the
 * CPU reader's, and the
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
const scattering = scatteringFor(
  haze,
  1 + haze.height / earth.radius,
  {
    rayleigh: earth.atmosphere!.scaleHeight / earth.radius,
    aerosol: haze.aerosolHeight / earth.radius,
  },
  { sky: true },
)

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

/**
 * The cornerstones' world (`g:milky-way/s:P222_3_2_k/b:3`): its authored
 * haze, radius and `airHeights`, as the page derives them, and its
 * cumulus level from `regimeWeather(P222_3_2_k IV, 'fair-cumulus')`.
 */
const WORLD_RADIUS = 3_922_146.955680374
const worldHaze: HazeAuthoring = {
  color: { r: 0.28, g: 0.48, b: 0.95 },
  limb: { r: 0.86, g: 0.45, b: 0.26 },
  thickness: 1,
  aerosolAngstrom: 1.3,
  ozone: 0,
}
const world = scatteringFor(
  worldHaze,
  1.02,
  { rayleigh: 0.002698194357920808, aerosol: 0.0003777472101089132 },
  { sky: true },
)

/** An air the test reads: its tables and the datum its heights stand on. */
interface TestAir {
  readonly scattering: typeof scattering
  readonly radius: number
}
const EARTH: TestAir = { scattering, radius: earth.radius }
const WORLD: TestAir = { scattering: world, radius: WORLD_RADIUS }

/**
 * A half-float texture's texels as the Float32 table the CPU reader takes,
 * on the rows the air's recipe places, as the bake and the uniform do.
 */
function tableOf(map: Texture, at: TestAir = EARTH): SkyTable {
  const image = map.image as {
    readonly data: Uint16Array
    readonly width: number
    readonly height: number
  }
  return {
    width: image.width,
    height: image.height,
    data: Float32Array.from(image.data, (h) => DataUtils.fromHalfFloat(h)),
    rows: skyRowsOf(at.scattering.recipe),
  }
}

/** The served body's uniforms on an air's datum, its air bound to `sky`. */
function bodyOn(at: TestAir, sky: Texture | undefined): CloudBodyUniforms {
  const body = createCloudUniforms().served
  body.datumRadius.value = at.radius
  body.air.bind({
    recipe: at.scattering.recipe,
    transmittance: at.scattering.transmittance,
    multiScatter: at.scattering.multiScatter,
    ...(sky === undefined ? {} : { sky }),
  })
  return body
}

const earthBody = (sky: Texture | undefined) => bodyOn(EARTH, sky)

/** Numbers a case writes: the mean's three bands, Δ's, Δ_s's, then c's. */
const OUT = 12

/** The node at each (altitude, sun cosine) pair, in a compute kernel. */
async function sampled(
  body: CloudBodyUniforms,
  cases: readonly (readonly [number, number])[],
): Promise<Float32Array> {
  const count = cases.length
  const input = new StorageBufferAttribute(new Float32Array(cases.flat()), 1)
  const output = new StorageBufferAttribute(new Float32Array(count * OUT), 1)
  const from = storage(input, 'float', count * 2)
  const into = storage(output, 'float', count * OUT)
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
      // The cloud's node hands on three moments; c is `skyTableAt`'s
      // fourth, read here at the share the node forms.
      const share = saturate(
        max(sample.altitude, 0)
          .div(body.datumRadius)
          .div(max(body.air.top.sub(1), 1e-6)),
      )
      const { upper } = skyTableAt(body.air, sample.sunMu, share)
      const to = instanceIndex.mul(OUT)
      ;[read.mean, read.up, read.sunward, upper].forEach((term, block) => {
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
function heightShare(altitude: number, at: TestAir = EARTH): number {
  const height = f32(f32(Math.max(altitude, 0)) / f32(at.radius))
  const ceiling = f32(f32(at.scattering.recipe.topRatio) - 1)
  return Math.min(Math.max(f32(height / ceiling), 0), 1)
}

/**
 * The largest difference among the texels a read at (height share, sun
 * cosine) blends in one block and channel: what a weight's rounding can
 * move the read by. The row coordinate is the CPU's in float64; the node's
 * in float32 differs by about 1e-6 of a row, which the bound's 2⁻⁸ of the
 * spread holds many times over.
 */
function spread(
  table: SkyTable,
  block: number,
  channel: number,
  share: number,
  mu: number,
): number {
  const x = Math.min(Math.max((mu + 1) / 2, 0), 1) * (SKY_BLOCK_COLUMNS - 1)
  const y = skyRowAt(table.rows, share) * (table.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const values: number[] = []
  for (const column of [x0, Math.min(x0 + 1, SKY_BLOCK_COLUMNS - 1)])
    for (const row of [y0, Math.min(y0 + 1, table.height - 1)]) {
      const texel =
        block * (SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD) +
        SKY_BLOCK_GUARD +
        column
      values.push(table.data[(row * table.width + texel) * 4 + channel]!)
    }
  return Math.max(...values) - Math.min(...values)
}

/** The worst error over every case, block and band, as a share of its bound. */
function worst(
  table: SkyTable,
  cases: readonly (readonly [number, number])[],
  out: Float32Array,
  at: TestAir = EARTH,
): number {
  let ratio = 0
  cases.forEach(([altitude, mu], k) => {
    const share = heightShare(altitude, at)
    const expected = skyMomentsAt(table, share, f32(mu))
    // The mean is held in its logarithm, the value the table blends.
    const read = (term: number) =>
      [0, 1, 2].map((c) => out[k * OUT + term * 3 + c]!)
    const gpu = [read(0).map(Math.log), read(1), read(2), read(3)]
    const cpu = [
      expected.mean.map(Math.log),
      expected.up,
      expected.sunward,
      expected.upper,
    ]
    for (let term = 0; term < 4; term += 1)
      for (let band = 0; band < 3; band += 1) {
        const value = cpu[term]![band]!
        // c is band k's in block k's alpha.
        const [block, channel] = term < 3 ? [term, band] : [band, 3]
        const bound =
          spread(table, block, channel, share, mu) / 256 +
          2 * 2 ** -10 * Math.abs(value) +
          1e-6
        ratio = Math.max(ratio, Math.abs(gpu[term]![band]! - value) / bound)
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
        for (let c = 0; c < 4; c += 1)
          data[(y * SKY_TABLE_WIDTH + x) * 4 + c] = guard
            ? 50
            : -1 - block + column / 64 + c / 8
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
      for (let k = 0; k < cases.length; k += 1) {
        for (let block = 0; block < 3; block += 1)
          for (let c = 0; c < 3; c += 1) {
            const value = out[k * OUT + block * 3 + c]!
            const read = block === 0 ? Math.log(value) : value
            expect(read).toBeGreaterThan(-1 - block - 0.01)
            expect(read).toBeLessThan(-block + 0.5)
          }
        // The alphas, block k's as band k's c: −1 − k + 3/8 and up.
        for (let block = 0; block < 3; block += 1) {
          const value = out[k * OUT + 9 + block]!
          expect(value).toBeGreaterThan(-1 - block + 0.375 - 0.01)
          expect(value).toBeLessThan(-block + 0.5)
        }
      }
    } finally {
      map.dispose()
    }
  })

  it('holds every cloud height within 3% of the quadrature on two airs, through the node', async () => {
    /*
     * The bar of ruling 007 on the device: the node's read at each cloud
     * height and sun, against `marchSkyMoments` at that height in float64,
     * as the worst band of the mean and of the four sides the trace forms.
     * The Node suite holds `skyMomentsAt` to it at 2.6% on Earth and 2.2%
     * on the world; the device adds the half floats and the sampler.
     */
    const airs = [
      { at: EARTH, clouds: [700, 1000, 1700, 2400, 3400, 6000, 8100, 11_100] },
      { at: WORLD, clouds: [1000, 1700, 2400] },
    ] as const
    const misses: string[] = []
    let worstError = 0
    for (const { at, clouds } of airs) {
      const cases: [number, number][] = []
      for (const height of clouds)
        for (const elevation of [15, 30, 50, 65])
          cases.push([f32(height), f32(Math.sin((elevation * Math.PI) / 180))])
      const out = await sampled(bodyOn(at, at.scattering.sky), cases)
      const { recipe } = at.scattering
      const transmittance = bakeTransmittance(recipe)
      const multiScatter = bakeMultipleScattering(recipe, transmittance)
      cases.forEach(([height, mu], k) => {
        const exact = marchSkyMoments(
          { recipe, transmittance, multiScatter },
          1 + height / at.radius,
          mu,
        )
        const read = (term: number) =>
          [0, 1, 2].map((c) => out[k * OUT + term * 3 + c]!)
        const error = rowError(read(0), read(1), read(2), exact)
        worstError = Math.max(worstError, error)
        if (!(error <= 0.03))
          misses.push(
            `${height} m, μ ${mu.toFixed(3)}: ${(100 * error).toFixed(1)}%`,
          )
      })
    }
    expect(misses).toEqual([])
    expect(worstError).toBeGreaterThan(0)
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
        expect(out[k * OUT + c]! / MULTI_SCATTER_FLOOR).toBeCloseTo(1, 1)
        expect(out[k * OUT + 3 + c]).toBe(0)
        expect(out[k * OUT + 6 + c]).toBe(0)
        expect(out[k * OUT + 9 + c]).toBe(0)
      }
  })
})

/**
 * The irradiance on each side of a horizontal and a vertical face under the
 * sky the trace draws, `L̄·max(0, 1 + ¾(Δ·ω_z + Δ_s·ω_x))`, by a midpoint
 * rule: above, below, sunward, away. `skyIrradiance.test.ts` scores the CPU
 * read the same way.
 */
function traceSides(mean: number, up: number, sunward: number): number[] {
  const rings = 48
  const arcs = 96
  const sides = [0, 0, 0, 0]
  const weight = (2 / rings) * ((2 * Math.PI) / arcs)
  for (let i = 0; i < rings; i += 1) {
    const z = -1 + ((i + 0.5) / rings) * 2
    const ring = Math.sqrt(1 - z * z)
    for (let j = 0; j < arcs; j += 1) {
      const x = Math.cos(((j + 0.5) / arcs) * 2 * Math.PI) * ring
      const light =
        mean * Math.max(0, 1 + 0.75 * (up * z + sunward * x)) * weight
      sides[z > 0 ? 0 : 1]! += light * Math.abs(z)
      sides[x > 0 ? 2 : 3]! += light * Math.abs(x)
    }
  }
  return sides
}

/** The worst band of the mean and the four sides, as a share of the quadrature's. */
function rowError(
  mean: readonly number[],
  up: readonly number[],
  sunward: readonly number[],
  exact: SkyTableMoments,
): number {
  let worst = 0
  for (let c = 0; c < 3; c += 1) {
    worst = Math.max(worst, Math.abs(mean[c]! / exact.mean[c]! - 1))
    const got = traceSides(mean[c]!, up[c]!, sunward[c]!)
    const want = traceSides(exact.mean[c]!, exact.up[c]!, exact.sunward[c]!)
    for (let k = 0; k < 4; k += 1)
      worst = Math.max(worst, Math.abs(got[k]! / want[k]! - 1))
  }
  return worst
}
