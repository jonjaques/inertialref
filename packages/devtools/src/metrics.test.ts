import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Series } from './metrics.ts'

/*
 * The overlay's arithmetic, checked against the obvious implementation.
 *
 * `Series` is a ring buffer that sorts a scratch view in place and computes a
 * nearest-rank percentile off a wrapped index — three chances to be off by one,
 * none of which would look wrong on a plot. So every property here is stated
 * against a plain array doing the same thing slowly.
 */

const finite = fc.double({ min: -1e6, max: 1e6, noNaN: true })

/** The last `capacity` finite values, in order. What the ring should contain. */
function window(values: readonly number[], capacity: number): number[] {
  return values.filter(Number.isFinite).slice(-capacity)
}

/**
 * Ascending, and a total order — which `(a, b) => a - b` is not.
 *
 * `0 - -0` is `0`, so the subtraction comparator calls the two zeros equal and
 * `Array.prototype.sort` leaves them in input order. A `Float64Array` sorts
 * them apart, `-0` first, which is what `Series` does and what a percentile
 * off that window therefore reports — so an oracle built on the subtraction
 * disagrees with a correct implementation on any window holding both.
 */
const ascending = (a: number, b: number): number =>
  a === b ? (Object.is(a, -0) ? -1 : Object.is(b, -0) ? 1 : 0) : a - b

function fill(values: readonly number[], capacity: number): Series {
  const series = new Series(capacity)
  for (const value of values) series.push(value)
  return series
}

describe('Series', () => {
  it('holds the last `capacity` samples and nothing older', () => {
    fc.assert(
      fc.property(
        fc.array(finite, { maxLength: 200 }),
        fc.integer({ min: 1, max: 64 }),
        (values, capacity) => {
          const expected = window(values, capacity)
          const stats = fill(values, capacity).summarise()
          expect(stats.count).toBe(expected.length)
          if (expected.length > 0)
            expect(stats.last).toBe(expected[expected.length - 1])
        },
      ),
    )
  })

  it('reports the same zero a plain array would', () => {
    /*
     * The property above finds this only when fast-check happens to draw both
     * zeros into one window, which is why it passed for months and then failed
     * once, on a seed. Stated as an example it is checked every run.
     *
     * `toBe` is `Object.is`, so it separates the two — and it should, because
     * `Math.min(0, -0)` is `-0` and a running minimum built from `<` cannot
     * produce it: `-0 < 0` is false. `max` had the same defect pointing the
     * other way, and nothing had reported it because the property stops at the
     * first failed assertion.
     */
    const both = fill([0, -0], 2).summarise()
    expect(both.min).toBe(Math.min(0, -0))
    expect(both.max).toBe(Math.max(0, -0))

    const reversed = fill([-0, 0], 2).summarise()
    expect(reversed.min).toBe(Math.min(-0, 0))
    expect(reversed.max).toBe(Math.max(-0, 0))
  })

  it('agrees with a plain array on every statistic', () => {
    fc.assert(
      fc.property(
        fc.array(finite, { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 64 }),
        (values, capacity) => {
          const expected = window(values, capacity)
          if (expected.length === 0) return
          const stats = fill(values, capacity).summarise()
          const sorted = [...expected].sort(ascending)
          const rank = Math.min(
            sorted.length - 1,
            Math.ceil(0.95 * sorted.length) - 1,
          )

          expect(stats.min).toBe(Math.min(...expected))
          expect(stats.max).toBe(Math.max(...expected))
          expect(stats.mean).toBeCloseTo(
            expected.reduce((a, b) => a + b, 0) / expected.length,
            9,
          )
          expect(stats.p95).toBe(sorted[Math.max(0, rank)])
        },
      ),
    )
  })

  it('drains oldest first, which is the order a plot is drawn in', () => {
    // The ring's newest sample sits wherever the write cursor stopped, so a
    // straight copy of the backing array plots the window rotated by an amount
    // that changes every frame — a plot that shimmers rather than scrolls.
    fc.assert(
      fc.property(
        fc.array(finite, { maxLength: 200 }),
        fc.integer({ min: 1, max: 64 }),
        (values, capacity) => {
          const series = fill(values, capacity)
          const out = new Float64Array(capacity)
          const written = series.drain(out)
          expect([...out.subarray(0, written)]).toEqual(
            window(values, capacity),
          )
        },
      ),
    )
  })

  it('takes the newest samples when the plot is narrower than the window', () => {
    const series = fill([1, 2, 3, 4, 5, 6, 7, 8], 8)
    const out = new Float64Array(3)
    expect(series.drain(out)).toBe(3)
    expect([...out]).toEqual([6, 7, 8])
  })

  it('ignores a non-finite sample instead of poisoning the window', () => {
    // `performance.memory` is absent outside Chromium and a frame delta is NaN
    // on the first frame of a resumed tab. One of those reaching `min` would
    // make every statistic in the panel read NaN until a reload.
    const series = fill([10, Number.NaN, 20, Number.POSITIVE_INFINITY, 30], 8)
    const stats = series.summarise()
    expect(stats.count).toBe(3)
    expect(stats.mean).toBe(20)
    expect(stats.last).toBe(30)
  })

  it('reports zeroes rather than infinities when empty', () => {
    // The panel renders before the first frame is sampled. `Math.min()` of
    // nothing is Infinity, and an overlay opening on "min Infinity ms" reads as
    // a bug in the thing being measured.
    expect(new Series(16).summarise()).toEqual({
      count: 0,
      last: 0,
      min: 0,
      max: 0,
      mean: 0,
      p95: 0,
    })
  })
})
