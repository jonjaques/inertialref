import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  equalPowerCurve,
  type FadeParam,
  scheduleFade,
  transitionSeconds,
} from './crossfade.ts'

/** A param that records what it was told, in order. */
function recording(value: number, hold = true) {
  const calls: (readonly [string, ...unknown[]])[] = []
  const param: FadeParam = {
    value,
    cancelScheduledValues: (time) => calls.push(['cancel', time]),
    setValueAtTime: (to, time) => calls.push(['set', to, time]),
    setValueCurveAtTime: (curve, time, duration) =>
      calls.push(['curve', [...curve], time, duration]),
    ...(hold
      ? { cancelAndHoldAtTime: (time: number) => calls.push(['hold', time]) }
      : {}),
  }
  return { param, calls }
}

describe('equalPowerCurve', () => {
  /*
   * The property the whole module is for: an outgoing fade and an incoming
   * one over the same span keep the summed power of two unrelated signals at
   * one. A linear crossfade fails this by 3 dB at the midpoint.
   */
  it('keeps the summed power of a crossfade at one throughout', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 2_000 }), (points) => {
        const outgoing = equalPowerCurve(1, 0, points)
        const incoming = equalPowerCurve(0, 1, points)
        for (let i = 0; i < points; i += 1) {
          expect(outgoing[i]! ** 2 + incoming[i]! ** 2).toBeCloseTo(1, 5)
        }
      }),
    )
  })

  it('starts where it is asked to and ends exactly on the target', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 2, max: 500 }),
        (from, to, points) => {
          const curve = equalPowerCurve(from, to, points)
          expect(curve).toHaveLength(points)
          expect(curve[0]).toBeCloseTo(from, 5)
          expect(curve.at(-1)).toBe(Math.fround(to))
        },
      ),
    )
  })

  it('never leaves the range between its ends', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (from, to) => {
          const low = Math.min(from, to) - 1e-6
          const high = Math.max(from, to) + 1e-6
          for (const value of equalPowerCurve(from, to, 64)) {
            expect(value).toBeGreaterThanOrEqual(low)
            expect(value).toBeLessThanOrEqual(high)
          }
        },
      ),
    )
  })

  it('is monotonic', () => {
    const rising = equalPowerCurve(0.2, 0.9, 100)
    for (let i = 1; i < rising.length; i += 1) {
      expect(rising[i]).toBeGreaterThanOrEqual(rising[i - 1]!)
    }
  })
})

describe('scheduleFade', () => {
  it('holds the present value, then lays the curve from it', () => {
    const { param, calls } = recording(0.5)
    scheduleFade(param, 0, 2, 10)
    expect(calls[0]).toEqual(['hold', 10])
    const curve = calls[1]!
    expect(curve[0]).toBe('curve')
    expect(curve[2]).toBe(10)
    expect(curve[3]).toBe(2)
    const values = curve[1] as number[]
    expect(values[0]).toBeCloseTo(0.5, 5)
    expect(values.at(-1)).toBe(0)
  })

  it('cancels and re-sets the value where it cannot hold', () => {
    // Firefox before 136 has no `cancelAndHoldAtTime`.
    const { param, calls } = recording(0.25, false)
    scheduleFade(param, 1, 1, 3)
    expect(calls.slice(0, 2)).toEqual([
      ['cancel', 3],
      ['set', 0.25, 3],
    ])
    expect(calls[2]![0]).toBe('curve')
  })

  it('cuts rather than fades over no time', () => {
    const { param, calls } = recording(1)
    scheduleFade(param, 0, 0, 4)
    expect(calls).toEqual([
      ['hold', 4],
      ['set', 0, 4],
    ])
  })
})

describe('transitionSeconds', () => {
  it('never takes more than half the incoming track or what is left of the outgoing', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 20, noNaN: true }),
        fc.double({ min: 0, max: 600, noNaN: true }),
        fc.double({ min: 0, max: 600, noNaN: true }),
        (preferred, left, length) => {
          const seconds = transitionSeconds(preferred, left, length)
          expect(seconds).toBeGreaterThanOrEqual(0)
          expect(seconds).toBeLessThanOrEqual(preferred + 1e-9)
          expect(seconds).toBeLessThanOrEqual(left + 1e-9)
          expect(seconds).toBeLessThanOrEqual(length / 2 + 1e-9)
        },
      ),
    )
  })

  it('caps a skip at the skip’s own length', () => {
    expect(transitionSeconds(8, 200, 300, 1.5)).toBe(1.5)
    expect(transitionSeconds(1, 200, 300, 1.5)).toBe(1)
  })
})
