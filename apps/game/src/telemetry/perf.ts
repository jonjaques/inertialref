import type { FrameMetrics, FrameSample } from '../engine/frameMetrics.ts'
import { featureFlag, isReporting, recordEvent } from './client.ts'

/*
 * Frame time in the field, as a `perf window` event a minute.
 *
 * The perf panel's series hold four seconds, which is the right memory for a
 * plot and the wrong one for a population: a visitor's minute of play has to
 * survive until it is sent. So this keeps its own window, fed by
 * `FrameMetrics.tap` from the frame that measured it.
 *
 * The histogram is what makes the numbers add up across visitors. A p95 per
 * session cannot be averaged into a p95 of everybody; counts in fixed buckets
 * can be summed (HogQL's `sumForEach`) and the population's percentile read
 * off the sum. The bounds sit on the frame budgets that matter: 120, 83, 60,
 * 50, 40, 30, 20 and 10 Hz.
 *
 * No timer. The window closes when the periods it has seen add up to a
 * minute, so a hidden tab, whose animation frames stop, sends nothing, and a
 * paused frame loop does not report a minute of nothing.
 */

/** Upper bounds of each bucket, in milliseconds; the last bucket is open. */
export const PERIOD_BOUNDS = [8, 12, 16.7, 20, 25, 33.4, 50, 100] as const

/** A frame longer than this missed a 40 Hz budget, which a player sees. */
export const DROPPED_MS = 25

/** The PostHog feature flag that can stop `perf window` events. */
export const PERF_WINDOW_FLAG = 'perf-window'

/** One minute of frames, at the frame clock's own reckoning. */
export const WINDOW_MS = 60_000

/** Room for a minute at 240 Hz; frames past it are counted, not kept. */
const CAPACITY = 16_384

const percentile = (sorted: Float32Array, p: number): number =>
  sorted.length === 0
    ? Number.NaN
    : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!

const round = (value: number): number => Math.round(value * 100) / 100

export class PerfWindow {
  readonly #periods = new Float32Array(CAPACITY)
  readonly #engine = new Float32Array(CAPACITY)
  readonly #draws = new Float32Array(CAPACITY)
  readonly #buckets = new Uint32Array(PERIOD_BOUNDS.length + 1)
  #kept = 0
  #frames = 0
  #dropped = 0
  #elapsed = 0
  #heap = Number.NaN
  readonly #send: (properties: Record<string, unknown>) => void

  constructor(send: (properties: Record<string, unknown>) => void) {
    this.#send = send
  }

  /** One frame. Allocates nothing; closes the window when it is a minute long. */
  sample(frame: FrameSample): void {
    const period = frame.periodMs
    if (!(period > 0)) return
    this.#frames += 1
    this.#elapsed += period
    if (period > DROPPED_MS) this.#dropped += 1
    let bucket = 0
    while (bucket < PERIOD_BOUNDS.length && period > PERIOD_BOUNDS[bucket]!)
      bucket += 1
    this.#buckets[bucket]! += 1
    if (this.#kept < CAPACITY) {
      this.#periods[this.#kept] = period
      this.#engine[this.#kept] = frame.engineMs
      this.#draws[this.#kept] = frame.drawCalls
      this.#kept += 1
    }
    if (Number.isFinite(frame.heapMb)) this.#heap = frame.heapMb
    if (this.#elapsed >= WINDOW_MS) this.flush()
  }

  /** Send what the window holds, if anything, and start a new one. */
  flush(): void {
    if (this.#frames === 0) return
    const kept = this.#kept
    const periods = this.#periods.slice(0, kept).sort()
    const engine = this.#engine.slice(0, kept).sort()
    const draws = this.#draws.slice(0, kept).filter(Number.isFinite).sort()
    this.#send({
      frames: this.#frames,
      window_ms: Math.round(this.#elapsed),
      period_p50: round(percentile(periods, 0.5)),
      period_p95: round(percentile(periods, 0.95)),
      period_p99: round(percentile(periods, 0.99)),
      engine_p95: round(percentile(engine, 0.95)),
      dropped_frames: this.#dropped,
      ...(draws.length === 0
        ? {}
        : { draw_calls_p95: Math.round(percentile(draws, 0.95)) }),
      ...(Number.isFinite(this.#heap)
        ? { heap_mb: Math.round(this.#heap) }
        : {}),
      period_buckets: [...this.#buckets],
      period_bounds: [...PERIOD_BOUNDS],
    })
    this.#buckets.fill(0)
    this.#kept = 0
    this.#frames = 0
    this.#dropped = 0
    this.#elapsed = 0
  }
}

/**
 * Report this engine's frames until the teardown. Nothing is installed on a
 * page that does not report, so the frame loop pays for a minute's buffer
 * only where somebody will read it. `pagehide` sends the part-minute a
 * visitor leaves in, which is the minute most likely to hold a stutter they
 * left over.
 */
export function startPerfWindow(metrics: FrameMetrics): () => void {
  if (!isReporting()) return () => {}
  const window_ = new PerfWindow((properties) => {
    // The flag is a kill switch, not a rollout: absent (a first visit, or a
    // project without the flag) sends, and only an explicit `false` from
    // PostHog stops the most frequent event this client sends, without a
    // deploy. Read at send time, so a flag that loads after boot applies.
    if (featureFlag(PERF_WINDOW_FLAG) === false) return
    recordEvent('perf window', properties)
  })
  metrics.tap = (frame) => window_.sample(frame)
  const leave = (): void => window_.flush()
  window.addEventListener('pagehide', leave)
  return () => {
    window.removeEventListener('pagehide', leave)
    if (metrics.tap !== null) metrics.tap = null
    window_.flush()
  }
}
