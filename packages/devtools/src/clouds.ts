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

/*
 * The bins every cloud histogram is counted in, on the GPU by the residual
 * meter and read back by the runner (`scripts/clouds/diff.mjs`): 64, a
 * sixteenth of a decade each, from 10⁻⁴ to 1, the exposure meter's
 * convention. Bin 0 also holds everything under 10⁻⁴ and bin 63 everything
 * from 10^(−1/16) up. One definition, because a meter and a reader that each
 * wrote the formula would agree only until one of them changed, and every
 * percentile the runner prints would then be read off the wrong edge.
 */
export const CLOUD_HISTOGRAM_BINS = 64
export const CLOUD_HISTOGRAM_BINS_A_DECADE = 16
export const CLOUD_HISTOGRAM_FLOOR_DECADE = -4

/** The bin a relative error falls in, clamped to the histogram's ends. */
export function cloudHistogramBin(error: number): number {
  const decade = Math.log10(Math.max(error, 1e-30))
  const bin = Math.floor(
    (decade - CLOUD_HISTOGRAM_FLOOR_DECADE) * CLOUD_HISTOGRAM_BINS_A_DECADE,
  )
  return Math.min(Math.max(bin, 0), CLOUD_HISTOGRAM_BINS - 1)
}

/** The lower edge of bin `i`: 10^(−4 + i/16), so bin i holds [edge(i), edge(i + 1)). */
export function cloudHistogramEdge(i: number): number {
  return (
    10 ** (CLOUD_HISTOGRAM_FLOOR_DECADE + i / CLOUD_HISTOGRAM_BINS_A_DECADE)
  )
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
    /**
     * Sky-class cloud texels within 2° of the limb, apart: the light of the
     * ring Enhanced draws there, which sits in front of the cloud and which
     * the identity dims by T_c with the rest of the scene, relative to the
     * identity's output. Its own `samples` count those texels; zero light,
     * bin 0, wherever Enhanced draws no ring.
     */
    readonly limb: CloudHistogram
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
