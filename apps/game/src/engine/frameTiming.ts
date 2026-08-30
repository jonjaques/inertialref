import { getTimer, type Timer, type TimingDetail } from '@inertialref/shared'

/*
 * The tracks a frame is drawn on, and the clock that tiles an interval into
 * phases — the engine step on the Engine track, the `terrain` phase inside it
 * on the Terrain track.
 *
 * ## `performance.now()` here steps in 100 µs, and that shapes everything below
 *
 * Measured in this app, in Chrome, on 2026-08-30: `crossOriginIsolated` is
 * false — nothing sets COOP/COEP, and `frameMetrics.usedHeapMb` reading
 * `performance.memory` is the other confirmation — so the clock is coarsened.
 * Two hundred thousand consecutive reads produced exactly **two** distinct
 * deltas, both 100.00 µs. A busy-wait of 40 µs reads back as 100 µs and one of
 * 90 µs reads back as 100 µs.
 *
 * So a span shorter than about 300 µs cannot be trusted as a single reading,
 * and terrain selection is cited at 40–90 µs for a whole disk. Two consequences,
 * and they are the reason this file exists rather than a dozen `span()` calls
 * spread across the frame:
 *
 * **One clock read per boundary, not a pair per span.** The phases then *tile*
 * the engine step — each one ends exactly where the next begins — so the
 * quantization error redistributes between neighbors instead of accumulating,
 * and the sum of the phases equals the whole. Sixteen independent reads would
 * give eight independent roundings whose total drifts from the step they are
 * meant to decompose. It is also half the clock reads.
 *
 * **A short phase is honest in the mean and not in the instant.** Over the 240
 * frames a `Series` window holds, a phase quantized to 100 µs has a mean
 * accurate to well under a microsecond, because the rounding is unbiased. What
 * it cannot do is tell one frame's 40 µs selection from another's 90 µs. Read
 * the aggregate; do not read one bar.
 */

/** What every track in this application groups under, in the DevTools sidebar. */
export const TRACK_GROUP = 'InertialRef'

const on = (track: string, color: TimingDetail['color']): TimingDetail =>
  Object.freeze({ track, group: TRACK_GROUP, color })

/**
 * The engine step, the frame period, and the phases between them. `error` when
 * an entry ran past *its own* budget — `ENGINE_BUDGET_MS` for the step and
 * `DROPPED_FRAME_MS` for the period, which are different numbers about
 * different quantities. `perfBudgets.ts` says why judging one on the other is
 * wrong in the most misleading direction.
 */
export const ENGINE_PHASE = on('Engine', 'primary')
export const ENGINE_LATE = on('Engine', 'error')

/**
 * The streamer's own decomposition, one level finer than the Engine track's
 * single `terrain` phase.
 *
 * Two tracks at two granularities is what tracks are for: the Engine phases
 * tile the engine step, and these five tile the `terrain` phase inside it.
 * Summing across both would double-count, which is why `ir.profile` sums shares
 * per track.
 */
export const TERRAIN_PHASE = on('Terrain', 'secondary')

/** A starved or saturated selection: the ground is going coarse. */
export const TERRAIN_SHORT = on('Terrain', 'error')

/** One `useFrame` consumer. `engineMs` explicitly excludes all of them. */
export const RENDER_PHASE = on('Render', 'tertiary')

/*
 * The `Workers` and `Tasks` tracks are named in `packages/workers` rather than
 * here, beside the code that emits onto them — the same place `getLogger`'s
 * scope is named — and the group is filled in by the browser sink. A track name
 * is a component describing itself; a group is the application's branding.
 */

/** Boot, which is over before any panel exists to plot it. */
export const BOOT_PHASE = on('Boot', 'tertiary-light')
export const BOOT_MARKER = on('Boot', 'primary-light')

/**
 * A sequence of adjacent phases, from one clock read per boundary.
 *
 * `open()` at the start of the sequence, `step(name, detail)` at the end of
 * each phase. Nothing is emitted while the level is `off`, and the call sites
 * need no guard of their own: `open` records whether the hub was listening when
 * the sequence began, and `step` does nothing otherwise. That flag is not
 * defensive tidying — without it, turning the level on mid-frame would emit a
 * first entry running from `#at`'s initial zero to now, which is one bar
 * spanning the whole session.
 */
export class PhaseClock {
  readonly #timer: Timer
  #at = 0
  #open = false

  constructor(scope: string) {
    this.#timer = getTimer(scope)
  }

  /** Whether this sequence is recording. Read it before building a detail. */
  get on(): boolean {
    return this.#timer.on
  }

  /**
   * Begin the sequence.
   *
   * `at` is for a caller that has already read the clock — `GameEngine.frame`
   * has, and paying for a second read to start the phases at a moment a few
   * nanoseconds later would put a gap in the tiling for no reason.
   */
  open(at?: number): void {
    this.#open = this.#timer.on
    if (this.#open) this.#at = at ?? performance.now()
  }

  /** Close the phase since the last boundary, and open the next one there. */
  step(name: string, detail: TimingDetail): void {
    if (!this.#open) return
    const at = performance.now()
    this.#timer.measure(name, this.#at, at, detail)
    this.#at = at
  }

  /**
   * Move the boundary without emitting.
   *
   * For work that belongs to no phase — the render-space transforms between the
   * camera arms, which are a handful of quaternion multiplies. Charging them to
   * whichever neighbor happens to follow would be a lie the tiling makes
   * invisible.
   */
  skip(): void {
    if (this.#open) this.#at = performance.now()
  }
}
