import { describe, expect, it } from 'vitest'
import { deriveSeed, Rng, rootSeed } from '@inertialref/procedural'
import {
  analyticCumulus,
  angleOf,
  CUMULUS_VIEWS,
  fixtureMedium,
  mediumAt,
  mediumDepth,
  mieDroplets,
  radiusOf,
  SLAB_REFERENCE,
  skyByDirection,
  skyByDirectionOf,
  type TraceMedium,
  traceMedium,
  tracePhase,
  viewRay,
  viewSun,
} from '@inertialref/rendering'
import {
  createTracer,
  estimateOf,
  joinSums,
  type PixelSum,
  slabRay,
  tracePixel,
  type TraceScene,
  type TraceSun,
  uniformSky,
} from './pathTrace.ts'

/*
 * The tracer against what can be written down without it. Every estimate
 * here is a fixed seed's, so a run is the same run every time, and each is
 * held at three of its own standard errors: the bound names the estimate's
 * noise, which is the only looseness there is.
 *
 * A slab is held two ways. To closed forms computed here: one order of
 * scattering in a slab and in the cumulus, the uncollided beam, and the
 * balance of flux at albedo one. And to package R1's adding-doubling on the
 * true medium, at three of its committed rows; the two figures R1 measured
 * of the scaled medium against the true one are `pathTrace.slow.test.ts`'s.
 */

type Triple = readonly [number, number, number]

const TABLE = mieDroplets()
const PHASE = tracePhase(TABLE)
const SEED = rootSeed('pathTrace.test')
/** A table row's own radius, so a slab's phase is one row's and no blend. */
const ROW = 18
const RADIUS = radiusOf(TABLE, ROW)
const DEGREE = Math.PI / 180
const SUN_DISK = 0.265 * DEGREE

const CUMULUS = fixtureMedium(
  analyticCumulus({ size: [40, 32, 40], voxel: 50, sigma: 0.012 }),
)

/**
 * A slab of optical depth `depth`, a kilometer thick and 400 km wide, so a
 * ray through its middle never learns that it has sides.
 */
function slab(depth: number): TraceMedium {
  const size = [4, 8, 4] as const
  const count = size[0] * size[1] * size[2]
  return traceMedium(
    size,
    [100_000, 125, 100_000],
    new Float32Array(count).fill(depth / 1000),
    new Float32Array(count).fill(RADIUS),
  )
}
const SLAB_MIDDLE = [200_000, 500, 200_000] as const

const scene = (
  medium: TraceMedium,
  rest: Partial<Omit<TraceScene, 'medium' | 'phase'>>,
): TraceScene => ({
  medium,
  phase: PHASE,
  sun: null,
  sky: uniformSky(0),
  ground: null,
  orders: Infinity,
  estimator: 'cone',
  ...rest,
})

const unit = (x: number, y: number, z: number): Triple => {
  const length = Math.hypot(x, y, z)
  return [x / length, y / length, z / length]
}

/** A point `distance` back along `direction` from the slab's middle. */
const eyeOn = (direction: Triple, distance = 5000): Triple => [
  SLAB_MIDDLE[0] - direction[0] * distance,
  SLAB_MIDDLE[1] - direction[1] * distance,
  SLAB_MIDDLE[2] - direction[2] * distance,
]

const pointSun = (direction: Triple): TraceSun => ({
  direction,
  irradiance: [1, 1, 1],
  angularRadius: 0,
})

/** Whether an estimate is within three of its standard errors of `expected`. */
function expectWithinThree(sum: PixelSum, expected: number): void {
  const { mean, error } = estimateOf(sum)
  expect(error).toBeGreaterThan(0)
  expect(Math.abs(mean - expected)).toBeLessThan(3 * error)
}

describe('the furnace', () => {
  it('returns the sky from one sample of any pixel, with zero variance', () => {
    const sky = 0.37
    const tracer = createTracer(
      scene(CUMULUS, {
        sky: uniformSky(sky),
        ground: { height: -500, albedo: 1 },
      }),
    )
    for (let py = 0; py < 8; py += 1)
      for (let px = 0; px < 8; px += 1)
        for (let band = 0; band < 3; band += 1) {
          const value = tracer.radiance(
            viewRay(CUMULUS, 8, px, py),
            [0, 0, 1],
            band,
            Rng.fromSeed(deriveSeed(SEED, `furnace:${px}:${py}:${band}`)),
          )
          expect(value).toBe(sky)
        }
    // Not a sky seen past a cloud nothing met: the paths scattered.
    expect(tracer.counts.scatterings).toBeGreaterThan(100)
    expect(tracer.counts.truncated).toBe(0)
  })

  it('leaves the sky seen straight through out on request, and keeps what the cloud scatters', () => {
    // Under a sky of one radiance and no ground every path ends on the sky,
    // so the light the cloud scatters is the sky times the chance a path
    // scatters at all: 1 − e^(−τ) along the eye's line.
    const tracer = createTracer(
      scene(CUMULUS, { sky: uniformSky(1), straight: false }),
    )
    for (const [px, py] of [
      [16, 14],
      [10, 18],
    ] as const) {
      const origin = viewRay(CUMULUS, 32, px, py)
      const depth = mediumDepth(CUMULUS, origin, [0, 0, 1])
      expect(depth).toBeGreaterThan(0.2)
      expectWithinThree(
        tracePixel(tracer, origin, [0, 0, 1], 1, SEED, 0, 2000),
        1 - Math.exp(-depth),
      )
    }
    // A line that misses the cloud has nothing scattered on it.
    expect(
      tracer.radiance([-500, -500, -500], [0, 0, 1], 0, Rng.fromSeed(SEED)),
    ).toBe(0)
  })

  it('is lost by a ground that absorbs: the identity is the walk’s, not the test’s', () => {
    const tracer = createTracer(
      scene(CUMULUS, {
        sky: uniformSky(1),
        ground: { height: -500, albedo: 0.5 },
      }),
    )
    const sum = tracePixel(
      tracer,
      viewRay(CUMULUS, 32, 16, 14),
      [0, 0, 1],
      0,
      SEED,
      0,
      400,
    )
    expect(estimateOf(sum).mean).toBeLessThan(0.95)
  })
})

describe('the two trackers', () => {
  const tracer = createTracer(scene(CUMULUS, { sky: uniformSky(1), orders: 0 }))
  const rays: readonly (readonly [number, number, Triple])[] = [
    [10, 18, [0, 0, 1]],
    [16, 14, unit(0.3, 0.2, 0.93)],
  ]

  it.each(rays)(
    'pass the uncollided beam through pixel (%i, %i) at e^(−τ)',
    (px, py, direction) => {
      const origin = viewRay(CUMULUS, 32, px, py)
      const expected = Math.exp(-mediumDepth(CUMULUS, origin, direction))
      // Delta tracking: a path that meets nothing sees a sky of one.
      expectWithinThree(
        tracePixel(tracer, origin, direction, 0, SEED, 0, 40_000),
        expected,
      )
      // Ratio tracking: the transmittance itself, at a fraction of the noise.
      let sum = 0
      let squares = 0
      const samples = 40_000
      for (let i = 0; i < samples; i += 1) {
        const value = tracer.transmittance(
          origin,
          direction,
          Rng.fromSeed(deriveSeed(SEED, `ratio:${i}`)),
        )
        sum += value
        squares += value * value
      }
      expectWithinThree({ sum, squares, samples }, expected)
    },
  )
})

describe('one order of scattering', () => {
  const sun = unit(0.3, 0.8, 0.2)
  const mu0 = sun[1]

  it.each([0.5, 5])(
    'reflects a slab of depth %f at its closed form',
    (depth) => {
      const tracer = createTracer(
        scene(slab(depth), { sun: pointSun(sun), orders: 1 }),
      )
      const view = unit(-0.4, -0.7, 0.3)
      const mu = -view[1]
      const cosine = sun[0] * view[0] + sun[1] * view[1] + sun[2] * view[2]
      for (let band = 0; band < 3; band += 1) {
        const expected =
          ((tracer.density(RADIUS, band, cosine) * mu0) / (mu0 + mu)) *
          (1 - Math.exp(-depth * (1 / mu0 + 1 / mu)))
        expectWithinThree(
          tracePixel(tracer, eyeOn(view), view, band, SEED, 0, 20_000),
          expected,
        )
      }
    },
  )

  it('transmits a slab’s first order at its closed form', () => {
    const depth = 2
    const tracer = createTracer(
      scene(slab(depth), { sun: pointSun(sun), orders: 1 }),
    )
    const view = unit(0.5, 0.6, -0.2)
    const mu = view[1]
    const cosine = sun[0] * view[0] + sun[1] * view[1] + sun[2] * view[2]
    const expected =
      ((tracer.density(RADIUS, 1, cosine) * mu0) / (mu0 - mu)) *
      (Math.exp(-depth / mu0) - Math.exp(-depth / mu))
    expectWithinThree(
      tracePixel(tracer, eyeOn(view), view, 1, SEED, 0, 20_000),
      expected,
    )
  })

  it.each(['cone', 'disk'] as const)(
    'gives the disk’s own mean a degree from the sun, under %s',
    (estimator) => {
      // Looking up through a thin slab one degree from the center of a sun
      // two degrees in radius: the phase is at its peak and the eye is
      // inside the cone. Under 'cone' the light is a chain's from the eye.
      // Under 'disk' this sun is wider than the droplets' peak, so a walk
      // finds it by itself more often than a drawn point of it is worth,
      // and a wrong weight between the two counts most of the light twice.
      // The real sun's 0.265° gives the walk 3% of it, which no test sees.
      const depth = 0.5
      const radius = 2 * DEGREE
      const center = unit(0.3, 0.8, 0.2)
      const disk: TraceSun = {
        direction: center,
        irradiance: [1, 1, 1],
        angularRadius: radius,
      }
      const tracer = createTracer(
        scene(slab(depth), { sun: disk, orders: 1, estimator }),
      )
      // A view one degree from the center, turned toward the zenith.
      const tilt = DEGREE
      const side = unit(
        -center[0] * center[1],
        1 - center[1] ** 2,
        -center[2] * center[1],
      )
      const view = unit(
        center[0] * Math.cos(tilt) + side[0] * Math.sin(tilt),
        center[1] * Math.cos(tilt) + side[1] * Math.sin(tilt),
        center[2] * Math.cos(tilt) + side[2] * Math.sin(tilt),
      )
      const mu = view[1]
      // The closed form's mean over the disk, on rings of equal solid angle.
      const other = unit(
        center[1] * side[2] - center[2] * side[1],
        center[2] * side[0] - center[0] * side[2],
        center[0] * side[1] - center[1] * side[0],
      )
      let expected = 0
      const rings = 96
      const spokes = 128
      for (let a = 0; a < rings; a += 1)
        for (let b = 0; b < spokes; b += 1) {
          const m = ((a + 0.5) / rings) * 2 * Math.sin(radius / 2) ** 2
          const sine = Math.sqrt(m * (2 - m))
          const azimuth = (2 * Math.PI * (b + 0.5)) / spokes
          const from = unit(
            center[0] * (1 - m) +
              sine *
                (side[0] * Math.cos(azimuth) + other[0] * Math.sin(azimuth)),
            center[1] * (1 - m) +
              sine *
                (side[1] * Math.cos(azimuth) + other[1] * Math.sin(azimuth)),
            center[2] * (1 - m) +
              sine *
                (side[2] * Math.cos(azimuth) + other[2] * Math.sin(azimuth)),
          )
          const cosine =
            from[0] * view[0] + from[1] * view[1] + from[2] * view[2]
          const first =
            Math.abs(from[1] - mu) < 1e-9
              ? (depth / mu) * Math.exp(-depth / mu)
              : (from[1] / (from[1] - mu)) *
                (Math.exp(-depth / from[1]) - Math.exp(-depth / mu))
          expected += tracer.density(RADIUS, 1, cosine) * first
        }
      expected /= rings * spokes
      expectWithinThree(
        tracePixel(tracer, eyeOn(view), view, 1, SEED, 0, 60_000),
        expected,
      )
    },
  )

  it('lights the cumulus as a quadrature of its own field does', () => {
    // First order through a cloud that is no slab: the integral along the
    // eye's ray of σ·p·e^(−τ to the sun)·e^(−τ to the eye), by midpoints.
    const sun = unit(0.5, 0.7, -0.5)
    const tracer = createTracer(
      scene(CUMULUS, { sun: pointSun(sun), orders: 1 }),
    )
    const at = new Float64Array(2)
    for (const [px, py] of [
      [16, 14],
      [11, 17],
    ] as const) {
      const origin = viewRay(CUMULUS, 32, px, py)
      const steps = 4000
      const length = 2200
      const dz = length / steps
      let expected = 0
      let behind = 0
      for (let i = 0; i < steps; i += 1) {
        const z = origin[2] + (i + 0.5) * dz
        mediumAt(
          CUMULUS,
          origin[0] / 50 + 0.5,
          origin[1] / 50 + 0.5,
          z / 50 + 0.5,
          at,
        )
        const sigma = at[0]!
        if (sigma > 0) {
          const toSun = mediumDepth(CUMULUS, [origin[0], origin[1], z], sun)
          expected +=
            sigma *
            tracer.density(at[1]!, 2, sun[2]) *
            Math.exp(-toSun - behind - (sigma * dz) / 2) *
            dz
        }
        behind += sigma * dz
      }
      expectWithinThree(
        tracePixel(tracer, origin, [0, 0, 1], 2, SEED, 0, 30_000),
        expected,
      )
    }
  })
})

/** The disk the oracle's first order reads the phase through, radians. */
const ORACLE_DISK = ((959.63 / 3600) * Math.PI) / 180

describe('a slab against adding-doubling', () => {
  // Package R1's oracle on the true medium, read from its committed table:
  // another method, another phase (the Mie series at the radius itself,
  // where this tracer blends two rows of the half-float table), and the
  // same slab. The bound is R1's own for its Monte Carlo: three standard
  // errors and the half percent its streams converge to.
  const rows: readonly (readonly [
    number,
    number,
    number,
    number,
    number,
    'reflected' | 'transmitted',
    number,
  ])[] = [
    [10, 5, 0.5, 0.6, 90, 'reflected', 1],
    [10, 5, 0.5, 0.8, 45, 'transmitted', 1],
    [16, 10, 0.5, 0.4, 135, 'reflected', 0],
  ]

  it.each(rows)(
    'holds %i µm at depth %i, sun %f, view %f at %i°, %s, band %i',
    (radius, depth, sunMu, viewMu, azimuth, side, band) => {
      const row = SLAB_REFERENCE.rows.find(
        (held) =>
          held.radius === radius &&
          held.depth === depth &&
          held.sunMu === sunMu &&
          held.viewMu === viewMu &&
          held.azimuth === azimuth &&
          held.side === side,
      )!
      const { sun, view } = slabRay(sunMu, viewMu, azimuth, side)
      const count = 4 * 8 * 4
      const medium = traceMedium(
        [4, 8, 4],
        [100_000, 125, 100_000],
        new Float32Array(count).fill(depth / 1000),
        new Float32Array(count).fill(radius),
      )
      const { mean, error } = estimateOf(
        tracePixel(
          createTracer(
            scene(medium, {
              sun: {
                direction: sun,
                irradiance: [1, 1, 1],
                angularRadius: ORACLE_DISK,
              },
            }),
          ),
          eyeOn(view),
          view,
          band,
          SEED,
          0,
          12_000,
        ),
      )
      const truth = row.truth[band]!
      expect(Math.abs(mean - truth)).toBeLessThan(3 * error + 0.005 * truth)
      // An estimate this loose would hold anything: measured at 1.9% to 3.0%.
      expect(error).toBeLessThan(0.04 * truth)
    },
  )
})

describe('every order', () => {
  // 2.9 s in the root suite on this Mac mini (Apple M6), four workers;
  // CI's hosted runner is 2.1 to 3.9 times slower, up to 11 s. Five times that.
  it('balances a conservative slab’s flux: what it reflects and passes is what fell on it', () => {
    // Depth 16, where nothing leaves unscattered and what does has
    // scattered dozens of times: a walk that lost or made light at any
    // order shows here. A thin slab would test the test instead. Its
    // transmitted flux is the aureole's, which a cosine-drawn view looks
    // into once in a thousand, and at depth 8 that still left the two
    // fluxes over 4% uncertain together from 90,000 views.
    const depth = 16
    const sun = unit(0.3, 0.8, 0.2)
    const tracer = createTracer(
      scene(slab(depth), {
        sun: { direction: sun, irradiance: [1, 1, 1], angularRadius: SUN_DISK },
      }),
    )
    // A flux is π times the mean radiance over cosine-drawn views.
    const flux = (up: boolean, samples: number): PixelSum => {
      let sum = 0
      let squares = 0
      for (let i = 0; i < samples; i += 1) {
        const rng = Rng.fromSeed(deriveSeed(SEED, `flux:${up}:${i}`))
        const lift = rng.next()
        const azimuth = 2 * Math.PI * rng.next()
        const flat = Math.sqrt(1 - lift)
        const view: Triple = [
          flat * Math.cos(azimuth),
          (up ? -1 : 1) * Math.sqrt(lift),
          flat * Math.sin(azimuth),
        ]
        const value = Math.PI * tracer.radiance(eyeOn(view), view, 0, rng)
        sum += value
        squares += value * value
      }
      return { sum, squares, samples }
    }
    const reflected = estimateOf(flux(true, 10_000))
    const passed = estimateOf(flux(false, 10_000))
    const direct = sun[1] * Math.exp(-depth / sun[1])
    const error = Math.hypot(reflected.error, passed.error)
    expect(
      Math.abs(reflected.mean + passed.mean + direct - sun[1]),
    ).toBeLessThan(3 * error)
    // The estimate's own noise, measured at 1.4% of the flux that fell.
    expect(error).toBeLessThan(0.025 * sun[1])
    expect(tracer.counts.truncated).toBe(0)
  }, 60_000)

  it('finds one radiance by both estimators where the phase has no peak to tell them apart', () => {
    // Henyey–Greenstein at g = 0.8 in the table's own layout: smooth enough
    // that the disk-weighed estimator converges, so the split of paths by
    // their run inside the cone is held to it at a percent.
    const g = 0.8
    const smooth = tracePhase({
      ...TABLE,
      phase: TABLE.phase.map((_, index) => {
        const cosine = Math.cos(
          angleOf(TABLE, Math.floor(index / 3) % TABLE.angles),
        )
        return (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * cosine) ** 1.5)
      }),
    })
    const sun = unit(0.3, 0.8, 0.2)
    const view = unit(0.35, -0.75, 0.2)
    const estimates = (['cone', 'disk'] as const).map((estimator) =>
      estimateOf(
        tracePixel(
          createTracer({
            ...scene(slab(4), {
              sun: {
                direction: sun,
                irradiance: [1, 1, 1],
                angularRadius: SUN_DISK,
              },
              estimator,
            }),
            phase: smooth,
          }),
          eyeOn(view),
          view,
          0,
          SEED,
          0,
          40_000,
        ),
      ),
    )
    const [cone, disk] = estimates as [
      (typeof estimates)[0],
      (typeof estimates)[0],
    ]
    const error = Math.hypot(cone.error, disk.error)
    expect(Math.abs(cone.mean - disk.mean)).toBeLessThan(3 * error)
    // Measured at 2.5% of the radiance, the two errors together.
    expect(error).toBeLessThan(0.04 * cone.mean)
  })

  it('holds a cumulus pixel to under 15% of its radiance in 4,096 samples', () => {
    // The reason the cone exists. Measured at 10⁶ and 2 × 10⁵ samples the
    // variance a sample is 3.76 under 'disk' against 0.019 here, an error
    // fourteen times smaller. The disk-weighed estimator's own error at
    // 4,096 samples cannot stand in a bound: it is missing the rare terms
    // that make it. So the bound is this estimator's alone, measured at
    // 8.1%.
    const sun: TraceSun = {
      direction: viewSun(CUMULUS_VIEWS[1]!),
      irradiance: [1, 1, 1],
      angularRadius: SUN_DISK,
    }
    const { mean, error } = estimateOf(
      tracePixel(
        createTracer(scene(CUMULUS, { sun })),
        viewRay(CUMULUS, 32, 10, 18),
        [0, 0, 1],
        0,
        SEED,
        0,
        4096,
      ),
    )
    expect(error).toBeLessThan(0.15 * mean)
  })

  // What the scaled medium is put together from: `orders: 1` and `first: 2`
  // split a slab's light with nothing left over or counted twice, each from
  // its own seeds. Seen from above first order is the walk's own; looking
  // up through a thin slab two degrees from the sun it is a chain's from
  // the eye, which is the other place an order is counted, and most of the
  // light there.
  const sunAbove = unit(0.3, 0.8, 0.2)
  it.each([
    ['from above', unit(-0.4, -0.7, 0.3), 5, 0.05, 0.2],
    ['two degrees from the sun', unit(0.3, 0.89, 0.2), 0.5, 0.3, 0.95],
  ] as const)(
    'is its first order and the orders past it, traced apart, %s',
    (label, view, depth, least, most) => {
      const sun: TraceSun = {
        direction: sunAbove,
        irradiance: [1, 1, 1],
        angularRadius: SUN_DISK,
      }
      const part = (rest: Partial<TraceScene>, name: string) =>
        estimateOf(
          tracePixel(
            createTracer(
              scene(slab(depth), { sun, sky: uniformSky(0.02), ...rest }),
            ),
            eyeOn(view),
            view,
            0,
            deriveSeed(SEED, `${label}:${name}`),
            0,
            20_000,
          ),
        )
      const whole = part({}, 'whole')
      const first = part({ orders: 1, sky: uniformSky(0) }, 'first')
      const rest = part({ first: 2 }, 'rest')
      const error = Math.hypot(whole.error, first.error, rest.error)
      expect(Math.abs(first.mean + rest.mean - whole.mean)).toBeLessThan(
        3 * error,
      )
      expect(error).toBeLessThan(0.05 * whole.mean)
      // Neither part is the whole: first order's share, measured at 9% from
      // above and 56% toward the sun.
      expect(first.mean).toBeGreaterThan(least * whole.mean)
      expect(first.mean).toBeLessThan(most * whole.mean)
    },
  )

  it('lights a bare ground at its Lambert form, under the sun and the sky', () => {
    // No cloud at all: the sun's cosine and the sky's irradiance over π,
    // each times the albedo, with nothing drawn that could vary.
    const empty = traceMedium(
      [4, 4, 4],
      [50, 50, 50],
      new Float32Array(64),
      new Float32Array(64).fill(RADIUS),
    )
    const sun = unit(0.3, 0.8, 0.2)
    const tracer = createTracer(
      scene(empty, {
        sun: pointSun(sun),
        sky: uniformSky(0.2),
        ground: { height: -100, albedo: 0.3 },
      }),
    )
    const view = unit(0.2, -0.9, 0.1)
    const sum = tracePixel(tracer, [100, 100, 100], view, 0, SEED, 0, 16)
    expect(estimateOf(sum).mean).toBeCloseTo(0.3 * (sun[1] / Math.PI + 0.2), 12)
  })

  it('draws the sky linear in direction that has the table’s three moments', () => {
    const empty = traceMedium(
      [4, 4, 4],
      [50, 50, 50],
      new Float32Array(64),
      new Float32Array(64).fill(RADIUS),
    )
    const sun = unit(0.6, 0.5, 0)
    const tracer = createTracer(
      scene(empty, {
        sun: { direction: sun, irradiance: [0, 0, 0], angularRadius: 0 },
        sky: {
          mean: [2, 2, 2],
          up: [0.8, 0.8, 0.8],
          sunward: [-0.4, -0.4, -0.4],
        },
      }),
    )
    const rng = Rng.fromSeed(SEED)
    let mean = 0
    let up = 0
    let sunward = 0
    const directions = 20_000
    const golden = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < directions; i += 1) {
      const y = 1 - (2 * (i + 0.5)) / directions
      const r = Math.sqrt(1 - y * y)
      const d: Triple = [r * Math.cos(golden * i), y, r * Math.sin(golden * i)]
      const value = tracer.radiance([100, 100, 100], d, 0, rng)
      mean += value / directions
      // The irradiance on a face from its front less that from its back is
      // the integral of L·(ω·n) over the sphere.
      up += (value * d[1] * 4 * Math.PI) / directions
      sunward += (value * d[0] * 4 * Math.PI) / directions
    }
    expect(mean).toBeCloseTo(2, 3)
    expect(up / (Math.PI * 2)).toBeCloseTo(0.8, 3)
    expect(sunward / (Math.PI * 2)).toBeCloseTo(-0.4, 3)
  })

  it('refuses a sky that leans toward a sun where the scene has none to bear on', () => {
    // The sky alone is traced under its sun at no irradiance. With no sun
    // the sunward term has no bearing and would be drawn as nothing.
    const sky = {
      mean: [1, 1, 1],
      up: [0, 0, 0],
      sunward: [0, 0.5, 0],
    } as const
    expect(() => createTracer(scene(CUMULUS, { sun: null, sky }))).toThrow(
      /needs a sun for its bearing/,
    )
    const tracer = createTracer(
      scene(CUMULUS, {
        sun: {
          direction: unit(0, 0.5, 1),
          irradiance: [0, 0, 0],
          angularRadius: 0,
        },
        sky,
      }),
    )
    // Looking at the sun's bearing, level, from outside the grid: the sky
    // there and no light of a sun that has none.
    const value = tracer.radiance(
      [1000, 800, 2100],
      [0, 0, 1],
      1,
      Rng.fromSeed(SEED),
    )
    expect(value).toBeCloseTo(1 + 0.75 * 0.5, 12)
  })

  /** A sky by direction of one radiance a band. */
  const evenSky = (radiance: Triple) =>
    skyByDirectionOf(
      1.0003,
      { above: 6, below: 4, azimuths: 5 },
      (_x, _y, _z, out) => {
        out[0] = radiance[0]
        out[1] = radiance[1]
        out[2] = radiance[2]
      },
    )
  const darkSun = (direction: Triple): TraceSun => ({
    direction,
    irradiance: [0, 0, 0],
    angularRadius: 0,
  })

  it('returns a sky by direction of one radiance from any pixel: the furnace', () => {
    const sky = evenSky([0.37, 0.5, 0.11])
    const tracer = createTracer(
      scene(CUMULUS, {
        sun: darkSun(unit(0.3, 0.4, -0.8)),
        sky,
        ground: { height: -500, albedo: 1 },
      }),
    )
    for (let py = 0; py < 8; py += 1)
      for (let px = 0; px < 8; px += 1)
        for (let band = 0; band < 3; band += 1) {
          const value = tracer.radiance(
            viewRay(CUMULUS, 8, px, py),
            [0, 0, 1],
            band,
            Rng.fromSeed(
              deriveSeed(SEED, `furnace-by-direction:${px}:${py}:${band}`),
            ),
          )
          // The read is a logarithm's, so the identity holds to rounding.
          expect(value).toBeCloseTo([0.37, 0.5, 0.11][band]!, 14)
        }
    expect(tracer.counts.scatterings).toBeGreaterThan(100)
  })

  it('reads a sky by direction by its height and its bearing from the sun, mirrored across the sun’s plane', () => {
    const empty = traceMedium(
      [4, 4, 4],
      [50, 50, 50],
      new Float32Array(64),
      new Float32Array(64).fill(RADIUS),
    )
    // Bright toward the sun and overhead, in the sky's own frame: z up and
    // the sun's azimuth +x.
    const source = (x: number, _y: number, z: number): number =>
      1 + 0.6 * x + 0.3 * z * z
    const sky = skyByDirectionOf(
      1.0003,
      { above: 24, below: 12, azimuths: 24 },
      (x, y, z, out) => {
        out[0] = source(x, y, z)
        out[1] = 2 * source(x, y, z)
        out[2] = 3 * source(x, y, z)
      },
    )
    // The sun stands north-east; a direction's bearing is from there.
    const sun = unit(1, 0.7, 1)
    const tracer = createTracer(scene(empty, { sun: darkSun(sun), sky }))
    const rng = Rng.fromSeed(SEED)
    for (let i = 0; i < 64; i += 1) {
      const d = unit(rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5)
      const toward = (d[0] + d[2]) / Math.SQRT2
      const across = (d[2] - d[0]) / Math.SQRT2
      for (let band = 0; band < 3; band += 1) {
        const value = tracer.radiance([100, 100, 100], d, band, rng)
        expect(value).toBeCloseTo(
          skyByDirection(sky, d[1], toward, across, band),
          12,
        )
        expect(value).toBeCloseTo(
          skyByDirection(sky, d[1], toward, -across, band),
          12,
        )
        // And it is the source's own, to the read's error between rows.
        expect(
          Math.abs(value / ((band + 1) * source(toward, across, d[1])) - 1),
        ).toBeLessThan(0.01)
      }
    }
  })

  it('refuses a sky by direction where the scene has no sun to bear on', () => {
    expect(() =>
      createTracer(scene(CUMULUS, { sun: null, sky: evenSky([1, 1, 1]) })),
    ).toThrow(/a sky by direction needs a sun for its bearing/)
  })
})

describe('a pixel’s samples', () => {
  const sun = unit(0.5, 0.7, -0.5)
  const all = scene(CUMULUS, {
    sun: { direction: sun, irradiance: [1, 1, 1], angularRadius: SUN_DISK },
    sky: uniformSky(0.05),
  })
  const origin = viewRay(CUMULUS, 32, 16, 14)

  it('do not depend on how a run is split, or on what was traced before', () => {
    const whole = tracePixel(
      createTracer(all),
      origin,
      [0, 0, 1],
      1,
      SEED,
      0,
      64,
    )
    const tracer = createTracer(all)
    tracePixel(tracer, viewRay(CUMULUS, 32, 12, 12), [0, 0, 1], 0, SEED, 0, 8)
    const late = tracePixel(tracer, origin, [0, 0, 1], 1, SEED, 20, 64)
    const early = tracePixel(tracer, origin, [0, 0, 1], 1, SEED, 0, 20)
    const joined = joinSums(early, late)
    expect(joined.samples).toBe(64)
    // To float64's rounding of a sum taken in another order.
    expect(Math.abs(joined.sum - whole.sum)).toBeLessThan(1e-12 * whole.sum)
    expect(Math.abs(joined.squares - whole.squares)).toBeLessThan(
      1e-12 * whole.squares,
    )
  })

  it('give one sample no error and many a finite one', () => {
    expect(estimateOf({ sum: 3, squares: 9, samples: 1 })).toEqual({
      mean: 3,
      error: 0,
    })
    const { mean, error } = estimateOf(
      tracePixel(createTracer(all), origin, [0, 0, 1], 1, SEED, 0, 256),
    )
    expect(mean).toBeGreaterThan(0)
    expect(error).toBeGreaterThan(0)
    expect(error).toBeLessThan(mean)
  })
})
