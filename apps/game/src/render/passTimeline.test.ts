import { describe, expect, it } from 'vitest'
import { summarize } from './passTimeline.ts'

/** Nanosecond slots from millisecond pairs, in allocation order. */
function slots(pairs: readonly (readonly [number, number])[]): BigUint64Array {
  return BigUint64Array.from(
    pairs.flatMap(([begin, end]) => [BigInt(begin * 1e6), BigInt(end * 1e6)]),
  )
}

describe('summarize', () => {
  it('averages per frame, charges each pass its advance, and prices the gaps', () => {
    const pending = [
      { label: 'scene', kind: 'render', slot: 0 },
      { label: 'scene after copy', kind: 'render', slot: 2 },
      { label: 'canvas', kind: 'render', slot: 4 },
      { label: 'scene', kind: 'render', slot: 6 },
      { label: 'scene after copy', kind: 'render', slot: 8 },
      { label: 'canvas', kind: 'render', slot: 10 },
    ] as const
    const times = slots([
      [10, 14],
      [14.5, 16],
      [18, 18.2],
      [30, 36],
      [36.5, 38],
      [40, 40.2],
    ])
    const result = summarize(pending, times, 2, 9, 0)
    expect(result.passes.map((p) => [p.label, p.count, p.ms])).toEqual([
      ['scene', 1, 5],
      ['scene after copy', 1, 1.5],
      ['canvas', 1, expect.closeTo(0.2, 9)],
    ])
    expect(result.busyMs).toBeCloseTo(6.7, 9)
    expect(result.spanMs).toBeCloseTo(15.1, 9)
    expect(result.gaps.map((g) => [g.after, g.before, g.ms])).toEqual([
      ['canvas', 'scene', expect.closeTo(5.9, 9)],
      ['scene after copy', 'canvas', 2],
      ['scene', 'scene after copy', 0.5],
    ])
    expect(result.wallMs).toBe(9)
  })

  /*
   * The shape a tiled GPU reports: every pair spans most of the frame. The
   * raw pairs sum to three times the busy time; the shares sum to it.
   */
  it('charges overlapping passes their advance, not their latency', () => {
    const pending = [
      { label: 'scene', kind: 'render', slot: 0 },
      { label: 'blur', kind: 'render', slot: 2 },
      { label: 'canvas', kind: 'render', slot: 4 },
    ] as const
    const result = summarize(
      pending,
      slots([
        [1, 8],
        [1.5, 9],
        [2, 10],
      ]),
      1,
      9,
      0,
    )
    expect(result.passes.map((p) => [p.label, p.ms, p.latencyMs])).toEqual([
      ['scene', 7, 7],
      ['blur', 1, 7.5],
      ['canvas', 1, 8],
    ])
    expect(result.busyMs).toBe(9)
    expect(result.spanMs).toBe(9)
    expect(result.gaps).toEqual([])
  })

  it('keeps the head start of a long pass that ends after a short one', () => {
    const pending = [
      { label: 'long', kind: 'render', slot: 0 },
      { label: 'short', kind: 'render', slot: 2 },
    ] as const
    const result = summarize(
      pending,
      slots([
        [1, 10],
        [2, 3],
      ]),
      1,
      9,
      0,
    )
    expect(result.busyMs).toBe(9)
    expect(result.passes.map((p) => [p.label, p.ms])).toEqual([
      ['long', 7],
      ['short', 2],
    ])
  })

  it('leaves out a pass whose slots were never written', () => {
    const pending = [
      { label: 'scene', kind: 'render', slot: 0 },
      { label: 'lost', kind: 'compute', slot: 2 },
    ] as const
    const times = BigUint64Array.from([1_000_000n, 2_000_000n, 0n, 0n])
    const result = summarize(pending, times, 1, 1, 0)
    expect(result.passes.map((p) => p.label)).toEqual(['scene'])
    expect(result.gaps).toEqual([])
  })

  /*
   * A query set keeps its values between submissions, so on a second run an
   * unwritten slot holds the first run's timestamps. Counted, they would
   * stretch the span across the idle time between the two runs.
   */
  it('leaves out a pass whose slots still hold an earlier run', () => {
    const pending = [
      { label: 'scene', kind: 'render', slot: 0 },
      { label: 'lost', kind: 'render', slot: 2 },
    ] as const
    const times = slots([
      [5000, 5004],
      [10, 11],
    ])
    const result = summarize(pending, times, 1, 4, 0, BigInt(4000 * 1e6))
    expect(result.passes.map((p) => p.label)).toEqual(['scene'])
    expect(result.spanMs).toBe(4)
    expect(result.gaps).toEqual([])
  })
})
