/*
 * What the cloud system reports through the render host, as plain data: the
 * levers it read, the frame it drew, what its caches still owe, and what it
 * holds in memory. No Three here — the report crosses the port the way every
 * other render readout does, and a script reads it as JSON (`ir.clouds()`).
 */

/** 64 log bins from 10⁻⁴ to 1. */
export interface CloudHistogram {
  readonly bins: readonly number[]
  readonly samples: number
}

export interface CloudSettle {
  readonly pending: boolean
  /** 'n/16': frames since the history last reset, of the settle window. */
  readonly history: string
  readonly caches: string
}

export interface CloudRenderReport {
  readonly available: boolean
  readonly reason: 'webgl' | null
  readonly on: boolean
  readonly levers: Readonly<Record<string, string | number | boolean | null>>
  readonly served: string | null
  readonly second: string | null
  readonly regime: 'converging' | 'immediate' | 'off'
  readonly reset: string
  readonly extents: {
    readonly render: readonly [number, number]
    readonly css: readonly [number, number]
    readonly trace: readonly [number, number]
    readonly history: readonly [number, number]
  }
  readonly frames: number
  readonly resets: number
  readonly sinceReset: number
  readonly pending: {
    readonly maps: boolean
    readonly clipmap: boolean
    readonly volume: boolean
    readonly sunDepth: boolean
    readonly far: boolean
    readonly history: boolean
  }
  /** `cloudsSettled(this)`, computed by the system: what the runner waits on. */
  readonly settle: CloudSettle | null
  readonly bytes: Readonly<Record<string, number>> & { readonly total: number }
  /** The cloud pipelines warmed: render and compute. */
  readonly pipelines: { readonly render: number; readonly compute: number }
  readonly steps: {
    readonly mean: number
    readonly max: number
    readonly exhausted: number
  } | null
  readonly residual: {
    readonly thin: CloudHistogram
    readonly light: CloudHistogram
    readonly total: CloudHistogram
    /** Trace texels whose class the trace and the composite decided differently. */
    readonly classDisagreement: number
  } | null
}

/** Frames after a reset the history takes to settle: four whole interleave cycles. */
export const CLOUD_SETTLE_FRAMES = 16

/**
 * Null when there is nothing to wait for: no system, or levers off.
 *
 * Null for every report here: nothing waits on the clouds until the system
 * that fills the report reports a frame.
 */
export function cloudsSettled(
  _report: Omit<CloudRenderReport, 'settle'> | null,
): CloudSettle | null {
  return null
}
