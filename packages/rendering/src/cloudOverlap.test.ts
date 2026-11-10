import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  crossingDepth,
  crossingExponent,
  crossingTransmittance,
  SIGHT_CELLS,
  stepLight,
  stepShare,
} from './cloudOverlap.ts'

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

  it('take the sight length as 2.8 of the noise’s cells, between the counts’ 2.7 and 3.0', () => {
    expect(SIGHT_CELLS).toBeGreaterThanOrEqual(2.7)
    expect(SIGHT_CELLS).toBeLessThanOrEqual(3)
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
      fc.property(cover, depth, exponent, cuts, (c, tau, n, shares) => {
        const whole = crossingDepth(c, tau, n)
        const split = shares.reduce(
          (sum, share) => sum + crossingDepth(c, tau * share, n * share),
          0,
        )
        expect(relativeTo(split, whole)).toBeLessThan(1e-11)
      }),
      { numRuns: 2000 },
    )
  })

  it('(b) passes between e^−τ and all of it, and less the more columns it counts', () => {
    fc.assert(
      fc.property(cover, depth, exponent, exponent, (c, tau, a, b) => {
        const [few, many] = a < b ? [a, b] : [b, a]
        const through = crossingTransmittance(c, tau, few)
        expect(through).toBeLessThanOrEqual(1)
        expect(through).toBeGreaterThanOrEqual(Math.exp(-tau) * (1 - 1e-12))
        expect(crossingTransmittance(c, tau, many)).toBeLessThanOrEqual(
          through * (1 + 1e-12),
        )
        // Many thin columns at random are the mean medium, and never less.
        expect(crossingDepth(c, tau, many)).toBeLessThanOrEqual(
          c * tau * (1 + 1e-12),
        )
      }),
      { numRuns: 2000 },
    )
  })

  it('(c) is Beer’s law at a cover of one, whatever it counts', () => {
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
