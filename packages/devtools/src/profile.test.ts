import { describe, expect, it } from 'vitest'
import { openSession } from './session.ts'
import type { GameHarness } from './harness.ts'
import {
  makeTimingVerb,
  summarizeProfile,
  type TimingEntry,
  type TimingPort,
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

  it('will not blame a concurrent span that merely started inside a late frame', () => {
    /*
     * The pool times `run` from dispatch to answer on the page's clock, so a
     * long worker job starts inside some frame and outlives it. Before
     * containment was required it was the longest thing the scan found, and a
     * real recording's verdict read "run universe.generateHeightfield dominated
     * 14 of them at 49.7 ms mean" — a span on another thread, named as the
     * cause of a main-thread frame.
     */
    const entries = [
      measure('frame', 'Engine', 0, 40),
      measure('run generateHeightfield', 'Workers', 5, 50), // ends past the frame
      measure('scene', 'Engine', 6, 22), // contained, and the real answer
    ]
    const report = summarizeProfile(entries, { droppedFrameMs: 25 })
    expect(report.late[0]?.dominatedBy).toBe('scene')
    expect(report.late[0]?.dominatorMs).toBe(22)
  })

  it('says so when the largest span inside a late frame explains little of it', () => {
    // Measured shape: `orbitTraces` was the biggest thing inside seven late
    // frames at 0.7 ms of 39. Naming it without the ratio points a reader at
    // 2% of the problem — everything the GPU does happens after `frame`
    // returns, and a late frame with nothing large in it is the expected shape.
    const entries = [
      measure('frame', 'Engine', 0, 40),
      measure('orbitTraces', 'Render', 1, 0.7),
    ]
    const report = summarizeProfile(entries, { droppedFrameMs: 25 })
    expect(report.verdict).toMatch(/0\.7 ms of 40\.0 ms/)
    expect(report.verdict).toMatch(/outside anything instrumented here/)
  })

  it('leaves a late frame unattributed when nothing measured is inside it', () => {
    // GPU time and idle are outside every span here, so `null` is the honest
    // answer rather than the nearest overlapping thing.
    const report = summarizeProfile(
      [measure('frame', 'Engine', 0, 40), measure('run', 'Workers', 5, 50)],
      { droppedFrameMs: 25 },
    )
    expect(report.late[0]?.dominatedBy).toBe(null)
    expect(report.verdict).toMatch(/with no span inside them/)
  })

  it('refuses a share for a span that occurs once and outlasts every frame', () => {
    /*
     * The case the overlap test structurally cannot see: `navigation to first
     * light` is a single entry covering the whole boot, so `spans.length < 2`
     * and `overlaps` returns false. It printed **320%** — a division whose
     * numerator had nothing to do with its denominator.
     *
     * A contained serial span cannot exceed 100%, so the ceiling is the
     * definition rather than a heuristic.
     */
    const report = summarizeProfile([
      measure('frame', 'Engine', 100, 5),
      measure('frame', 'Engine', 116, 5),
      measure('navigation to first light', 'Boot', 0, 8588),
      measure('preload', 'Boot', 441, 1798),
    ])
    const boot = report.spans.find((span) => span.name.startsWith('navigation'))
    expect(boot?.shareOfFrame).toBe(null)
    expect(
      report.spans.find((span) => span.name === 'preload')?.shareOfFrame,
    ).toBe(null)
    // The frames themselves still divide by themselves and come to one.
    expect(
      report.spans.find((span) => span.name === 'frame')?.shareOfFrame,
    ).toBe(1)
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
    // The claim carries its own evidence — 34 of 40 ms is 85%, so it stands
    // without the caveat the small-share case earns.
    expect(report.verdict).toBe(
      '4 of 100 frames over 25 ms; rare was the largest measured span in 4 of them, 34.0 ms of 40.0 ms',
    )
    // `steady` has five times the total, and is correctly not the answer.
    const steady = report.spans.find((span) => span.name === 'steady')
    const rare = report.spans.find((span) => span.name === 'rare')
    expect((steady?.totalMs ?? 0) > (rare?.totalMs ?? 0)).toBe(true)
  })

  it('keeps a name that contains a space whole', () => {
    // Half the labels in this project have one — `queue
    // universe.generateHeightfield`, `run universe.surveyRegion`, `warming
    // surface maps` — and a bucket keyed on `track + ' ' + name` and split
    // apart again reports a span called `queue`.
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

describe('ir.profile, against a fake port', () => {
  /*
   * `summarizeProfile` and `makeTimingVerb` are pure and were the only things
   * covered; `GameHarness.profile` — which arms, records, disarms and reports —
   * had no test at all. What that leaves unchecked is the `finally`, whose own
   * comment calls leaving the level at `full` "the one failure mode a
   * performance tool must not have", and the deliberate placement of
   * `setLevel('full')` *inside* the try so a throw there cannot escape it.
   *
   * The reason it was untested is the recurring one: `openSession()` with no
   * `host` leaves `timing` undefined, so every session in the suite takes the
   * "this host has no performance timeline" branch and never reaches the body.
   */
  const fakePort = (
    overrides: Partial<TimingPort> = {},
  ): TimingPort & { drains: number } => {
    let level = 'off'
    const port = {
      droppedFrameMs: 25,
      drains: 0,
      level: () => level,
      setLevel: (next: string) => {
        level = next
      },
      tracks: () => [],
      mark: () => {},
      drain(): readonly TimingEntry[] {
        port.drains += 1
        // The priming drain returns nothing; the closing one returns a window.
        return port.drains === 1
          ? []
          : [
              measure('frame', 'Engine', 0, 40),
              measure('scene', 'Engine', 1, 30),
            ]
      },
      wait: () => Promise.resolve(),
      ...overrides,
    }
    return port
  }

  const harnessOver = (port: TimingPort): GameHarness =>
    openSession({ workers: null, host: { timing: () => port } }).harness

  it('arms, records, disarms, and reports', async () => {
    const port = fakePort()
    const report = await harnessOver(port).profile(1)
    // Back where it started, not left at `full`.
    expect(port.level()).toBe('off')
    // Twice: once to discard what was already retained, once for the window.
    expect(port.drains).toBe(2)
    expect(report.frames).toBe(1)
    expect(report.verdict).toMatch(/scene was the largest measured span/)
  })

  it('restores the level even when the recording throws', async () => {
    // `setLevel` fans out synchronously in the real port — it attaches a sink,
    // logs, and broadcasts to every worker through `onTimingLevel`. A throw
    // anywhere on that path, or in the wait, must not leave retention on for
    // the rest of the session.
    const port = fakePort({
      wait: () => Promise.reject(new Error('recording interrupted')),
    })
    await expect(harnessOver(port).profile(1)).rejects.toThrow(
      'recording interrupted',
    )
    expect(port.level()).toBe('off')
  })

  it('says a host has no timeline rather than reporting a fast session', async () => {
    // `openSession` with no host leaves `timing` undefined. An empty report
    // reading "0 frames, none over 25 ms" would be the tool answering "it is
    // fine" when it was never able to look.
    const report = await openSession({ workers: null }).harness.profile(1)
    expect(report.verdict).toBe('this host has no performance timeline')
  })
})
