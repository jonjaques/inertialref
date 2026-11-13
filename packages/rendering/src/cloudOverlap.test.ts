import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  gammaDepth,
  crossingDepth,
  crossingExponent,
  crossingTransmittance,
  resolvedSlab,
  SKY_REACH,
  skySource,
  SOURCE_SUN_FLOOR,
  SOURCE_VIEW_FLOOR,
  spreadDepth,
  statisticalSlab,
  stepLight,
  stepRamp,
  stepShare,
} from './cloudOverlap.ts'
import {
  CUMULUS_SKY_QUADRATURE,
  cumulusSkyAir,
  cumulusSkyHeight,
  cumulusSkyRadius,
  cumulusSkyTable,
} from './cumulusFixture.ts'
import { marchSkyFaces, skyMomentsAt } from './skyIrradiance.ts'
import { crossingForm, UNSPREAD_SHAPE } from './weatherField.ts'

/*
 * The crossing's law and the step's integral, the arithmetic the trace's
 * kernel is held to (`cloudTrace.gpu.test.ts` runs the kernel's own
 * functions against these).
 *
 * Every quantity is drawn uniform in its value, or in its logarithm where
 * its range spans decades: fast-check's `fc.double` draws almost every value
 * near zero, and a property about optical depths passes there whatever the
 * law does. The ends of each range are examples of their own.
 */

/** Uniform in [low, high]. */
const between = (low: number, high: number): fc.Arbitrary<number> =>
  fc
    .integer({ min: 0, max: 2 ** 30 })
    .map((k) => low + (high - low) * 2 ** -30 * k)

/** Uniform in the logarithm over [low, high]. */
const decades = (low: number, high: number): fc.Arbitrary<number> =>
  between(Math.log(low), Math.log(high)).map(Math.exp)

/** An in-cloud optical depth: a wisp's 10⁻³ to a cumulonimbus's 10³. */
const depth = decades(1e-3, 1e3)
const cover = between(0, 1)
/** A crossing's columns: one, vertical, to three hundred, grazing. */
const exponent = decades(1, 300)
/**
 * A gamma's shape: from a half, a spread wider than its mean, through the
 * decks' few units to past `UNSPREAD_SHAPE`, where there is no spread.
 */
const shape = decades(0.5, 1e5)
/** Shares of a chord, each at least a thousandth of an even share. */
const cuts = fc
  .array(between(1e-3, 1), { minLength: 2, maxLength: 24 })
  .map((weights) => {
    const sum = weights.reduce((s, w) => s + w, 0)
    return weights.map((w) => w / sum)
  })

const relativeTo = (value: number, reference: number): number =>
  Math.abs(value - reference) / Math.max(Math.abs(reference), 1e-300)

describe('the columns a crossing counts', () => {
  it('are one for a vertical crossing, √2 at a run of one sight length, and the run over the sight length when grazing', () => {
    expect(crossingExponent(0, 2800)).toBe(1)
    expect(crossingExponent(2800, 2800)).toBeCloseTo(Math.SQRT2, 14)
    fc.assert(
      fc.property(decades(1e2, 1e6), decades(1e2, 1e5), (run, sight) => {
        const n = crossingExponent(run, sight)
        expect(n).toBeGreaterThanOrEqual(1)
        expect(n).toBeGreaterThanOrEqual(run / sight)
        expect(n).toBeLessThanOrEqual(1 + run / sight)
      }),
    )
    // The sides of a cloud block before the run reaches a whole sight
    // length: half of one already counts 12% more than one column.
    expect(crossingExponent(1400, 2800)).toBeCloseTo(1.118, 3)
  })
})

describe('a crossing of a partly cloudy level', () => {
  it('(a) passes the same light however its chord is cut into steps', () => {
    /*
     * Under one cover and one extinction a step's depth over its share of
     * the exponent is the crossing's own, so the steps' depths add to the
     * crossing's: an identity of the law, held to float64's rounding over
     * two dozen steps.
     */
    fc.assert(
      fc.property(
        cover,
        depth,
        exponent,
        shape,
        cuts,
        (c, tau, n, k, shares) => {
          const whole = crossingDepth(c, tau, n, k)
          const split = shares.reduce(
            (sum, share) => sum + crossingDepth(c, tau * share, n * share, k),
            0,
          )
          expect(relativeTo(split, whole)).toBeLessThan(1e-11)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('(b) passes between e^−τ and all of it, and less the more columns it counts', () => {
    fc.assert(
      fc.property(
        cover,
        depth,
        exponent,
        exponent,
        shape,
        (c, tau, a, b, k) => {
          const [few, many] = a < b ? [a, b] : [b, a]
          const through = crossingTransmittance(c, tau, few, k)
          expect(through).toBeLessThanOrEqual(1)
          expect(through).toBeGreaterThanOrEqual(Math.exp(-tau) * (1 - 1e-12))
          expect(crossingTransmittance(c, tau, many, k)).toBeLessThanOrEqual(
            through * (1 + 1e-9),
          )
          // Many thin columns at random are the mean medium, and never less.
          expect(crossingDepth(c, tau, many, k)).toBeLessThanOrEqual(
            c * tau * (1 + 1e-12),
          )
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('(c) is Beer’s law at a cover of one where depths do not spread, whatever it counts', () => {
    fc.assert(
      fc.property(depth, exponent, (tau, n) => {
        expect(crossingDepth(1, tau, n)).toBe(tau)
        expect(crossingTransmittance(1, tau, n)).toBe(Math.exp(-tau))
      }),
    )
    // The ends: a cover a rounding under one is within that rounding of it.
    expect(relativeTo(crossingDepth(1 - 2 ** -53, 5, 1), 5)).toBeLessThan(1e-12)
    expect(crossingDepth(0, 20, 3)).toBe(0)
    expect(crossingDepth(0.5, 0, 3)).toBe(0)
  })

  it('(d) passes half the light through a half-clear layer of depth 20 at any cut, not a quarter', () => {
    /*
     * The plan's example. A vertical crossing counts one column, and its
     * steps share that one: mixed as columns of their own, two steps of
     * depth 10 at half cover pass (½ + ½e⁻¹⁰)², the clear half counted
     * twice.
     */
    expect(crossingTransmittance(0.5, 20, 1)).toBeCloseTo(0.5, 8)
    fc.assert(
      fc.property(cuts, (shares) => {
        const through = shares.reduce(
          (product, share) =>
            product * crossingTransmittance(0.5, 20 * share, share),
          1,
        )
        expect(through).toBeCloseTo(0.5, 8)
      }),
    )
    const perStep = crossingTransmittance(0.5, 10, 1) ** 2
    expect(perStep).toBeCloseTo(0.25, 4)
  })

  it('(e) is its two levels’ product: separate crossings overlap at random', () => {
    fc.assert(
      fc.property(
        fc.tuple(cover, depth, exponent),
        fc.tuple(cover, depth, exponent),
        (lower, upper) => {
          const both = crossingDepth(...lower) + crossingDepth(...upper)
          expect(Math.exp(-both)).toBeCloseTo(
            crossingTransmittance(...lower) * crossingTransmittance(...upper),
            14,
          )
        },
      ),
    )
  })

  it('tends to the mean medium as its columns thin: a grazing ray through broken cloud', () => {
    // 300 columns of depth 0.01 each at 35% cover: within 0.4% of c·τ.
    expect(relativeTo(crossingDepth(0.35, 3, 300), 0.35 * 3)).toBeLessThan(4e-3)
    // And one column of the same depth passes 1.9 times the light.
    expect(crossingDepth(0.35, 3, 1)).toBeCloseTo(0.4043, 3)
  })
})

describe('a level whose depths are spread', () => {
  it('is the measured form from a level’s four numbers, and 1 − F + F·e^(−τ′) straight down at any shape', () => {
    fc.assert(
      fc.property(
        cover,
        decades(1e-2, 60),
        decades(0.5, 9999),
        decades(200, 30_000),
        decades(100, 14_000),
        between(0, (85 * Math.PI) / 180),
        (fraction, tau, k, sight, thickness, zenith) => {
          const n = crossingExponent(thickness * Math.tan(zenith), sight)
          const slant = spreadDepth(tau, k) / Math.cos(zenith)
          const depth = crossingDepth(fraction, slant, n, k)
          const expected = -Math.log(
            crossingForm(fraction, tau, k, sight, thickness, zenith),
          )
          // The form as written adds a column's opacity to one before it
          // takes the logarithm, so it holds eight digits of an opacity of
          // 10⁻⁸ a column and none under 10⁻¹⁶, and it underflows a float64
          // past a depth of 700: compared where it holds six.
          if (expected > 1e-8 * n && expected < 600)
            expect(relativeTo(depth, expected)).toBeLessThan(1e-6)
          const down = crossingTransmittance(
            fraction,
            spreadDepth(tau, k),
            1,
            k,
          )
          expect(down).toBeCloseTo(1 - fraction + fraction * Math.exp(-tau), 12)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('passes more on a slant than one depth does: (mean e^−τ)^m is under mean e^(−m·τ)', () => {
    fc.assert(
      fc.property(
        decades(1e-2, 30),
        decades(0.5, 9999),
        between(1, 12),
        (tau, k, m) => {
          const spread = gammaDepth(spreadDepth(tau, k) * m, k)
          expect(spread).toBeLessThanOrEqual(m * tau * (1 + 1e-12))
          // And at the path the depth was measured on, the two agree.
          expect(
            relativeTo(gammaDepth(spreadDepth(tau, k), k), tau),
          ).toBeLessThan(1e-12)
        },
      ),
      { numRuns: 2000 },
    )
    // A deck of depth 3 whose columns spread as an exponential, at 75°: one
    // depth passes e⁻¹², six parts in a million; the spread passes 1.3%.
    const slant = spreadDepth(3, 1) * 4
    expect(Math.exp(-gammaDepth(slant, 1))).toBeCloseTo(0.0129, 4)
    expect(Math.exp(-12)).toBeLessThan(1e-5)
  })

  it('joins depths that do not spread at a shape of 10⁴, within x²/(2k) of the exponent', () => {
    /*
     * `(1 + x/k)^(−k)` is `e^(−x)·e^(x²/(2k) − …)`, so where the shape
     * reaches `UNSPREAD_SHAPE` and the column passes `e^(−x)` itself, the
     * exponent steps by under x²/(2k): 1.25 × 10⁻³ at a depth of five, past
     * which a column passes under 1%.
     */
    const under = UNSPREAD_SHAPE * (1 - 1e-12)
    fc.assert(
      fc.property(decades(1e-3, 10), (x) => {
        expect(gammaDepth(x, UNSPREAD_SHAPE)).toBe(x)
        const step = x - gammaDepth(x, under)
        expect(step).toBeGreaterThan(0)
        expect(step).toBeLessThanOrEqual((x * x) / (2 * UNSPREAD_SHAPE))
        expect(spreadDepth(x, UNSPREAD_SHAPE)).toBe(x)
        expect(spreadDepth(x, under) - x).toBeLessThanOrEqual(
          ((x * x) / (2 * UNSPREAD_SHAPE)) * (1 + x / UNSPREAD_SHAPE),
        )
      }),
    )
    expect(5 - gammaDepth(5, under)).toBeCloseTo(1.25e-3, 5)
  })
})

describe('the light a step adds', () => {
  /** A uniform slab's first order, seen and lit at cosines μ and μ₀: the source falls as e^(−(μ/μ₀)·t). */
  const reflected = (ratio: number, tau: number): number =>
    -Math.expm1(-(1 + ratio) * tau) / (1 + ratio)

  /** The slab marched in steps of the given depths, each step's source at its two ends. */
  function marched(
    ratio: number,
    steps: readonly number[],
    light: (start: number, end: number, depth: number) => number,
  ): number {
    let at = 0
    let sum = 0
    for (const step of steps) {
      sum +=
        Math.exp(-at) *
        light(Math.exp(-ratio * at), Math.exp(-ratio * (at + step)), step)
      at += step
    }
    return sum
  }

  it('is a slab’s reflected first order exactly, at any step depths and any sun', () => {
    fc.assert(
      fc.property(
        decades(0.05, 20),
        fc.array(decades(1e-3, 3), { minLength: 1, maxLength: 40 }),
        (ratio, steps) => {
          const tau = steps.reduce((s, step) => s + step, 0)
          expect(
            relativeTo(marched(ratio, steps, stepLight), reflected(ratio, tau)),
          ).toBeLessThan(1e-11)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('is what a source held at the step’s start is not: 15%, 52% and 76% high at depths of 0.3, 1.16 and 2', () => {
    // The variant: the left-endpoint rule, exact for a constant source.
    const atStart = (start: number, _end: number, step: number): number =>
      start * step * stepShare(step)
    for (const [step, high] of [
      [0.3, 1.149],
      [1.16, 1.523],
      [2, 1.762],
    ] as const) {
      const steps = new Array<number>(Math.ceil(40 / step)).fill(step)
      const tau = steps.length * step
      const exact = reflected(1, tau)
      expect(relativeTo(marched(1, steps, stepLight), exact)).toBeLessThan(
        1e-12,
      )
      expect(marched(1, steps, atStart) / exact).toBeCloseTo(high, 3)
    }
    // And toward a low sun, μ/μ₀ = 5 at a depth of 0.3: 86% high.
    const steps = new Array<number>(200).fill(0.3)
    expect(marched(5, steps, atStart) / reflected(5, 60)).toBeCloseTo(1.863, 3)
  })

  it('is the source times the step’s opacity where the source is constant, and lies between its ends’ everywhere', () => {
    fc.assert(
      fc.property(
        decades(1e-6, 1e3),
        decades(1e-6, 1e3),
        decades(1e-4, 50),
        (start, end, tau) => {
          const opacity = -Math.expm1(-tau)
          expect(
            relativeTo(stepLight(start, start, tau), start * opacity),
          ).toBeLessThan(1e-12)
          const light = stepLight(start, end, tau)
          expect(light).toBeGreaterThanOrEqual(
            Math.min(start, end) * opacity * (1 - 1e-12),
          )
          expect(light).toBeLessThanOrEqual(
            Math.max(start, end) * opacity * (1 + 1e-12),
          )
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('takes a dark end as a ramp to the other, and two lit ends any number of e-folds apart as one exponential', () => {
    // Dark at the start: ∫ (t/τ)·e^−t dt, the far end's weight alone.
    expect(stepLight(0, 1, 2)).toBeCloseTo((1 - 3 * Math.exp(-2)) / 2, 14)
    expect(stepLight(1, 0, 2)).toBeCloseTo(
      1 - Math.exp(-2) - (1 - 3 * Math.exp(-2)) / 2,
      14,
    )
    expect(stepLight(0, 0, 2)).toBe(0)
    expect(stepLight(1, 0, 0)).toBe(0)
    // Thin, where the ramp's quotient cancels: the series takes over.
    expect(
      relativeTo(stepLight(0, 1, 1e-3), 1e-3 / 2 - 1e-6 / 3 + 1e-9 / 8),
    ).toBeLessThan(1e-9)
    const below = stepLight(0, 1, 0.01 - 1e-12)
    expect(relativeTo(below, stepLight(0, 1, 0.01))).toBeLessThan(1e-9)
    /*
     * A step of depth 7.3 at the far handover under a sun half as high as
     * the view: the source falls e^14.6 along it. A ramp between those two
     * ends is 6.5 times the integral, and a rule that changed form at a
     * ratio of e⁸ would step by that factor there.
     */
    const exact = -Math.expm1(-3 * 7.3) / 3
    expect(relativeTo(stepLight(1, Math.exp(-14.6), 7.3), exact)).toBeLessThan(
      1e-12,
    )
    const ramp = (1 - Math.exp(-7.3)) * (1 - 1 / 7.3)
    expect(ramp / exact).toBeGreaterThan(2.5)
    // A source that grows e^200 along a step, and one that falls by it:
    // finite, and each the integral of its exponential.
    const grown = stepLight(Math.exp(-200), 1, 3)
    expect(relativeTo(grown, (Math.exp(-3) * 3) / 197)).toBeLessThan(1e-12)
    const fallen = stepLight(1, Math.exp(-200), 3)
    expect(relativeTo(fallen, 3 / 203)).toBeLessThan(1e-12)
  })

  it('keeps its light however a step is cut, for a source that falls exponentially along it', () => {
    fc.assert(
      fc.property(
        decades(0.05, 20),
        decades(1e-2, 6),
        cuts,
        (ratio, tau, shares) => {
          const whole = marched(ratio, [tau], stepLight)
          const split = marched(
            ratio,
            shares.map((share) => share * tau),
            stepLight,
          )
          expect(relativeTo(split, whole)).toBeLessThan(1e-11)
        },
      ),
      { numRuns: 2000 },
    )
  })
})

describe('the share of a step', () => {
  it('is (1 − e^−y)/y at either sign, continuous where the quotient takes over', () => {
    /*
     * One term past air.ts's: float64 resolves y⁴/120, which at y = 0.01 is
     * 8 × 10⁻¹¹ of the share, and the split properties above would see it.
     * A negative y is a source that grows along its step faster than the
     * step dims it.
     */
    fc.assert(
      fc.property(between(-50, 50), (y) => {
        const exact = y === 0 ? 1 : -Math.expm1(-y) / y
        expect(relativeTo(stepShare(y), exact)).toBeLessThan(2e-13)
      }),
    )
    for (const edge of [0.01, -0.01])
      expect(
        relativeTo(stepShare(edge * (1 - 1e-13)), stepShare(edge)),
      ).toBeLessThan(2e-13)
    expect(stepShare(0)).toBe(1)
  })
})

describe('the slab a sample stands in', () => {
  /*
   * A statistical step's columns are a gamma of shape k and mean m, and a
   * ray that has crossed the share s of the level at a cosine μ has weighed
   * a column of depth τ by τ·e^(−s·τ/μ): a gamma of shape k + 1 and scale
   * θ = 1/(k/m + s/μ), whose moments are θʲ·(k + 1)(k + 2)…(k + j). A Gauss
   * rule of n points takes every polynomial of degree 2n − 1 exactly, so
   * the two points sum the columns' depths to their third power as the
   * gamma has them, and the one point their mean: a source that is a cubic
   * in a column's depth is summed exactly by two reads.
   */
  const shapes = between(Math.log(0.3), Math.log(40)).map(Math.exp)
  const means = between(Math.log(0.05), Math.log(60)).map(Math.exp)

  it('sums the tilted gamma’s columns to their third moment at two points, and to their mean at one', () => {
    fc.assert(
      fc.property(
        shapes,
        means,
        between(0, 1),
        between(SOURCE_VIEW_FLOOR, 1),
        fc.boolean(),
        (shape, mean, seen, viewMu, litSide) => {
          const scale = 1 / (shape / mean + seen / viewMu)
          const moment = (j: number): number => {
            let product = 1
            for (let i = 1; i <= j; i += 1) product *= (shape + i) * scale
            return product
          }
          const statistics = { shape, mean }
          const at = (point: 0 | 1, points: 1 | 2) =>
            statisticalSlab(
              statistics,
              seen,
              viewMu,
              litSide,
              0.4,
              point,
              points,
            )
          const column = ({ slab }: ReturnType<typeof at>): number =>
            slab.top + slab.bottom
          const one = at(0, 1)
          expect(one.weight).toBe(1)
          expect(column(one)).toBeCloseTo(moment(1), 9)
          const two = [at(0, 2), at(1, 2)] as const
          expect(two[0].weight + two[1].weight).toBeCloseTo(1, 12)
          expect(column(two[0])).toBeLessThan(column(two[1]))
          for (const j of [1, 2, 3]) {
            const sum = two.reduce(
              (total, point) => total + point.weight * column(point) ** j,
              0,
            )
            expect(Math.abs(sum - moment(j))).toBeLessThan(1e-9 * moment(j))
          }
          // The sample stands the ray's share under the eye's face, which
          // is the lit one or the far one.
          for (const point of [one, ...two]) {
            const under = litSide ? seen : 1 - seen
            expect(point.slab.top).toBeCloseTo(under * column(point), 9)
            expect(point.slab.sunMu).toBe(0.4)
          }
        },
      ),
    )
  })

  it('is one depth where a level’s depths do not spread, and nothing at a mean of nothing', () => {
    const flat = { shape: UNSPREAD_SHAPE, mean: 20 }
    for (const point of [0, 1] as const) {
      const { slab } = statisticalSlab(flat, 0, 1, true, 1, point, 2)
      // A ray that has crossed none of the level weighs its columns by
      // their depth alone: the two points stand 1/√k to each side of the
      // one depth.
      expect(Math.abs(slab.top + slab.bottom - 20)).toBeLessThan(
        (20 * 1.1) / Math.sqrt(UNSPREAD_SHAPE),
      )
      expect(slab.top).toBe(0)
    }
    const none = statisticalSlab(
      { shape: 0.6, mean: 0 },
      0.5,
      0.5,
      false,
      0.2,
      1,
      2,
    )
    expect(none.slab.top + none.slab.bottom).toBeLessThan(1e-5)
    expect(Number.isFinite(none.weight)).toBe(true)
  })

  it('turns a resolved step’s two depths by the sun’s cosine, its size under the horizon, never under the table’s floor', () => {
    fc.assert(
      fc.property(
        between(0, 64),
        between(0, 64),
        between(-1, 1),
        (toSun, behind, sunMu) => {
          const slab = resolvedSlab(toSun, toSun + behind, sunMu)
          const mu = Math.max(Math.abs(sunMu), SOURCE_SUN_FLOOR)
          expect(slab.sunMu).toBe(mu)
          expect(slab.top).toBeCloseTo(mu * toSun, 12)
          expect(slab.bottom).toBeCloseTo(mu * behind, 10)
        },
      ),
    )
    // A whole depth under the depth to the sun leaves nothing behind.
    expect(resolvedSlab(12, 3, 0.5)).toEqual({ sunMu: 0.5, top: 6, bottom: 0 })
    expect(resolvedSlab(12, 30, -0.01).sunMu).toBe(SOURCE_SUN_FLOOR)
  })
})

describe('the light a step adds of a ramp', () => {
  const source = between(0, 3)

  it('is the ramp’s integral over the step, by 2,000 points', () => {
    fc.assert(
      fc.property(source, source, decades(1e-4, 60), (start, end, depth) => {
        const N = 2000
        let sum = 0
        for (let i = 0; i < N; i += 1) {
          const t = ((i + 0.5) / N) * depth
          sum +=
            (start + ((end - start) * t) / depth) * Math.exp(-t) * (depth / N)
        }
        // The midpoints' own error at a depth of 60 is 4 parts in 10⁵.
        expect(Math.abs(stepRamp(start, end, depth) - sum)).toBeLessThan(
          1e-4 * Math.max(start, end) + 1e-12,
        )
      }),
    )
  })

  it('is the source times the step’s opacity where the two ends are one, and `stepLight` where an end is dark', () => {
    fc.assert(
      fc.property(source, decades(1e-4, 60), (level, depth) => {
        const opacity = 1 - Math.exp(-depth)
        expect(
          Math.abs(stepRamp(level, level, depth) - level * opacity),
        ).toBeLessThan(1e-12 * Math.max(level, 1))
        expect(stepRamp(0, level, depth)).toBe(stepLight(0, level, depth))
        expect(stepRamp(level, 0, depth)).toBe(stepLight(level, 0, depth))
      }),
    )
  })
})

describe('the sky’s light on a sample', () => {
  // A sky's sides as the table holds them: Δ and Δ_s inside ±1.5, and c
  // from nothing to under the linear sky by half of the sky's mean.
  const lean = between(-1.5, 1.5)
  const short = between(-0.5, 0)
  const column = decades(1e-4, 400)
  const cosine = between(-1, 1)
  const share = between(0, 1)
  /** The scaled phase's g′ at 10 µm. */
  const ASYMMETRY = 0.74

  it('is the sky’s mean under a sky alike on every side, at any column, share and view', () => {
    fc.assert(
      fc.property(
        column,
        column,
        share,
        cosine,
        cosine,
        (over, under, convective, rise, sunward) => {
          expect(
            skySource(
              { up: 0, sunward: 0, upper: 0 },
              over,
              under,
              convective,
              ASYMMETRY,
              rise,
              sunward,
            ),
          ).toBe(1)
        },
      ),
    )
  })

  it('is the lean and the flux alone for a cumuliform column, to the bit, whatever c is', () => {
    fc.assert(
      fc.property(
        lean,
        lean,
        short,
        column,
        column,
        cosine,
        cosine,
        (up, toSun, upper, over, under, rise, sunward) => {
          const reach = over + under + 2 * SKY_REACH
          const design = Math.max(
            up * ((under + SKY_REACH) / reach - 0.5) +
              1 +
              ((up * rise + toSun * sunward) * ASYMMETRY) / reach,
            0,
          )
          const at = (c: number): number =>
            skySource(
              { up, sunward: toSun, upper: c },
              over,
              under,
              1,
              ASYMMETRY,
              rise,
              sunward,
            )
          expect(at(upper)).toBe(design)
          expect(at(0)).toBe(design)
        },
      ),
    )
  })

  it('takes c by the column’s stratiform share and its thickness, and none of it in a wisp', () => {
    fc.assert(
      fc.property(
        lean,
        lean,
        short,
        column,
        column,
        share,
        cosine,
        cosine,
        (up, toSun, upper, over, under, convective, rise, sunward) => {
          const at = (v: number): number =>
            skySource(
              { up, sunward: toSun, upper },
              over,
              under,
              v,
              ASYMMETRY,
              rise,
              sunward,
            )
          const span = over + under
          const want =
            (1 - convective) * upper * (span / (span + 2 * SKY_REACH))
          // Where neither is held at zero the two differ by the term alone.
          fc.pre(at(1) > 0 && at(1) + want > 0)
          expect(Math.abs(at(convective) - at(1) - want)).toBeLessThan(1e-12)
          // c is not over zero, so it never brightens a sample.
          expect(at(convective)).toBeLessThanOrEqual(at(1))
          // A wisp of a thousandth of a transport depth takes under a
          // thousandth of it.
          expect(Math.abs(want)).toBeLessThanOrEqual(
            Math.abs(upper) * (span / (2 * SKY_REACH)),
          )
        },
      ),
    )
  })

  it('is each side’s irradiance over π at the two faces of a thick stratiform column', () => {
    fc.assert(
      fc.property(
        lean,
        lean,
        short,
        decades(30, 3000),
        cosine,
        cosine,
        (up, toSun, upper, thick, rise, sunward) => {
          const sides = { up, sunward: toSun, upper }
          // What a face of a column `thick` deep is short of the limit by:
          // the lean and c each by their share of the reach, and the flux.
          const bound =
            (SKY_REACH * Math.abs(up) +
              2 * SKY_REACH * Math.abs(upper) +
              ASYMMETRY * Math.abs(up * rise + toSun * sunward)) /
              (thick + 2 * SKY_REACH) +
            1e-12
          const top = skySource(sides, 0, thick, 0, ASYMMETRY, rise, sunward)
          const base = skySource(sides, thick, 0, 0, ASYMMETRY, rise, sunward)
          expect(
            Math.abs(top - Math.max(1 + up / 2 + upper, 0)),
          ).toBeLessThanOrEqual(bound)
          expect(
            Math.abs(base - Math.max(1 - up / 2 + upper, 0)),
          ).toBeLessThanOrEqual(bound)
        },
      ),
    )
  })

  it('is the air’s own two sides at a deck’s faces, from the sky table’s four numbers', () => {
    // The table's moments against the quadrature's sides, which no linear
    // sky gives: without c the upper side reads 18% to 200% high and the
    // lower 9% to 64%, at 1.7 km and 9.5 km under suns of 15° and 45°. With
    // it both are within 0.77%. The limit is the table's rows, 3% at a
    // cloud's height; a column 4,000 deep is short of its limit by under
    // 0.2% of the dimmer side.
    const table = cumulusSkyTable()
    const air = cumulusSkyAir()
    const THICK = 4000
    let worst = 0
    let without = 0
    for (const height of [1700, 9500])
      for (const degrees of [15, 45]) {
        const sunMu = Math.sin((degrees * Math.PI) / 180)
        const moments = skyMomentsAt(table, cumulusSkyHeight(height), sunMu)
        const faces = marchSkyFaces(
          air,
          cumulusSkyRadius(height),
          sunMu,
          CUMULUS_SKY_QUADRATURE,
        )
        for (const band of [0, 1, 2] as const) {
          const sides = {
            up: moments.up[band],
            sunward: moments.sunward[band],
            upper: moments.upper[band],
          }
          const mean = moments.mean[band]
          const top = mean * skySource(sides, 0, THICK, 0, ASYMMETRY, 0, 0)
          const base = mean * skySource(sides, THICK, 0, 0, ASYMMETRY, 0, 0)
          const above = faces.above[band] / Math.PI
          const below = faces.below[band] / Math.PI
          worst = Math.max(
            worst,
            Math.abs(top / above - 1),
            Math.abs(base / below - 1),
          )
          const linear =
            mean *
            skySource({ ...sides, upper: 0 }, 0, THICK, 0, ASYMMETRY, 0, 0)
          without = Math.max(without, Math.abs(linear / above - 1))
        }
      }
    expect(worst).toBeLessThan(0.03)
    // The same face without c, twice its light at worst: the test can fail.
    expect(without).toBeGreaterThan(1)
  })
})
