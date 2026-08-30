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
 * slow" and gets back *"9 of 61 frames over 25 ms; terrain.select dominated 7
 * of them at 8.4 ms mean"* rather than a screenshot and a p95.
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
 * the same reason `now` is on `SimulationHost`: `setTimeout` is a DOM or Node
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
   * should colour the plot, the trace entry *and* this report.
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
export function makeTimingVerb(port: () => TimingPort | undefined): TimingVerb {
  const verb = (level?: string): string => {
    const held = port()
    if (held === undefined) return 'off'
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
   * Read per track, never summed across them. The Engine phases tile the frame
   * and the Terrain phases tile the Engine's `terrain` phase, so one sum over
   * everything counts the streamer twice — which is exactly the arithmetic that
   * makes a flame chart lie.
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
   */
  readonly shareOfFrame: number | null
}

export interface LateFrame {
  readonly startMs: number
  readonly durationMs: number
  /** The longest single span that started inside this frame. */
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
 * describes them. A hair of tolerance because the clock steps in 100 µs and two
 * adjacent entries on one thread legitimately share a boundary reading.
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
  const droppedFrameMs = options.droppedFrameMs ?? 25
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
   * space — `queue universe.generateHeightfield`, `warming surface maps`,
   * `advance ×2 @1.00×` — so a split on one reports a span called `queue` and
   * throws the rest of its name away.
   */
  const buckets = new Map<string, Bucket>()
  const keyOf = (entry: TimingEntry): string => `${entry.track} ${entry.name}`
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
      shareOfFrame:
        frameTotal > 0 && !overlaps(held.spans)
          ? held.totalMs / frameTotal
          : null,
    })
  }
  spans.sort((a, b) => b.totalMs - a.totalMs)

  /*
   * Which span dominated each late frame.
   *
   * "Inside" is containment of the start, which is enough because the phases
   * tile the frame and none of them straddles its edge. The frame's own entry
   * is skipped, or every late frame would be dominated by itself.
   *
   * The scan is over a start-sorted copy and breaks at the frame's end, so this
   * is linear in the entries inside a late frame rather than in the window —
   * a profile with thousands of entries and a handful of late frames does not
   * become quadratic.
   */
  const sorted = [...measures].sort((a, b) => a.startMs - b.startMs)
  const late: LateFrame[] = []
  for (const frame of frames) {
    if (frame.durationMs <= droppedFrameMs) continue
    const end = frame.startMs + frame.durationMs
    let dominatedBy: string | null = null
    let dominatorMs = 0
    for (const entry of sorted) {
      if (entry.startMs < frame.startMs) continue
      if (entry.startMs >= end) break
      if (entry.name === frameSpan) continue
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
 * It names the dominating span *and its mean over the frames it dominated*,
 * rather than its mean over the whole window — a span that is cheap on average
 * and catastrophic four times is exactly the case a mean hides, and the reason
 * this report exists at all.
 */
function verdictFor(
  late: readonly LateFrame[],
  droppedFrameMs: number,
  frames: number,
): string {
  if (frames === 0) return 'no frames in the window'
  if (late.length === 0)
    return `${frames} frames, none over ${droppedFrameMs} ms`
  const byName = new Map<string, number[]>()
  for (const one of late) {
    if (one.dominatedBy === null) continue
    const held = byName.get(one.dominatedBy) ?? []
    held.push(one.dominatorMs)
    byName.set(one.dominatedBy, held)
  }
  const worst = [...byName.entries()].sort((a, b) => b[1].length - a[1].length)
  const found = worst[0]
  if (found === undefined)
    return `${late.length} of ${frames} frames over ${droppedFrameMs} ms, with no span inside them`
  const [name, samples] = found
  const mean = samples.reduce((sum, one) => sum + one, 0) / samples.length
  return (
    `${late.length} of ${frames} frames over ${droppedFrameMs} ms; ` +
    `${name} dominated ${samples.length} of them at ${mean.toFixed(1)} ms mean`
  )
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
