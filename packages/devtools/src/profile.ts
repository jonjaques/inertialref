import type { TimingKind } from '@inertialref/shared'
import { Series } from './metrics.ts'

/*
 * Turning a pile of timeline entries into an answer.
 *
 * The aggregation lives here and the hub lives in `packages/shared` at layer 0,
 * which is layer-legal and also right: `metrics.ts`'s own header says
 * arithmetic belongs where Node can test it, and *what* to sample belongs to
 * the host. `Series` is reused rather than reinvented — nearest-rank p95 over a
 * few hundred samples is exactly what it is for, and it is already the
 * statistic the performance panel reports and the reason it reports it.
 *
 * The deliverable is the last line of the report. An agent asks "why is it
 * slow" and gets back *"9 of 61 frames over 25 ms; terrain.select was the
 * largest measured span in 7 of them, 8.4 ms of 31.0 ms"* rather than a
 * screenshot and a p95.
 */

/** One entry, read back off a timeline. Plain data, so it survives a `--js`. */
export interface TimingEntry {
  readonly name: string
  readonly kind: TimingKind
  readonly track: string
  readonly startMs: number
  readonly durationMs: number
  readonly properties: Readonly<Record<string, string>>
}

/**
 * What a host has to be able to do for `ir.timing` and `ir.profile` to work.
 *
 * A port for the usual reason — `console.timeStamp` and `performance.measure`
 * are host globals whose types are not in scope here — and `wait` is on it for
 * the same reason `now` is on `Host`: `setTimeout` is a DOM or Node
 * facility and `packages/*` pulls in neither library.
 */
export interface TimingPort {
  /** The current level, by name. The vocabulary is the host's. */
  level(): string
  setLevel(level: string): void
  /** Tracks this session has actually emitted onto, not tracks it declares. */
  tracks(): readonly string[]
  /** Plant a marker mid-script, so an agent can bracket its own steps. */
  mark(name: string): void
  /** Retained entries, cleared by name on the way out. */
  drain(): readonly TimingEntry[]
  /** Wall-clock delay, for `profile`'s recording window. */
  wait(ms: number): Promise<void>
  /**
   * Where a frame stops being jitter and becomes a dropped frame.
   *
   * Taken from the host rather than defaulted here, because the whole point of
   * moving it out of `PerfPanel.tsx` was that one definition of over-budget
   * should color the plot, the trace entry *and* this report.
   */
  readonly droppedFrameMs: number
}

/**
 * `ir.timing` — a callable that also carries the rest of the verbs.
 *
 * Callable because `ir.timing('trace')` is what anybody types, and a
 * `setLevel`/`getLevel` pair on a namespace would be two names for the one
 * switch this whole design exists to keep singular.
 */
export interface TimingVerb {
  (level?: string): string
  tracks(): readonly string[]
  mark(name: string): void
  drain(): readonly TimingEntry[]
}

/**
 * Build the verb over a port that may not exist yet.
 *
 * The port is resolved per call rather than captured, because the host supplies
 * it through a getter and a session can replace what is underneath.
 */
export function makeTimingVerb(port: () => TimingPort | null): TimingVerb {
  const verb = (level?: string): string => {
    const held = port()
    if (held === null) return 'off'
    if (level !== undefined) held.setLevel(level)
    return held.level()
  }
  verb.tracks = (): readonly string[] => port()?.tracks() ?? []
  verb.mark = (name: string): void => port()?.mark(name)
  verb.drain = (): readonly TimingEntry[] => port()?.drain() ?? []
  return verb
}

export interface SpanSummary {
  readonly track: string
  readonly name: string
  readonly count: number
  readonly totalMs: number
  readonly meanMs: number
  readonly p95Ms: number
  readonly maxMs: number
  /**
   * This span's total as a fraction of the frame track's total, or `null` where
   * that fraction is not a share of anything.
   *
   * Read per track, never summed across them. The Engine phases tile the
   * `engine` step and the Terrain phases tile the Engine's `terrain` phase, so
   * one sum over everything counts the streamer twice — which is exactly the
   * arithmetic that makes a flame chart lie. `frame` is the denominator and not
   * a member of either set: it is the wall-clock period the whole tiling sits
   * inside, and it is much the larger of the two — 17.9 ms against a 4.4 ms
   * `engine` on the summit recording, so the phases account for a quarter of it
   * and the rest is the GPU and the compositor, which nothing here measures.
   *
   * **Null when the span's own occurrences overlap each other.** A worker job's
   * queue wait runs concurrently with every other job's and with the frames it
   * spans, so its total divided by the frame total is a real ratio and a
   * meaningless share — it came out at 58,767% on a saturated pool, which is a
   * number that reads as a bug rather than as a fact about concurrency. The
   * overlap test is what separates the tracks that tile a serial timeline from
   * the ones that describe other threads, and it is empirical rather than a
   * list of track names, so a track added later is classified correctly without
   * anybody remembering to.
   *
   * **Null, too, when the total exceeds all the frame time in the window.** A
   * span that occurs once has nothing to overlap, so the test above passes it
   * — and `navigation to first light` is one entry covering the whole boot,
   * which printed 320%. A contained serial span cannot exceed 100% by
   * construction, so the ceiling is the definition rather than a heuristic.
   */
  readonly shareOfFrame: number | null
}

export interface LateFrame {
  readonly startMs: number
  readonly durationMs: number
  /**
   * The longest span wholly *contained* in this frame, or null.
   *
   * Contained rather than overlapping, because the pool times a worker job
   * from dispatch to answer on the page's clock — so a 50 ms heightfield
   * starts inside a 42 ms frame, was the longest thing found there, and got
   * named as the cause of a frame it ran on another thread from.
   */
  readonly dominatedBy: string | null
  readonly dominatorMs: number
}

export interface ProfileReport {
  readonly entries: number
  readonly frames: number
  readonly windowMs: number
  readonly tracks: readonly string[]
  readonly spans: readonly SpanSummary[]
  readonly late: readonly LateFrame[]
  /** The one sentence the whole report exists to be able to say. */
  readonly verdict: string
  readonly text: string
}

export interface ProfileOptions {
  /** The entry that *is* a frame. Everything else is measured against it. */
  readonly frameSpan?: string
  readonly droppedFrameMs?: number
  /** How many rows the text block carries. The rest are still in `spans`. */
  readonly top?: number
}

/**
 * Where a frame stops being jitter, for a caller that supplies no budget.
 *
 * A named mirror of `DROPPED_FRAME_MS` in `apps/game/src/engine/perfBudgets.ts`,
 * which layer order forbids importing — `packages/devtools` is layer 6 and
 * `apps/` is above it. A bare `?? 25` four lines under a docstring saying the
 * number is *not* defaulted here is the "one constant instead of two that must
 * agree" shape, leaving the smaller twin unnamed and unfindable. Every browser
 * caller passes `TimingPort.droppedFrameMs`; the headless runner passes this,
 * by name, so a grep for one finds the other.
 */
export const DEFAULT_DROPPED_FRAME_MS = 25

const EMPTY: ProfileReport = {
  entries: 0,
  frames: 0,
  windowMs: 0,
  tracks: [],
  spans: [],
  late: [],
  verdict: 'nothing was recorded',
  text: 'nothing was recorded — is the timing level `full`?',
}

interface Bucket {
  readonly track: string
  readonly name: string
  count: number
  totalMs: number
  series: Series | null
  /** Start/end pairs, kept only to answer "do these overlap each other". */
  readonly spans: { start: number; end: number }[]
}

/**
 * Whether a span's own occurrences ever run at the same time.
 *
 * Sorted by start, then one pass: any entry beginning before its predecessor
 * ends means these are concurrent, and no fraction of a serial timeline
 * describes them.
 *
 * The tolerance is an ULP guard, not a clock-quantum one — a distinction worth
 * keeping, because the quantum reading argues for widening it to ~0.1 ms, which
 * would start hiding real sub-100 µs concurrency. A `PhaseClock` boundary is
 * bit-identical on both sides: `step` emits `measure(name, #at, at)` and then
 * assigns `#at = at`, the same double. What is not identical is a boundary that
 * has been through a trace: `scripts/timing.mjs` derives `startMs` and
 * `durationMs` from separate microsecond fields, so `start + duration`
 * reconstructs the neighbor's start to within a rounding error and a bare
 * `<` would call two tiling phases concurrent.
 */
function overlaps(spans: { start: number; end: number }[]): boolean {
  if (spans.length < 2) return false
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]
    const current = sorted[i]
    if (previous === undefined || current === undefined) continue
    if (current.start < previous.end - 1e-6) return true
  }
  return false
}

/**
 * Aggregate a window of entries into something a terminal can print.
 *
 * Pure, so `pnpm sim` and the browser produce the same report from the same
 * numbers, and so the arithmetic has a test that needs no host at all.
 */
export function summarizeProfile(
  entries: readonly TimingEntry[],
  options: ProfileOptions = {},
): ProfileReport {
  const frameSpan = options.frameSpan ?? 'frame'
  const droppedFrameMs = options.droppedFrameMs ?? DEFAULT_DROPPED_FRAME_MS
  const top = options.top ?? 16
  const measures = entries.filter((entry) => entry.kind === 'measure')
  if (measures.length === 0) return EMPTY

  /*
   * A `Series` per span, sized to what that span actually holds.
   *
   * `Series` is a fixed-capacity ring, so a capacity below the sample count
   * would silently report the statistics of the tail. Counting first and
   * allocating exactly costs one extra pass over an array already in memory,
   * and it is the difference between a p95 and a p95 of the last 240.
   *
   * The bucket carries its own track and name rather than being keyed on a
   * joined string that is split apart again. Half the names here contain a
   * space — `queue universe.generateHeightfield`, `run universe.surveyRegion`,
   * `warming surface maps` — so a split on one reports a span called `queue`
   * and throws the rest of its name away.
   */
  const buckets = new Map<string, Bucket>()
  const keyOf = (entry: TimingEntry): string =>
    `${entry.track}\u0000${entry.name}`
  for (const entry of measures) {
    const key = keyOf(entry)
    const held = buckets.get(key) ?? {
      track: entry.track,
      name: entry.name,
      count: 0,
      totalMs: 0,
      series: null,
      spans: [],
    }
    held.count += 1
    buckets.set(key, held)
  }
  for (const held of buckets.values()) held.series = new Series(held.count)
  for (const entry of measures) {
    const held = buckets.get(keyOf(entry))
    if (held === undefined) continue
    held.series?.push(entry.durationMs)
    held.totalMs += entry.durationMs
    held.spans.push({
      start: entry.startMs,
      end: entry.startMs + entry.durationMs,
    })
  }

  const frames = measures.filter((entry) => entry.name === frameSpan)
  const frameTotal = frames.reduce((sum, one) => sum + one.durationMs, 0)

  const spans: SpanSummary[] = []
  for (const held of buckets.values()) {
    const stats = held.series?.summarise()
    spans.push({
      track: held.track,
      name: held.name,
      count: held.count,
      totalMs: held.totalMs,
      meanMs: stats?.mean ?? 0,
      p95Ms: stats?.p95 ?? 0,
      maxMs: stats?.max ?? 0,
      /*
       * Null unless this really is a share of something.
       *
       * Two ways it is not, and the second was found printing 320%. A span
       * whose occurrences overlap each other is concurrent — four worker jobs
       * at once total four times the wall clock they occupy. And a span whose
       * total *exceeds* all the frame time in the window was not inside those
       * frames at all: `navigation to first light` is one entry covering the
       * whole boot, so `overlaps` returns false at `spans.length < 2` and the
       * division went ahead on a numerator that had nothing to do with the
       * denominator.
       *
       * A contained serial span cannot exceed 100% by construction, so the
       * ceiling is not a heuristic — it is the definition, and it catches the
       * single-occurrence case the overlap test structurally cannot see.
       */
      shareOfFrame:
        frameTotal > 0 && !overlaps(held.spans) && held.totalMs <= frameTotal
          ? held.totalMs / frameTotal
          : null,
    })
  }
  spans.sort((a, b) => b.totalMs - a.totalMs)

  /*
   * Which span dominated each late frame.
   *
   * "Inside" is containment of *both* ends, for the reason written at the
   * `continue` that enforces it: a start-only test names work that ran on
   * another thread. The frame's own entry is skipped, or every late frame would
   * be dominated by itself.
   *
   * **A cursor, not a rescan.** The `break` bounds the tail and nothing bounded
   * the head: starting each frame at `sorted[0]` and `continue`-ing past every
   * earlier entry is linear in the *window*, so the pass was quadratic in the
   * one case it is reached — a recording long enough and bad enough to profile.
   * `--group all` over a DevTools export is hundreds of thousands of entries
   * against hundreds of late frames. Both sequences are sorted by start, so one
   * index that only moves forward makes the whole pass linear.
   */
  const sorted = [...measures].sort((a, b) => a.startMs - b.startMs)
  const lateFrames = frames
    .filter((frame) => frame.durationMs > droppedFrameMs)
    .sort((a, b) => a.startMs - b.startMs)
  const late: LateFrame[] = []
  let cursor = 0
  for (const frame of lateFrames) {
    const end = frame.startMs + frame.durationMs
    while (
      cursor < sorted.length &&
      (sorted[cursor]?.startMs ?? Infinity) < frame.startMs
    )
      cursor += 1
    let dominatedBy: string | null = null
    let dominatorMs = 0
    for (let i = cursor; i < sorted.length; i += 1) {
      const entry = sorted[i]
      if (entry === undefined) break
      if (entry.startMs >= end) break
      if (entry.name === frameSpan) continue
      /*
       * Contained, not merely overlapping — both ends inside the frame.
       *
       * A worker job is the case that forces this. The pool times `run` from
       * dispatch to answer on the page's clock, so a 50 ms heightfield
       * legitimately *starts* inside a 42 ms frame and was, before this, the
       * longest thing found there: the verdict read "run
       * universe.generateHeightfield dominated 14 of them at 49.7 ms mean" for
       * a span that ran on another thread and cannot be on a frame's critical
       * path. The saturated pool is a real correlate of those late frames and
       * "dominated" is the wrong word for it.
       *
       * Anything genuinely on the critical path — an engine phase, a `useFrame`
       * consumer, the engine step itself — is contained by construction, so
       * this costs nothing it should have kept. A frame with no contained span
       * gets `null`, which is the honest answer that nothing measured here
       * explains it.
       */
      if (entry.startMs + entry.durationMs > end) continue
      if (entry.durationMs > dominatorMs) {
        dominatorMs = entry.durationMs
        dominatedBy = entry.name
      }
    }
    late.push({
      startMs: frame.startMs,
      durationMs: frame.durationMs,
      dominatedBy,
      dominatorMs,
    })
  }

  // A loop rather than `Math.max(...ends)`: a long recording is tens of
  // thousands of entries and a spread that long overflows the argument list.
  let earliest = Infinity
  let latest = -Infinity
  for (const entry of measures) {
    earliest = Math.min(earliest, entry.startMs)
    latest = Math.max(latest, entry.startMs + entry.durationMs)
  }

  const verdict = verdictFor(late, droppedFrameMs, frames.length)
  return {
    entries: entries.length,
    frames: frames.length,
    windowMs: latest - earliest,
    tracks: [...new Set(measures.map((entry) => entry.track))].sort(),
    spans,
    late,
    verdict,
    text: render(spans, late, verdict, frames.length, latest - earliest, top),
  }
}

/**
 * The deliverable, as one sentence.
 *
 * It names the largest span *inside the late frames*, with its mean over those
 * frames rather than over the whole window — a span that is cheap on average
 * and catastrophic four times is exactly the case a mean hides, and the reason
 * this report exists at all. The frame duration goes beside it, because the
 * ratio is what says whether the name is an explanation.
 */
function verdictFor(
  late: readonly LateFrame[],
  droppedFrameMs: number,
  frames: number,
): string {
  if (frames === 0) return 'no frames in the window'
  if (late.length === 0)
    return `${frames} frames, none over ${droppedFrameMs} ms`
  const byName = new Map<string, LateFrame[]>()
  for (const one of late) {
    if (one.dominatedBy === null) continue
    const held = byName.get(one.dominatedBy) ?? []
    held.push(one)
    byName.set(one.dominatedBy, held)
  }
  const worst = [...byName.entries()].sort((a, b) => b[1].length - a[1].length)
  const found = worst[0]
  if (found === undefined)
    return `${late.length} of ${frames} frames over ${droppedFrameMs} ms, with no span inside them`
  const [name, samples] = found
  const mean =
    samples.reduce((sum, one) => sum + one.dominatorMs, 0) / samples.length
  const of =
    samples.reduce((sum, one) => sum + one.durationMs, 0) / samples.length
  const share = of > 0 ? mean / of : 0
  /*
   * The verdict states its own evidence, because "dominated" is a strong word
   * and the number behind it is often small.
   *
   * Measured on a real recording: `orbitTraces` was the largest span inside
   * seven late frames at 0.7 ms mean — of frames averaging 39 ms. Calling that
   * domination points a reader at 2% of the problem. Everything the GPU does
   * happens after `frame` returns, which `frameMetrics.ts` says in as many
   * words, so a late frame with nothing large inside it is the *expected*
   * shape rather than a gap in the report — and saying so is more useful than
   * naming the biggest of the small things and stopping.
   */
  const claim =
    `${late.length} of ${frames} frames over ${droppedFrameMs} ms; ` +
    `${name} was the largest measured span in ${samples.length} of them, ` +
    `${mean.toFixed(1)} ms of ${of.toFixed(1)} ms`
  return share >= 0.25
    ? claim
    : `${claim} — so most of those frames are outside anything instrumented here`
}

const pad = (value: number, width: number): string =>
  value.toFixed(2).padStart(width)

function render(
  spans: readonly SpanSummary[],
  late: readonly LateFrame[],
  verdict: string,
  frames: number,
  windowMs: number,
  top: number,
): string {
  const lines = [
    `${frames} frames over ${(windowMs / 1000).toFixed(2)} s`,
    '',
    `${'track/span'.padEnd(34)}${'n'.padStart(6)}${'mean'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}${'share'.padStart(8)}`,
  ]
  for (const span of spans.slice(0, top)) {
    lines.push(
      `${`${span.track}/${span.name}`.slice(0, 33).padEnd(34)}` +
        `${String(span.count).padStart(6)}` +
        `${pad(span.meanMs, 9)}${pad(span.p95Ms, 9)}${pad(span.maxMs, 9)}` +
        // An em dash where a share is undefined, never a number: these are
        // concurrent with each other and with the frames they cross, so the
        // ratio exists and describes nothing.
        `${(span.shareOfFrame === null ? '—' : `${(span.shareOfFrame * 100).toFixed(0)}%`).padStart(8)}`,
    )
  }
  if (spans.length > top) lines.push(`… ${spans.length - top} more`)
  lines.push('', verdict)
  // The worst few by duration, because "which frames" is the follow-up question
  // and a hundred rows is a table nobody reads.
  const worst = [...late]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
  for (const one of worst) {
    lines.push(
      `  ${one.startMs.toFixed(0)}ms  ${one.durationMs.toFixed(1)} ms  ` +
        `${one.dominatedBy ?? '—'} ${one.dominatorMs.toFixed(1)} ms`,
    )
  }
  return lines.join('\n')
}
