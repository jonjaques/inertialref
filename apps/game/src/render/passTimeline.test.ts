import { describe, expect, it } from 'vitest'
import { summarize } from './passTimeline.ts'

/** Nanosecond slots from millisecond pairs, in allocation order. */
function slots(pairs: readonly (readonly [number, number])[]): BigUint64Array {
  return BigUint64Array.from(
    pairs.flatMap(([begin, end]) => [BigInt(begin * 1e6), BigInt(end * 1e6)]),
  )
}

describe('summarize', () => {
  it('averages per frame, orders by the GPU, and prices the gaps', () => {
    const pending = [
      { label: 'scene', kind: 'render', frame: 0, slot: 0 },
      { label: 'scene after copy', kind: 'render', frame: 0, slot: 2 },
      { label: 'canvas', kind: 'render', frame: 0, slot: 4 },
      { label: 'scene', kind: 'render', frame: 1, slot: 6 },
      { label: 'scene after copy', kind: 'render', frame: 1, slot: 8 },
      { label: 'canvas', kind: 'render', frame: 1, slot: 10 },
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
    expect(result.spanMs).toBeCloseTo(9.2, 9)
    expect(result.busyMs).toBeCloseTo(6.7, 9)
    expect(result.gaps.map((g) => [g.after, g.before, g.ms])).toEqual([
      ['scene after copy', 'canvas', 2],
      ['scene', 'scene after copy', 0.5],
    ])
    expect(result.wallMs).toBe(9)
  })

  it('reports an overlap as a negative gap', () => {
    const pending = [
      { label: 'scene', kind: 'render', frame: 0, slot: 0 },
      { label: 'canvas', kind: 'render', frame: 0, slot: 2 },
    ] as const
    const result = summarize(
      pending,
      slots([
        [1, 5],
        [4, 6],
      ]),
      1,
      5,
      0,
    )
    expect(result.busyMs).toBeCloseTo(6, 9)
    expect(result.spanMs).toBeCloseTo(5, 9)
    expect(result.gaps).toEqual([{ after: 'scene', before: 'canvas', ms: -1 }])
  })

  it('leaves out a pass whose slots were never written', () => {
    const pending = [
      { label: 'scene', kind: 'render', frame: 0, slot: 0 },
      { label: 'lost', kind: 'compute', frame: 0, slot: 2 },
    ] as const
    const times = BigUint64Array.from([1_000_000n, 2_000_000n, 0n, 0n])
    const result = summarize(pending, times, 1, 1, 0)
    expect(result.passes.map((p) => p.label)).toEqual(['scene'])
    expect(result.gaps).toEqual([])
  })
})
