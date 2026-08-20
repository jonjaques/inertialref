import { Series } from '@inertialref/devtools'

/*
 * What the performance overlay plots, sampled once per frame.
 *
 * The split from `@inertialref/devtools`'s `Series` is the layering rule doing
 * its job: the ring buffer and its statistics are arithmetic and live in a
 * package that Node can test, while *what* to sample — `renderer.info`,
 * `performance.memory` — is Three.js and Chromium and may not go below `apps/`.
 * So this file is a list of names and one struct, and it is meant to stay that
 * dull.
 *
 * `sample` is called from `GameEngine.frame`, which is to say once per animation
 * frame, forever. It allocates nothing.
 */

/** Four seconds at 60 fps. Long enough to contain a stutter, short enough to forget one. */
const WINDOW = 240

export interface FrameSample {
  /** Wall clock between this frame and the last. `1000 / periodMs` is the frame rate. */
  readonly periodMs: number
  /**
   * Time inside `GameEngine.frame` — ticks, snapshot, scene build, terrain
   * reconciliation. Explicitly *not* the whole frame: everything the GPU does
   * happens after this returns, and conflating the two is how a renderer problem
   * gets diagnosed as a simulation one.
   */
  readonly engineMs: number
  readonly ticks: number
  readonly achievedTimeScale: number
  readonly drawCalls: number
  readonly triangles: number
  readonly queuedJobs: number
  /** JS heap in MB where the browser will say, `NaN` where it will not. */
  readonly heapMb: number
}

export class FrameMetrics {
  readonly period = new Series(WINDOW)
  readonly engineMs = new Series(WINDOW)
  readonly ticks = new Series(WINDOW)
  readonly warp = new Series(WINDOW)
  readonly drawCalls = new Series(WINDOW)
  readonly triangles = new Series(WINDOW)
  readonly queuedJobs = new Series(WINDOW)
  readonly heapMb = new Series(WINDOW)

  /**
   * The last GPU measurement, in milliseconds per frame, or `null`.
   *
   * Not sampled per frame and never will be: the only trustworthy way to get it
   * is to drain the queue, which means an `await` in the middle of a frame. It
   * is filled in on demand — see `measureGpuFrameMs`.
   */
  gpuMs: number | null = null

  sample(frame: FrameSample): void {
    this.period.push(frame.periodMs)
    this.engineMs.push(frame.engineMs)
    this.ticks.push(frame.ticks)
    this.warp.push(frame.achievedTimeScale)
    this.drawCalls.push(frame.drawCalls)
    this.triangles.push(frame.triangles)
    this.queuedJobs.push(frame.queuedJobs)
    this.heapMb.push(frame.heapMb)
  }
}

/** Chrome only, and not on the standard `Performance`. Absent everywhere else. */
interface ChromeMemory {
  readonly usedJSHeapSize: number
}

export function usedHeapMb(): number {
  const memory = (performance as Performance & { memory?: ChromeMemory }).memory
  // NaN rather than 0: `Series` drops it, so the panel shows an empty plot
  // instead of a flat line at zero that looks like a measurement.
  return memory === undefined
    ? Number.NaN
    : memory.usedJSHeapSize / (1024 * 1024)
}
