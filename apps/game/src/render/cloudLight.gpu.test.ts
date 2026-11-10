import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DataUtils, type Node, StorageBufferAttribute } from 'three/webgpu'
import {
  dot,
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  length,
  max,
  saturate,
  storage,
  uint,
  uniform,
  vec3,
} from 'three/tsl'
import {
  angleOf,
  type MieTable,
  mieDroplets,
  radiusOf,
  samplePhase,
} from '@inertialref/rendering'
import { SOLAR_PLANETS } from '@inertialref/universe'
import {
  type AirUniforms,
  airMediumAt,
  clearedBeam,
  clearedFromOrbit,
  createAirUniforms,
  crowdedSamples,
  marchAir,
  phasesToward,
  stepShare,
  sunTableAt,
  sunThrough,
  sunThroughAt,
} from './air.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import {
  type CloudSample,
  type CloudSunDepthNodes,
  slabMedium,
} from './cloudNodes.ts'
import { CloudPhase } from './cloudPhase.ts'
import { cloudSunFn } from './cloudSunlight.ts'
import { type CloudBodyUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { altitudeAt } from './cloudGeometry.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { setSceneExposure } from './radiance.ts'

/*
 * The light a cloud sample is lit by (§5.9, §5.10) and the air's pieces the
 * clouds take from `air.ts` (§3.6), on the GPU: the beam a cloud sees is the
 * beam the ground beside it sees, the air's sample is `marchAir`'s sample,
 * the phase read is `samplePhase`'s bilinear lookup, and the taps mix as
 * one segment.
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu()
})

afterAll(() => {
  gpu.dispose()
})

type Read = (k: number) => Node<'float'>
type Write = (k: number, value: Node<'float'>) => void

/** One kernel over `count` cases: `stride` inputs a case, `outputs` floats back. */
async function run(
  count: number,
  inputs: Float32Array,
  stride: number,
  outputs: number,
  body: (read: Read, write: Write) => void,
): Promise<Float32Array> {
  const input = new StorageBufferAttribute(inputs, 1)
  const output = new StorageBufferAttribute(
    new Float32Array(count * outputs),
    1,
  )
  const from = storage(input, 'float', inputs.length)
  const into = storage(output, 'float', count * outputs)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const at = instanceIndex.mul(stride)
      const to = instanceIndex.mul(outputs)
      body(
        (k) => from.element(at.add(k)),
        (k, value) => {
          into.element(to.add(k)).assign(value)
        },
      )
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

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

const f32 = Math.fround

/* ------------------------------------------------------------------------- */
/* The air                                                                    */
/* ------------------------------------------------------------------------- */

const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')!
const haze = earth.haze!

/** Earth's tables over the datum, as `Bodies` bakes them, and air uniforms bound to them. */
function earthAir(): AirUniforms {
  const baked = scatteringFor(haze, 1 + haze.height / earth.radius, {
    rayleigh: earth.atmosphere!.scaleHeight / earth.radius,
    aerosol: haze.aerosolHeight / earth.radius,
  })
  const air = createAirUniforms()
  air.set(baked.recipe, baked.transmittance, baked.multiScatter)
  return air
}

/** float32's unit roundoff: what one operation's rounding is held to. */
const EPSILON = 2 ** -24
/** A half float's step under 1: the tables' storage, and the filter's output. */
const HALF_STEP = 2 ** -11

describe('the beam a cloud sees', () => {
  /*
   * `sunThroughAt` is `sunThrough` with its height and sun cosine handed in:
   * read at the coordinates `sunThrough` forms from the point, the two are
   * one function, the physical beam and the beam Enhanced clears from orbit
   * alike. Read at a height resolved off the CPU, as a cloud's is, they
   * differ by what the coordinates do: the float32 step of
   * `length(point) − 1` at a sea-level radius, 6 × 10⁻⁸, is 4 × 10⁻⁶ of
   * Earth's 100 km of air, and the sampler blends the four texels around a
   * read in a fixed-point weight (8 bits on the suite's Metal device), so a
   * shift that small moves the beam by a weight's step of the texels'
   * spread where it crosses one. The design's 10⁻⁴ is under that step on
   * the table's steepest texels, near the horizon: 9 of 1,536 components
   * exceed it, by up to 2⁻¹⁰.
   */
  const COUNT = 512
  const STRIDE = 8

  function points(top: number): Float32Array {
    const next = draws(11)
    const inputs = new Float32Array(COUNT * STRIDE)
    for (let i = 0; i < COUNT; i += 1) {
      const height = (top - 1) * next() ** 2
      const sunMu = 2 * next() - 1
      const sideways = Math.sqrt(1 - sunMu * sunMu)
      // The point on +Y, the sun tilted toward +X: μ_sun = sun·ŷ.
      inputs.set(
        [0, 1 + height, 0, sideways, sunMu, 0, height / (top - 1), sunMu],
        i * STRIDE,
      )
    }
    return inputs
  }

  /** Both beams at every point: `sunThrough`'s, then `sunThroughAt`'s. */
  async function beams(
    air: AirUniforms,
    inputs: Float32Array,
    resolved: 'shader' | 'cpu',
    enhanced: boolean,
  ): Promise<Float32Array> {
    const pre = 1 / 30_000
    setSceneExposure(
      gpu.renderer,
      pre,
      pre,
      enhanced ? 'enhanced' : 'photographic',
    )
    try {
      return await run(COUNT, inputs, STRIDE, 6, (read, write) => {
        const point = vec3(read(0), read(1), read(2))
        const sun = vec3(read(3), read(4), read(5))
        const radius = length(point)
        const height01 =
          resolved === 'cpu'
            ? read(6)
            : max(radius.sub(1), 0).div(max(air.top.sub(1), 1e-6))
        const muSun =
          resolved === 'cpu' ? read(7) : dot(point, sun).div(max(radius, 1e-5))
        const reference = sunThrough(air, point, sun)
        const at = sunThroughAt(air, height01, muSun, clearedFromOrbit(air))
        write(0, reference.x)
        write(1, reference.y)
        write(2, reference.z)
        write(3, at.x)
        write(4, at.y)
        write(5, at.z)
      })
    } finally {
      setSceneExposure(gpu.renderer, null)
    }
  }

  it('is sunThrough read where sunThrough reads, the physical beam and the cleared one alike', async () => {
    for (const enhanced of [false, true]) {
      const air = earthAir()
      air.lift(enhanced ? 1 : 0, 0.05)
      const out = await beams(
        air,
        points(f32(air.top.value)),
        'shader',
        enhanced,
      )
      for (let i = 0; i < COUNT; i += 1)
        for (let c = 0; c < 3; c += 1)
          expect(out[i * 6 + 3 + c]).toBe(out[i * 6 + c])
    }
  })

  it('and from a height the CPU resolved, within the sampler’s weight step of the texels it blends', async () => {
    const air = earthAir()
    const baked = scatteringFor(haze, 1 + haze.height / earth.radius, {
      rayleigh: earth.atmosphere!.scaleHeight / earth.radius,
      aerosol: haze.aerosolHeight / earth.radius,
    })
    const image = baked.transmittance.image as {
      readonly data: Uint16Array
      readonly width: number
      readonly height: number
    }
    const texel = (x: number, y: number, c: number): number =>
      DataUtils.fromHalfFloat(image.data[(y * image.width + x) * 4 + c]!)
    const inputs = points(f32(air.top.value))
    const out = await beams(air, inputs, 'cpu', false)
    let over = 0
    for (let i = 0; i < COUNT; i += 1) {
      const x = ((inputs[i * STRIDE + 7]! + 1) / 2) * (image.width - 1)
      const y = Math.min(1, inputs[i * STRIDE + 6]!) * (image.height - 1)
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      for (let c = 0; c < 3; c += 1) {
        const blended = [
          texel(x0, y0, c),
          texel(Math.min(x0 + 1, image.width - 1), y0, c),
          texel(x0, Math.min(y0 + 1, image.height - 1), c),
          texel(
            Math.min(x0 + 1, image.width - 1),
            Math.min(y0 + 1, image.height - 1),
            c,
          ),
        ]
        const spread = Math.max(...blended) - Math.min(...blended)
        const error = Math.abs(out[i * 6 + 3 + c]! - out[i * 6 + c]!)
        expect(error).toBeLessThanOrEqual(spread / 256 + HALF_STEP)
        if (error > 1e-4) over += 1
      }
    }
    // Nearly all of them inside the design's 10⁻⁴: the step is the exception.
    expect(over).toBeLessThan(COUNT * 3 * 0.02)
  })

  it('and the cleared beam is not the physical one, so the second case tests the clearing', async () => {
    // At the datum under a 1.1° sun the physical beam is a small share of
    // the overhead light, and the clearing lifts it toward the hue.
    const air = earthAir()
    air.lift(1, 0.05)
    const mu = Math.sin((1.1 * Math.PI) / 180)
    const pre = 1 / 30_000
    const read = async (enhanced: boolean): Promise<number> => {
      setSceneExposure(
        gpu.renderer,
        pre,
        pre,
        enhanced ? 'enhanced' : 'photographic',
      )
      try {
        const out = await run(1, new Float32Array(1), 1, 1, (_, write) => {
          write(
            0,
            sunThroughAt(air, float(0), float(mu), clearedFromOrbit(air)).x,
          )
        })
        return out[0]!
      } finally {
        setSceneExposure(gpu.renderer, null)
      }
    }
    const physical = await read(false)
    const cleared = await read(true)
    expect(cleared).toBeGreaterThan(2 * physical)
  })
})

describe('the air a cloud is seen through', () => {
  /*
   * A march built from `airMediumAt` over `crowdedSamples`, accumulated as
   * `marchAir` accumulates its own, against `marchAir` itself over the same
   * segment: a one-sample march and a four-sample one, from the ground and
   * from orbit, with the beam as read and as Enhanced's clearing reads it.
   * The two are the same operations in the same order, so they agree to
   * float32's rounding of the sum — a few units of 10⁻⁷ of the light.
   */
  interface Segment {
    readonly origin: readonly [number, number, number]
    readonly direction: readonly [number, number, number]
    readonly near: number
    readonly far: number
  }

  const unit = (
    v: readonly [number, number, number],
  ): [number, number, number] => {
    const l = Math.hypot(...v)
    return [v[0] / l, v[1] / l, v[2] / l]
  }

  const SEGMENTS: readonly Segment[] = [
    // From the ground toward the horizon, 30 km of air.
    {
      origin: [0, 1.0000002, 0],
      direction: unit([1, 0.05, 0]),
      near: 0,
      far: 0.0047,
    },
    // Up through the whole column.
    {
      origin: [0, 1.0003, 0],
      direction: unit([0.2, 1, 0.1]),
      near: 0,
      far: 0.016,
    },
    // From orbit down to the ground at a slant: the perigee is the far end.
    {
      origin: [0.3, 1.06, 0],
      direction: unit([-0.3, -0.06, 0.02]),
      near: 0.04,
      far: 0.0601,
    },
    // A limb chord seen from orbit, crowded toward its tangent point.
    {
      origin: [-0.5, 1.008, 0],
      direction: unit([1, 0, 0]),
      near: 0.37,
      far: 0.63,
    },
  ]

  async function compare(samples: number, clear: number): Promise<number> {
    const air = earthAir()
    const strength = uniform(clear)
    const sun = vec3(...unit([0.4, 0.8, 0.3]))
    const count = SEGMENTS.length
    const stride = 8
    const inputs = new Float32Array(count * stride)
    SEGMENTS.forEach((segment, i) => {
      inputs.set(
        [...segment.origin, ...segment.direction, segment.near, segment.far],
        i * stride,
      )
    })
    const out = await run(count, inputs, stride, 12, (read, write) => {
      const origin = vec3(read(0), read(1), read(2))
      const direction = vec3(read(3), read(4), read(5))
      const near = read(6)
      const far = read(7)
      const reference = marchAir(
        air,
        origin,
        direction,
        near,
        far,
        sun,
        samples,
        clear > 0 ? strength : undefined,
      )
      // `marchAir`'s own loop, a sample at a time through `airMediumAt`.
      const phases = phasesToward(direction, sun)
      const shellHeight = max(air.top.sub(1), 1e-6)
      const inscatter = vec3(0).toVar()
      const throughput = vec3(1).toVar()
      crowdedSamples(
        origin,
        direction,
        near,
        far,
        samples,
        (point, stepLength) => {
          const radius = length(point)
          const height = max(radius.sub(1), 0)
          const height01 = saturate(height.div(shellHeight))
          const muSun = dot(point, sun).div(max(radius, 1e-5))
          const sunT = sunTableAt(air, muSun, height01).toVar()
          if (clear > 0)
            If(strength.greaterThan(0), () => {
              sunT.assign(clearedBeam(air, sunT, height01, strength))
            })
          const medium = airMediumAt(air, radius.sub(1), muSun, phases, sunT)
          const stepTau = medium.extinction.mul(stepLength)
          const stepThrough = exp(stepTau.negate()).toVar()
          const stepLight = stepLength.mul(stepShare(stepTau, stepThrough))
          inscatter.addAssign(
            throughput.mul(medium.single.add(medium.multiple)).mul(stepLight),
          )
          throughput.mulAssign(stepThrough)
        },
      )
      const values = [
        reference.inscatter,
        reference.transmittance,
        inscatter,
        throughput,
      ]
      values.forEach((value, k) => {
        write(k * 3, value.x)
        write(k * 3 + 1, value.y)
        write(k * 3 + 2, value.z)
      })
    })
    let worst = 0
    for (let i = 0; i < count; i += 1) {
      const at = (k: number) => out[i * 12 + k]!
      for (let c = 0; c < 6; c += 1) {
        const reference = at(c)
        const built = at(6 + c)
        expect(Number.isFinite(built)).toBe(true)
        worst = Math.max(
          worst,
          Math.abs(built - reference) / Math.max(Math.abs(reference), 1e-6),
        )
      }
    }
    // Not a vacuum: the segments carry light and lose some of the sun.
    expect(out[0]! + out[1]! + out[2]!).toBeGreaterThan(1e-4)
    return worst
  }

  /**
   * A few float32 roundings: the same operations in the same order, which
   * the compiler is free to contract differently in two loops. Measured on
   * the suite's device: 2.3 ε over one sample, and the four-sample marches
   * equal to the bit.
   */
  const MARCH_BOUND = 8 * EPSILON

  it('reproduces marchAir over one sample, with the beam as read and as cleared', async () => {
    expect(await compare(1, 0)).toBeLessThanOrEqual(MARCH_BOUND)
    expect(await compare(1, 0.5)).toBeLessThanOrEqual(MARCH_BOUND)
  })

  it('and over four, accumulated as marchAir accumulates', async () => {
    expect(await compare(4, 0)).toBeLessThanOrEqual(MARCH_BOUND)
    expect(await compare(4, 0.5)).toBeLessThanOrEqual(MARCH_BOUND)
  })
})

/* ------------------------------------------------------------------------- */
/* The phase                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * A table whose every texel differs from its neighbors, on the real angular
 * and radial axes, quantized to half floats as the generated file's are, so
 * the lookup is tested on a table that can tell a wrong texel from a right
 * one. The committed stand-in is isotropic, and any lookup reads it right.
 */
function structuredTable(angles: number, radii: number): MieTable {
  const phase = new Float32Array(angles * radii * 3)
  for (let row = 0; row < radii; row += 1)
    for (let i = 0; i < angles; i += 1)
      for (let band = 0; band < 3; band += 1) {
        // A forward peak over a floor, rippling in angle and moving with the row.
        const theta = angleOf({ angles } as MieTable, i)
        const value =
          0.05 +
          40 * Math.exp(-theta * (8 + row)) +
          0.02 * (1 + Math.sin(0.9 * i + 1.7 * row + band))
        phase[(row * angles + i) * 3 + band] = DataUtils.fromHalfFloat(
          DataUtils.toHalfFloat(value),
        )
      }
  return {
    ...mieDroplets(),
    angles,
    radii,
    phase,
    bulk: Array.from({ length: radii }, () => ({
      extinction: 2,
      albedo: 1,
      asymmetry: 0.85,
    })),
    gloryRed: Array.from({ length: radii }, () => 0),
  }
}

describe('the droplet phase', () => {
  /*
   * 200 angles × 5 radii through `CloudPhase` against `samplePhase` on the
   * same table. The lookup lands on texel centers; what is left is the
   * sampler's own filtering, which interpolates in a fixed-point weight
   * (Metal's is 8 bits) and filters a half-float texture in half floats: a
   * bound of the neighbors' difference over 2⁸ and two half-float steps of
   * the value.
   */
  async function lookups(table: MieTable): Promise<number> {
    const phase = new CloudPhase(table)
    await phase.warm(gpu.renderer)
    const next = draws(23)
    const cases: [number, number][] = []
    const radii = [
      table.radiusMin * 0.8,
      table.radiusMin,
      radiusOf(table, 0.37 * (table.radii - 1)),
      radiusOf(table, (table.radii - 1) * next()),
      table.radiusMax * 1.3,
    ]
    for (let a = 0; a < 200; a += 1) {
      // Both ends of the axis, where its texels are densest, and in between.
      const u = a < 20 ? a / 2000 : a < 40 ? 1 - (a - 20) / 2000 : next()
      const nu = f32(Math.cos(Math.PI * u))
      for (const radius of radii) cases.push([nu, f32(radius)])
    }
    const inputs = new Float32Array(cases.flat())
    const out = await run(cases.length, inputs, 2, 3, (read, write) => {
      const value = phase.droplets(read(0), read(1))
      write(0, value.x)
      write(1, value.y)
      write(2, value.z)
    })
    let worst = 0
    cases.forEach(([nu, radius], k) => {
      const expected = samplePhase(table, nu, radius)
      // The spread of the four texels the read blends, which is what a
      // weight's rounding can move it by.
      const spread = neighborSpread(table, nu, radius)
      for (let band = 0; band < 3; band += 1) {
        const bound = spread / 256 + 2 * 2 ** -10 * Math.abs(expected[band]!)
        const error = Math.abs(out[k * 3 + band]! - expected[band]!)
        worst = Math.max(worst, error / Math.max(bound, 1e-9))
      }
    })
    phase.dispose()
    return worst
  }

  /** The largest difference among the texels a lookup at (ν, r) blends. */
  function neighborSpread(table: MieTable, nu: number, radius: number): number {
    const theta = Math.acos(Math.min(1, Math.max(-1, nu)))
    const c = Math.min(1, Math.max(-1, 1 - (2 * theta) / Math.PI))
    const a = Math.min(
      table.angles - 1,
      Math.max(0, ((table.angles - 1) * Math.acos(c)) / Math.PI),
    )
    const r = Math.min(
      table.radii - 1,
      Math.max(
        0,
        ((table.radii - 1) * Math.log(radius / table.radiusMin)) /
          Math.log(table.radiusMax / table.radiusMin),
      ),
    )
    let low = Infinity
    let high = -Infinity
    for (const row of [
      Math.floor(r),
      Math.min(Math.floor(r) + 1, table.radii - 1),
    ])
      for (const i of [
        Math.floor(a),
        Math.min(Math.floor(a) + 1, table.angles - 1),
      ])
        for (let band = 0; band < 3; band += 1) {
          const v = table.phase[(row * table.angles + i) * 3 + band]!
          low = Math.min(low, v)
          high = Math.max(high, v)
        }
    return high - low
  }

  it('equals samplePhase at 200 angles × 5 radii on a table with structure in every texel', async () => {
    expect(await lookups(structuredTable(1024, 32))).toBeLessThanOrEqual(1)
  })

  it('and on the committed table', async () => {
    expect(await lookups(mieDroplets())).toBeLessThanOrEqual(1)
  })

  it('holds the table at one level, 1024 × 32 RGBA16F of it, once warmed', async () => {
    const phase = new CloudPhase(structuredTable(1024, 32))
    expect(phase.bytes).toBe(0)
    expect(phase.textures()).toEqual([])
    await phase.warm(gpu.renderer)
    expect(phase.bytes).toBe(1024 * 32 * 8)
    const [map] = phase.textures()
    const levels = (
      gpu.renderer.backend as unknown as {
        get(texture: object): { texture: GPUTexture }
      }
    ).get(map!).texture.mipLevelCount
    expect(levels).toBe(1)
    phase.dispose()
    expect(phase.bytes).toBe(0)
  })
})

/* ------------------------------------------------------------------------- */
/* The taps                                                                   */
/* ------------------------------------------------------------------------- */

describe('the sun a cloud sample sees', () => {
  /*
   * A slab under an overhead sun, with a sun depth that answers exactly for
   * it: whatever the tap set, the transmittance to the sun from inside a
   * uniform slab is e^(−σ·(top − h)), because the taps' widths tile the first
   * kilometer and the depth past them is the rest. And a half-clear column
   * crossed by the taps is half clear, not a quarter: the taps are one
   * segment.
   */
  const R = 6_371_000
  const BASE = 1000
  const TOP = 3000

  async function transmittance(
    taps: 0 | 2 | 4,
    sigma: number,
    fraction: number,
    height: number,
  ): Promise<number> {
    const uniforms = createCloudUniforms()
    const body = uniforms.served
    body.datumRadius.value = R
    body.eye.value = height
    body.eyeTerm.value = height * (2 * R + height)
    body.up.value.set(0, 1, 0)
    body.sun.value.set(0, 1, 0)
    body.sunUp.value = 1
    uniforms.trace.lightTaps.value = taps
    const medium = slabMedium([{ base: BASE, top: TOP, sigma, fraction }])
    const depth: CloudSunDepthNodes = {
      depths: (offset) => {
        const toSun = max(float(TOP).sub(altitudeAt(body, offset)), 0).mul(
          sigma,
        )
        return { toSun, whole: toSun, weight: float(1) }
      },
    }
    const sun = cloudSunFn({ uniforms, medium, depth })
    const out = await run(1, new Float32Array(1), 1, 1, (_, write) => {
      const sample: CloudSample = {
        offset: vec3(0),
        distance: float(0),
        altitude: float(height),
        sunMu: float(1),
        footprint: float(10),
      }
      write(
        0,
        sun(sample, medium(sample, body as CloudBodyUniforms), body).cloud,
      )
    })
    return out[0]!
  }

  it('is e^(−σ·(top − h)) through a uniform slab for every tap set', async () => {
    const sigma = 0.002
    const height = 1500
    const expected = Math.exp(-sigma * (TOP - height))
    for (const taps of [0, 2, 4] as const)
      expect(
        Math.abs((await transmittance(taps, sigma, 1, height)) / expected - 1),
      ).toBeLessThan(1e-5)
  })

  it('mixes the taps as one segment: a half-clear column at τ 20 passes half the sun, not a quarter', async () => {
    // σ·1000 m = 20 inside the first kilometer, past which the depth is
    // nothing: the slab's top is the taps' reach.
    const height = TOP - 1000
    const through = await transmittance(2, 0.02, 0.5, height)
    expect(through).toBeCloseTo(0.5 * (1 + Math.exp(-20)) * Math.exp(0), 5)
  })
})
