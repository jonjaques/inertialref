import {
  getLogger,
  type TimingDetail,
  type TimingKind,
  type TimingRecord,
  type TimingSink,
  timingHub,
} from '@inertialref/shared'
import { TRACK_GROUP } from './frameTiming.ts'

/*
 * The only file in this application that names `console.timeStamp`,
 * `performance.mark` or `performance.measure`.
 *
 * Two platform APIs sit behind one seam, and they are not two ways to do one
 * thing:
 *
 *   `console.timeStamp` goes into an *active DevTools trace* and nowhere else.
 *   It cannot be read back from JavaScript, it carries label, track, group and
 *   color and nothing more, and when nobody is recording it costs a
 *   disabled-category check. That is the hot path: frames, ticks, patches.
 *
 *   `performance.mark` / `measure` go onto the page's own performance timeline
 *   and are *retained* — `getEntriesByType`, a `PerformanceObserver`,
 *   `ir.timing.drain()` — and carry a properties table and a tooltip. That is
 *   the coarse path: boot, saves, jobs, shots. It allocates and it grows a
 *   buffer.
 *
 * So `timeStamp` is the default and User Timing is the second level, which is
 * what the costs argue for on their own.
 *
 * ## Feature detection cannot be a `typeof`, and that is the trap
 *
 * `console.timeStamp` is ancient and present in every browser and in Node; the
 * four track arguments are a recent Chromium extension. So
 * `typeof console.timeStamp === 'function'` is true on Safari, Firefox and
 * Node, the sink attaches, `timer.on` goes true, and the hot path pays for
 * entries that land nowhere. That is cost with no output — precisely the
 * failure mode a performance tool must not have.
 *
 * There is no capability query for the extension, so **the level is the gate**:
 * `off` is the default everywhere and the only way to pay is to ask. Where the
 * extension is missing the extra arguments are simply ignored, which degrades
 * `trace` to a bare labeled instant — still visible in a recording — while
 * `full` carries the real information, because User Timing is standard
 * everywhere. The `typeof` guard is kept for `performance.mark`/`measure`,
 * where it does mean something.
 */

const log = getLogger('game.timing')

export const TIMING_LEVELS = ['off', 'trace', 'full'] as const

/**
 * How much of itself the session is willing to describe.
 *
 * Three values rather than a boolean, because the two APIs cost differently and
 * the difference is worth being able to choose: `trace` for recording a
 * profile, `full` for a bug report, a `PerformanceObserver`, or anything that
 * has to read the entries back.
 */
export type TimingLevel = (typeof TIMING_LEVELS)[number]

export const isTimingLevel = (value: unknown): value is TimingLevel =>
  typeof value === 'string' && TIMING_LEVELS.includes(value as TimingLevel)

/**
 * The Chromium extension's payload, spelled the way `performance.measure`
 * wants it.
 *
 * Not in TypeScript's DOM lib, so it is declared rather than cast at the call
 * site — a cast there would hide the shape from the one place it is decided.
 */
interface DevToolsTrackEntry {
  dataType: 'track-entry' | 'marker'
  track?: string
  trackGroup?: string
  color?: string
  properties?: (readonly [string, string])[]
  tooltipText?: string
}

/** The extended signature. The four track arguments are Chromium-only. */
type ExtendedTimeStamp = (
  label: string,
  start?: number | string,
  end?: number | string,
  track?: string,
  trackGroup?: string,
  color?: string,
) => void

let level: TimingLevel = 'off'
let detach: (() => void) | null = null

/**
 * Every label this sink has put on the performance timeline, and its kind.
 *
 * Two clearing calls exist and the distinction is load-bearing:
 * `performance.clearMarks()` removes marks and `performance.clearMeasures()`
 * removes measures, so a drain that called one of them would leave behind
 * everything of the other kind. Both clear *everything* when called bare,
 * including entries another tool put there — so neither is ever called bare
 * here, and this is the list of names to pass.
 */
const emitted = new Map<string, TimingKind>()

/**
 * Retained entries since the last drain, and the ceiling that stops `full`
 * from being a memory leak with a switch on it.
 *
 * At `full` the frame decomposition is on the order of twenty entries a frame,
 * which is a million retained entries over ten minutes — and User Timing has no
 * buffer-size API to cap it with. Past the ceiling the sink clears what it has
 * emitted, by name, and says so once. Losing the oldest entries is the right
 * failure: `full` is for a bug report and a session left running is not one.
 */
const RETENTION_CEILING = 100_000
let retained = 0
let warnedAboutRetention = false

/**
 * The tracks this session has actually emitted onto, so a driver can discover
 * them rather than being told.
 *
 * Accumulated as entries are written rather than declared up front: a track
 * nothing has emitted to is a track that does not exist in the recording, and
 * listing it would be a promise the trace does not keep.
 */
const tracks = new Set<string>()

export const timingTracks = (): readonly string[] => [...tracks].sort()

const canUserTiming =
  typeof performance !== 'undefined' &&
  typeof performance.mark === 'function' &&
  typeof performance.measure === 'function'

/**
 * `console.timeStamp`, always; User Timing as well at `full`.
 *
 * The record's `name` is the label, not `scope.name`: the track already says
 * where an entry comes from, and a flame chart is read at a glance rather than
 * parsed. `scope` survives in the drained report, where there is room for it.
 */
const sink: TimingSink = {
  write(record: TimingRecord): void {
    const detail = record.detail
    if (detail?.track !== undefined) tracks.add(detail.track)
    ;(console.timeStamp as ExtendedTimeStamp)(
      record.name,
      record.startMs,
      record.endMs,
      detail?.track,
      // The group defaulted here rather than at the call site, because
      // `packages/workers` names its own tracks and must not know the
      // application's name. A track is a component describing itself; a group
      // is branding, and branding is the host's.
      detail?.group ?? (detail?.track === undefined ? undefined : TRACK_GROUP),
      detail?.color,
    )
    if (level !== 'full' || !canUserTiming) return
    writeUserTiming(record, detail)
  },
}

function writeUserTiming(
  record: TimingRecord,
  detail: TimingDetail | undefined,
): void {
  const devtools: DevToolsTrackEntry = {
    // A phase change draws as a vertical line across every track, which is what
    // "first light" wants to be: it cuts through the frame track, the worker
    // tracks and the boot track at once. An interval is an entry on one track.
    dataType: record.kind === 'mark' ? 'marker' : 'track-entry',
  }
  if (detail?.track !== undefined) {
    devtools.track = detail.track
    devtools.trackGroup = detail.group ?? TRACK_GROUP
  }
  if (detail?.color !== undefined) devtools.color = detail.color
  if (detail?.properties !== undefined)
    devtools.properties = [...detail.properties]
  if (detail?.tooltip !== undefined) devtools.tooltipText = detail.tooltip

  try {
    if (record.kind === 'mark') {
      performance.mark(record.name, {
        startTime: record.startMs,
        detail: { devtools },
      })
    } else {
      performance.measure(record.name, {
        start: record.startMs,
        end: record.endMs,
        detail: { devtools },
      })
    }
  } catch {
    // A negative start time, or a name a browser reserves. One malformed entry
    // is not worth taking a frame down for, and the level is a debugging aid.
    return
  }
  emitted.set(record.name, record.kind)
  retained += 1
  if (retained < RETENTION_CEILING) return
  if (!warnedAboutRetention) {
    warnedAboutRetention = true
    log.warn('retained timing entries hit the ceiling; clearing by name', {
      ceiling: RETENTION_CEILING,
      names: emitted.size,
    })
  }
  clearEmitted()
}

/** Clear what this sink put there, by name — never the bare form. */
function clearEmitted(): void {
  for (const [name, kind] of emitted) {
    if (kind === 'mark') performance.clearMarks(name)
    else performance.clearMeasures(name)
  }
  emitted.clear()
  retained = 0
}

/** The level this session is running at. Live — read it, do not cache it. */
export const timingLevel = (): TimingLevel => level

/**
 * Whether an entry's properties table is worth building.
 *
 * A `TimingDetail`'s `properties` reach DevTools only through a User Timing
 * detail payload, so at `trace` they are formatted, allocated and dropped.
 * Formatting two integers into strings sixty times a second to fill a table
 * nothing renders is exactly the allocation `trace` exists to avoid, and a call
 * site that emits per frame checks this before building one.
 */
export const timingDetailed = (): boolean => level === 'full'

/**
 * The one switch. The URL, the preference, the panel and `ir.timing()` are four
 * doors onto it.
 *
 * Attaching is guarded rather than counted, so StrictMode's second pass and a
 * repeated `?timing=trace` are both no-ops. `off` detaches, which is what turns
 * `timer.on` back to false and stops every call site paying.
 */
export function setTimingLevel(next: TimingLevel): void {
  if (next === level) return
  const was = level
  level = next
  if (next === 'off') {
    detach?.()
    detach = null
    if (canUserTiming) clearEmitted()
  } else if (detach === null) {
    detach = timingHub.attach(sink, { now: () => performance.now() })
  }
  log.info('timing level', {
    from: was,
    to: next,
    // What this host can actually emit, said once, because there is no
    // capability query for the `console.timeStamp` track arguments and a level
    // that silently lands nowhere is the failure this line exists to name.
    userTiming: canUserTiming,
  })
  for (const listener of listeners) listener(next)
}

/**
 * Anything that has to be *told* the level rather than able to read it.
 *
 * There is exactly one such consumer and it is the reason this exists: a worker
 * is a separate global scope with its own module registry, so it does not see
 * this module's `level` at all and has to be sent it. The pool broadcasts.
 *
 * The listener is called once on subscribe with the current level, because the
 * level is decided in `main.tsx` at module scope and a pool is constructed
 * later — a subscription that only fired on *change* would leave a pool built
 * after `?timing=full` never hearing about it.
 */
const listeners = new Set<(level: TimingLevel) => void>()

export function onTimingLevel(
  listener: (level: TimingLevel) => void,
): () => void {
  listeners.add(listener)
  listener(level)
  return () => listeners.delete(listener)
}

/** One entry, as something a terminal or an issue can carry. */
export interface TimingEntry {
  readonly name: string
  readonly kind: TimingKind
  readonly track: string
  readonly startMs: number
  readonly durationMs: number
  readonly properties: Readonly<Record<string, string>>
}

/**
 * The retained entries, and the timeline cleared of them.
 *
 * Only meaningful at `full`: `trace` retains nothing at all, which is the whole
 * reason the levels are separate. Read back out of the performance timeline
 * rather than out of a private buffer, so what a `PerformanceObserver` sees and
 * what this returns are the same entries.
 */
export function drainTiming(): readonly TimingEntry[] {
  if (!canUserTiming) return []
  const entries: TimingEntry[] = []
  for (const [name, kind] of emitted) {
    for (const entry of performance.getEntriesByName(name, kind)) {
      const devtools = (
        (entry as PerformanceEntry & { detail?: { devtools?: unknown } })
          .detail ?? {}
      ).devtools as DevToolsTrackEntry | undefined
      entries.push({
        name,
        kind,
        track: devtools?.track ?? 'Timing',
        startMs: entry.startTime,
        durationMs: entry.duration,
        properties: Object.fromEntries(devtools?.properties ?? []),
      })
    }
  }
  clearEmitted()
  entries.sort((a, b) => a.startMs - b.startMs)
  return entries
}
