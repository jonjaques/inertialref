import { describe, expect, it } from 'vitest'
import {
  makeTimingVerb,
  summarizeProfile,
  type TimingEntry,
} from './profile.ts'

/*
 * The report's arithmetic, in Node, with no host at all — which is the reason
 * it lives in this package rather than in the app. Every number below is chosen
 * so the right answer is obvious by hand.
 */

const measure = (
  name: string,
  track: string,
  startMs: number,
  durationMs: number,
): TimingEntry => ({
  name,
  kind: 'measure',
  track,
  startMs,
  durationMs,
  properties: {},
})

/** Serial frames, each decomposed into two phases that tile it exactly. */
const tiled = (frames: number, heavyMs: number, lightMs: number) => {
  const entries: TimingEntry[] = []
  for (let i = 0; i < frames; i += 1) {
    const at = i * 16
    entries.push(measure('frame', 'Engine', at, heavyMs + lightMs))
    entries.push(measure('heavy', 'Engine', at, heavyMs))
    entries.push(measure('light', 'Engine', at + heavyMs, lightMs))
  }
  return entries
}

describe('the profile report', () => {
  it('says nothing was recorded rather than reporting a fast session', () => {
    // An empty report that read "0 frames, none over 25 ms" would be a
    // performance tool answering "it is fine" when it was switched off.
    const report = summarizeProfile([])
    expect(report.frames).toBe(0)
    expect(report.text).toMatch(/nothing was recorded/)
  })

  it('gives each span its own share of frame time, summing to the whole', () => {
    const report = summarizeProfile(tiled(10, 6, 4))
    const heavy = report.spans.find((span) => span.name === 'heavy')
    const light = report.spans.find((span) => span.name === 'light')
    expect(heavy?.shareOfFrame).toBeCloseTo(0.6, 10)
    expect(light?.shareOfFrame).toBeCloseTo(0.4, 10)
    // The property the tiling exists for: the phases account for the frame.
    expect((heavy?.shareOfFrame ?? 0) + (light?.shareOfFrame ?? 0)).toBeCloseTo(
      1,
      10,
    )
  })

  it('refuses a share for spans that overlap each other', () => {
    /*
     * Four worker jobs running at once. Their total is four times the wall
     * clock they occupy, so a fraction of frame time is a real ratio and a
     * meaningless share — it came out at 58,767% on a saturated pool before
     * this, which reads as a bug rather than as a fact about concurrency.
     */
    const entries = [
      measure('frame', 'Engine', 0, 5),
      measure('run', 'Workers', 0, 40),
      measure('run', 'Workers', 1, 40),
      measure('run', 'Workers', 2, 40),
      measure('run', 'Workers', 3, 40),
    ]
    const report = summarizeProfile(entries)
    expect(report.spans.find((span) => span.name === 'run')?.shareOfFrame).toBe(
      null,
    )
    // And the serial one still gets a share.
    expect(
      report.spans.find((span) => span.name === 'frame')?.shareOfFrame,
    ).toBe(1)
    expect(report.text).toMatch(/—/)
  })

  it('names the span that dominated the late frames, not the busiest overall', () => {
    /*
     * The whole deliverable. `steady` is the largest total in the window by a
     * wide margin and is never the problem; `rare` fires three times and is
     * what a viewer actually felt. A mean over the window reports `steady`,
     * which is the failure mode this report exists to fix.
     */
    const entries: TimingEntry[] = []
    for (let i = 0; i < 100; i += 1) {
      const at = i * 16
      const late = i % 33 === 0
      entries.push(measure('frame', 'Engine', at, late ? 40 : 5))
      entries.push(measure('steady', 'Engine', at, 5))
      if (late) entries.push(measure('rare', 'Engine', at + 5, 34))
    }
    const report = summarizeProfile(entries, { droppedFrameMs: 25 })
    expect(report.late).toHaveLength(4)
    expect(report.verdict).toBe(
      '4 of 100 frames over 25 ms; rare dominated 4 of them at 34.0 ms mean',
    )
    // `steady` has five times the total, and is correctly not the answer.
    const steady = report.spans.find((span) => span.name === 'steady')
    const rare = report.spans.find((span) => span.name === 'rare')
    expect((steady?.totalMs ?? 0) > (rare?.totalMs ?? 0)).toBe(true)
  })

  it('keeps a name that contains a space whole', () => {
    // Half the labels in this project have one — `queue
    // universe.generateHeightfield`, `warming surface maps`, `advance ×2
    // @1.00×` — and a bucket keyed on `track + ' ' + name` and split apart
    // again reports a span called `queue`.
    const report = summarizeProfile([
      measure('queue universe.generateHeightfield', 'Workers', 0, 9),
    ])
    expect(report.spans[0]?.track).toBe('Workers')
    expect(report.spans[0]?.name).toBe('queue universe.generateHeightfield')
  })

  it('sizes each span its own window, so p95 is over everything it holds', () => {
    // `Series` is a fixed-capacity ring: a capacity below the sample count
    // would silently report the statistics of the tail. 300 samples is past
    // the 240 the panel's window holds, which is where that would first show.
    const entries = Array.from({ length: 300 }, (_, i) =>
      measure('span', 'Engine', i, i),
    )
    const report = summarizeProfile(entries)
    expect(report.spans[0]?.count).toBe(300)
    expect(report.spans[0]?.maxMs).toBe(299)
    // Nearest-rank over all 300, not over the last 240.
    expect(report.spans[0]?.p95Ms).toBe(284)
  })

  it('reports every span while printing only the top rows', () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      measure(`span${i}`, 'Engine', i, 40 - i),
    )
    const report = summarizeProfile(entries, { top: 5 })
    expect(report.spans).toHaveLength(40)
    expect(report.text).toMatch(/… 35 more/)
  })
})

describe('the ir.timing verb', () => {
  it('reads and writes one level, and degrades where a host has none', () => {
    let level = 'off'
    const verb = makeTimingVerb(() => ({
      droppedFrameMs: 25,
      level: () => level,
      setLevel: (next) => {
        level = next
      },
      tracks: () => ['Engine'],
      mark: () => {},
      drain: () => [],
      wait: () => Promise.resolve(),
    }))
    expect(verb()).toBe('off')
    expect(verb('trace')).toBe('trace')
    expect(verb.tracks()).toEqual(['Engine'])

    // A host with no timeline answers rather than throwing: the headless
    // runner has no `console.timeStamp` worth the name and says so.
    const absent = makeTimingVerb(() => undefined)
    expect(absent('full')).toBe('off')
    expect(absent.drain()).toEqual([])
  })
})
