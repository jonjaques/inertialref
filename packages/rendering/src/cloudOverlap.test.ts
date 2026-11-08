import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type CloudSegment,
  closeSegment,
  OPEN_SEGMENT,
  stepSegment,
  stepShare,
} from './cloudOverlap.ts'

/*
 * Maximum-random overlap, the bookkeeping the trace's kernel is held to:
 * inside one layer's crossing of one column every step shares the column's
 * largest fraction, and separate segments multiply. The five properties are
 * §5.7's, each of the reference itself; `cloudTrace.gpu.test.ts` holds the
 * kernel to the same five.
 */

const sigma = fc.double({ min: 1e-6, max: 0.2, noNaN: true })
const length = fc.double({ min: 1e-3, max: 2000, noNaN: true })
const source = fc.double({ min: 0, max: 10, noNaN: true })
const fraction = fc.double({ min: 0, max: 1, noNaN: true })

const FRONT = { transmittance: 1, light: 0 }

/** A segment crossed in `steps` equal steps of one medium. */
function crossed(
  steps: number,
  c: number,
  s: number,
  j: number,
  l: number,
): CloudSegment {
  let segment = OPEN_SEGMENT
  for (let k = 0; k < steps; k += 1)
    segment = stepSegment(segment, c, s, j, l / steps)
  return segment
}

const relativeTo = (value: number, reference: number): number =>
  Math.abs(value - reference) / Math.max(Math.abs(reference), 1e-300)

describe('a segment of cloud', () => {
  it('(a) keeps its transmittance and its light however its steps are split', () => {
    /*
     * The step integral telescopes: (1 − e^−τ₁) + e^−τ₁(1 − e^−τ₂) is
     * 1 − e^−(τ₁+τ₂) exactly, so this is a test of the arithmetic, not of
     * an approximation. A split can put a step under τ = 0.01 and onto the
     * series, whose first dropped term is the one that has to stay under
     * the 10⁻¹² here.
     */
    fc.assert(
      fc.property(
        fraction,
        sigma,
        source,
        length,
        fc.integer({ min: 2, max: 64 }),
        (c, s, j, l, k) => {
          const whole = closeSegment(FRONT, crossed(1, c, s, j, l))
          const split = closeSegment(FRONT, crossed(k, c, s, j, l))
          expect(
            relativeTo(split.transmittance, whole.transmittance),
          ).toBeLessThan(1e-12)
          if (whole.light > 0)
            expect(relativeTo(split.light, whole.light)).toBeLessThan(1e-12)
        },
      ),
      { numRuns: 5000 },
    )
  })

  it('takes the step’s integral, source × (1 − e^−σℓ), for one step', () => {
    fc.assert(
      fc.property(sigma, source, length, (s, j, l) => {
        const segment = stepSegment(OPEN_SEGMENT, 1, s, j, l)
        // The series' first dropped term, τ⁵/720, is 1.4 × 10⁻¹³ at τ = 0.01.
        expect(relativeTo(segment.light, -j * Math.expm1(-s * l))).toBeLessThan(
          2e-13,
        )
        expect(segment.depth).toBe(s * l)
        expect(segment.through).toBe(Math.exp(-s * l))
      }),
    )
  })

  it('(b) passes between e^−τ and all of it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fraction, sigma, length), {
          minLength: 1,
          maxLength: 12,
        }),
        (steps) => {
          let segment = OPEN_SEGMENT
          for (const [c, s, l] of steps)
            segment = stepSegment(segment, c, s, 1, l)
          const { transmittance } = closeSegment(FRONT, segment)
          expect(transmittance).toBeLessThanOrEqual(1)
          expect(transmittance).toBeGreaterThanOrEqual(
            Math.exp(-segment.depth) * (1 - 1e-12),
          )
        },
      ),
    )
  })

  it('(c) is Beer’s law when the column is wholly cloudy', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(sigma, length), { minLength: 1, maxLength: 12 }),
        (steps) => {
          let segment = OPEN_SEGMENT
          let depth = 0
          for (const [s, l] of steps) {
            segment = stepSegment(segment, 1, s, 1, l)
            depth += s * l
          }
          expect(
            relativeTo(
              closeSegment(FRONT, segment).transmittance,
              Math.exp(-depth),
            ),
          ).toBeLessThan(1e-12)
        },
      ),
    )
  })

  it('(d) passes half the light through a half-clear layer at τ 20, not a quarter', () => {
    /*
     * The plan's example, and the reason the fraction is held for the whole
     * crossing: mixed per step, two steps of τ 10 at half cover pass
     * (½ + ½e⁻¹⁰)² — the clear half counted twice, as if each step were its
     * own column.
     */
    const segment = crossed(2, 0.5, 0.01, 1, 2000)
    expect(segment.depth).toBeCloseTo(20, 12)
    const { transmittance } = closeSegment(FRONT, segment)
    expect(transmittance).toBeCloseTo(0.5, 8)
    const perStep = (0.5 + 0.5 * Math.exp(-10)) ** 2
    expect(perStep).toBeCloseTo(0.25, 4)
    expect(Math.abs(transmittance - perStep)).toBeGreaterThan(0.24)
  })

  it('(e) multiplies with the segments in front of it, overlapped at random', () => {
    fc.assert(
      fc.property(
        fc.tuple(fraction, sigma, source, length),
        fc.tuple(fraction, sigma, source, length),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        (first, second, transmittance, light) => {
          const front = { transmittance, light }
          const a = crossed(3, ...first)
          const b = crossed(5, ...second)
          const one = closeSegment(front, a)
          const both = closeSegment(one, b)
          const ta = 1 - a.fraction + a.fraction * a.through
          const tb = 1 - b.fraction + b.fraction * b.through
          expect(both.transmittance).toBeCloseTo(transmittance * ta * tb, 14)
          expect(both.light).toBeCloseTo(
            light +
              transmittance * a.fraction * a.light +
              transmittance * ta * b.fraction * b.light,
            12,
          )
        },
      ),
    )
  })

  it('takes the share of a thin step from the series, continuous where the quotient takes over', () => {
    /*
     * One term past air.ts's: float64 resolves τ⁴/120, which at τ = 0.01 is
     * 8 × 10⁻¹¹ of the share, and the split property above would see it.
     */
    fc.assert(
      fc.property(fc.double({ min: 0, max: 50, noNaN: true }), (tau) => {
        const exact = tau === 0 ? 1 : -Math.expm1(-tau) / tau
        expect(relativeTo(stepShare(tau), exact)).toBeLessThan(2e-13)
      }),
    )
    const below = stepShare(0.01 - 1e-15)
    const above = stepShare(0.01)
    expect(relativeTo(below, above)).toBeLessThan(2e-13)
    expect(stepShare(0)).toBe(1)
  })

  it('holds the largest fraction the crossing met, in whatever order it met them', () => {
    fc.assert(
      fc.property(
        fc.array(fraction, { minLength: 1, maxLength: 8 }),
        (fractions) => {
          let segment = OPEN_SEGMENT
          for (const c of fractions)
            segment = stepSegment(segment, c, 0.01, 1, 10)
          expect(segment.fraction).toBe(Math.max(...fractions))
        },
      ),
    )
  })

  it('stays where it was across a step of nothing', () => {
    const segment = stepSegment(OPEN_SEGMENT, 0.3, 0, 1, 500)
    expect(segment.light).toBe(0)
    expect(segment.through).toBe(1)
    expect(segment.fraction).toBe(0.3)
    expect(closeSegment(FRONT, OPEN_SEGMENT)).toEqual(FRONT)
  })
})
