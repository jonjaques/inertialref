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
  /** 'n/32': frames since the history last reset, of the settle window. */
  readonly history: string
  readonly caches: string
}

export interface CloudRenderReport {
  readonly available: boolean
  readonly reason: 'webgl' | null
  readonly on: boolean
  readonly levers: Readonly<Record<string, string | number | boolean | null>>
  /**
   * Eight hex digits over the levers the frame drew with, resolved at its
   * size, the ones that only steer a measurement left out: what binds a
   * capture or a campaign row to its lever set. Null with no levers to hash.
   */
  readonly leversHash: string | null
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

/**
 * Frames after a reset the history takes to settle: 32. The history's
 * weight floors at 1/8, so a pixel holds the mean of eight samples only
 * after 32 frames, which is eight whole interleave cycles; 16 is four. A
 * plate taken at 16 is a plate of a history halfway there, and two boots
 * would disagree by what the second half adds.
 */
export const CLOUD_SETTLE_FRAMES = 32

/**
 * What a measurement waits on: every cache's owed work done and
 * `CLOUD_SETTLE_FRAMES` since the history last reset. Null when there is
 * nothing to wait for — no system, or levers off.
 *
 * A forced path (cut, scrub, warp, fly) resets or re-owes work every frame,
 * so it never settles; a runner waits it out to its cap.
 */
export function cloudsSettled(
  report: Omit<CloudRenderReport, 'settle'> | null,
): CloudSettle | null {
  if (report === null || !report.on) return null
  const owed = Object.entries(report.pending)
    .filter(([, pending]) => pending)
    .map(([name]) => name)
  const seen = Math.min(report.sinceReset, CLOUD_SETTLE_FRAMES)
  return {
    pending: owed.length > 0 || report.sinceReset < CLOUD_SETTLE_FRAMES,
    history: `${seen}/${CLOUD_SETTLE_FRAMES}`,
    caches: owed.length === 0 ? 'ready' : owed.join(', '),
  }
}

/**
 * The report of a system that drew nothing: one that exists and is off, or,
 * with `reason`, one that cannot exist — the flag on a WebGL renderer, which
 * draws no clouds in phase 0 (§4.6).
 */
export function cloudReportIdle(
  reason: CloudRenderReport['reason'] = null,
): CloudRenderReport {
  return {
    available: reason === null,
    reason,
    on: false,
    levers: {},
    leversHash: null,
    served: null,
    second: null,
    regime: 'off',
    reset: 'none',
    extents: { render: [0, 0], css: [0, 0], trace: [0, 0], history: [0, 0] },
    frames: 0,
    resets: 0,
    sinceReset: 0,
    pending: {
      maps: false,
      clipmap: false,
      volume: false,
      sunDepth: false,
      far: false,
      history: false,
    },
    settle: null,
    bytes: { total: 0 },
    pipelines: { render: 0, compute: 0 },
    steps: null,
    residual: null,
  }
}

/**
 * One frame's radiance at the trace's texels, read back after the frame
 * (`ir.cloudRadiance()`): the scene as drawn with the clouds composited in,
 * as the scene target holds it over the scene's radiance gain, and which
 * texels hold cloud. Row-major from the image's top, as the trace counts
 * its texels.
 */
export interface CloudRadiance {
  readonly width: number
  readonly height: number
  /** Rec. 709 luminance a texel, scene units. */
  readonly luminance: Float32Array
  /** 1 where the history holds cloud there: T_c under 0.999, or any light. */
  readonly cloud: Uint8Array
}

/** Two captures' difference over the texels either holds cloud at. */
export interface CloudRadianceDifference {
  /** Texels either capture holds cloud at: what the figures are taken over. */
  readonly texels: number
  /** RMS of the luminance difference there, scene units. */
  readonly rmse: number
  /** The two captures' mean luminance there. */
  readonly mean: number
  /**
   * rmse / mean: §8.7's radiance RMSE over cloud texels. Null with no cloud
   * texel or no light there, where a ratio would say nothing.
   */
  readonly relative: number | null
}

/**
 * The radiance difference §8.7's cache gate and the quality ladders read:
 * the RMS of the luminance difference over every texel where either capture
 * holds cloud, over the two captures' mean luminance there. Symmetric, so
 * neither capture is the reference. Two captures of different extents are
 * refused: their texels are not one another's.
 */
export function cloudRadianceDifference(
  a: CloudRadiance,
  b: CloudRadiance,
): CloudRadianceDifference {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(
      `the captures differ in extent: ${a.width} × ${a.height} against ${b.width} × ${b.height}`,
    )
  const count = a.width * a.height
  for (const capture of [a, b])
    if (capture.luminance.length !== count || capture.cloud.length !== count)
      throw new Error(
        `a capture of ${capture.width} × ${capture.height} holds ${capture.luminance.length} luminances and ${capture.cloud.length} marks`,
      )
  let texels = 0
  let squares = 0
  let sum = 0
  for (let i = 0; i < count; i += 1) {
    if (a.cloud[i] === 0 && b.cloud[i] === 0) continue
    const la = a.luminance[i]!
    const lb = b.luminance[i]!
    texels += 1
    squares += (la - lb) * (la - lb)
    sum += la + lb
  }
  if (texels === 0) return { texels, rmse: 0, mean: 0, relative: null }
  const rmse = Math.sqrt(squares / texels)
  const mean = sum / (2 * texels)
  return { texels, rmse, mean, relative: mean > 0 ? rmse / mean : null }
}
