import { rangeForWidth } from '@inertialref/rendering'
import type { FitBeat } from './linePathFit.ts'

/*
 * The reference's per-frame subject track, as beats a line can be fitted to.
 *
 * `data/reference/tng-subject-track.json` carries a box for 1639 of the 2742
 * frames — the lit mass's centroid, its bounding box, its area, and the blue
 * glow blobs the tracker found inside it. A box width is a range only where
 * `design/plans/tng-intro.md` § 1 says it is, so this turns rows into beats by
 * that section's rules and gives every frame a weight saying whether its range
 * is a measurement at all.
 */

/** One row of the export, in its own field names. */
export interface SubjectTrackRow {
  readonly frame: number
  readonly cx: number
  readonly cy: number
  readonly w: number
  readonly h: number
  readonly area: number
  readonly nacelle_a_x?: number
  readonly nacelle_a_y?: number
  readonly nacelle_b_x?: number
  readonly nacelle_b_y?: number
}

export interface SubjectTrackOptions {
  readonly from: number
  readonly to: number
  /** What the box width is read as, meters — `atWidth`'s length. */
  readonly hullLength: number
  readonly fov: number
  /** The reference frame's width over its height. */
  readonly aspect: number
}

/** Which channel a frame's range came from, or why it has none. */
export type TrackChannel =
  'pair' | 'box' | 'saturated' | 'truncated' | 'transient' | 'no range'

export interface SubjectTrackBeats {
  /** Every frame in the window; weight 0 where the range is not a measurement. */
  readonly beats: readonly FitBeat[]
  readonly channels: ReadonlyMap<number, TrackChannel>
  /**
   * The pair's range over the stitched box's, per frame where both are
   * measurements, after calibration: 1 is agreement. Its spread is how far the
   * two channels disagree about the closing, which is the size of the error
   * the box would carry where the pair is used instead.
   */
  readonly pairOverBox: readonly { frame: number; ratio: number }[]
}

/** A box within this much of a frame edge is touching it. */
const EDGE = 0.005
/** A box this wide or tall is the frame, not the subject. */
const SATURATED = 0.995
/**
 * A one-frame change in log width this much larger than the change in log
 * root-area is a component crossing the tracker's floor, not a closing. The
 * step the threshold produces is 0.3–0.4; frame-to-frame closing differs from
 * the area's by under 0.03 across the descent.
 */
const STEP = 0.1
/**
 * A centroid this far from each of its neighbors' has a second mass in it for
 * one frame. The hull's own centroid moves under 0.005 of the
 * frame per frame through the descent; the transients jump 0.1 to 0.4.
 */
const TRANSIENT = 0.03
/** A pair separation this far, in log, from its neighbors' is a different pair. */
const PAIR_OUTLIER = 0.05

/**
 * Beats from the subject track, by § 1's channel rules.
 *
 * - **Saturated or truncated, no range.** A box against a frame edge or as wide
 *   as the frame measures the frame. Its centroid is a statement about the
 *   edges too, so the frame carries no weight at all — the same cut
 *   `cutscene.test.ts` makes at the wipe's f1316. The edge test reads the
 *   centroid as the box's center, which a lopsided mass is not, so `EDGE` is a
 *   margin as well as a tolerance.
 * - **Transient, no weight.** Every sixteen frames or so through the descent
 *   one frame's centroid jumps 0.1 to 0.4 of the frame and back: a second mass
 *   for a frame, which corrupts the mark as well as the width.
 * - **Inflated, stitched.** A second lit component crossing the tracker's
 *   400-pixel floor widens the box in one frame while the area barely moves. A
 *   box either side of such a step is a range of a different extent of the
 *   ship, so the width is stitched across it — continued at the area's rate —
 *   rather than read as a closing or thrown away.
 * - **The rigid pair, where it is one.** Two blobs a fixed distance apart on
 *   the hull scale exactly as one over range whatever is lit around them. The
 *   track's pair is ordered left to right, and from f1962 it alternates
 *   between two pairings of three blobs; the inner-to-starboard pairing
 *   (`nacelle_a_x` above 0.45) is the one taken, an outlier against its
 *   neighbors is a misidentification and dropped, and its scale is calibrated
 *   against the stitched box over the frames both measure. Where it exists it
 *   is the range; the box is spliced in only where it does not.
 *
 * Every weighted beat's mark is the lit mass's centroid, which is the export's
 * only position. The authored beats were read as box centers, so the two
 * channels differ by the mass's asymmetry — up to 0.02 of the frame on the
 * descent.
 */
export function subjectTrackBeats(
  rows: readonly SubjectTrackRow[],
  options: SubjectTrackOptions,
): SubjectTrackBeats {
  const { from, to, hullLength, fov, aspect } = options
  const window = rows
    .filter((row) => row.frame >= from && row.frame <= to)
    .sort((a, b) => a.frame - b.frame)
  const channels = new Map<number, TrackChannel>()

  const byFrame = new Map(window.map((row) => [row.frame, row]))
  const stitched = new Map<number, number>()
  let offset = 0
  let previous: SubjectTrackRow | null = null
  for (const row of window) {
    if (isTransient(row, byFrame)) {
      channels.set(row.frame, 'transient')
      continue
    }
    if (row.w >= SATURATED || row.h >= SATURATED) {
      channels.set(row.frame, 'saturated')
      continue
    }
    if (
      row.cx - row.w / 2 < EDGE ||
      row.cx + row.w / 2 > 1 - EDGE ||
      row.cy - row.h / 2 < EDGE ||
      row.cy + row.h / 2 > 1 - EDGE
    ) {
      channels.set(row.frame, 'truncated')
      continue
    }
    if (previous !== null) {
      const step =
        Math.log(row.w / previous.w) - 0.5 * Math.log(row.area / previous.area)
      if (Math.abs(step) > STEP) offset += step
    }
    stitched.set(row.frame, row.w * Math.exp(-offset))
    previous = row
  }

  const separations = new Map<number, number>()
  for (const row of window) {
    const { nacelle_a_x: ax, nacelle_a_y: ay } = row
    const { nacelle_b_x: bx, nacelle_b_y: by } = row
    if (ax === undefined || ay === undefined) continue
    if (bx === undefined || by === undefined) continue
    if (ax <= 0.45 || bx - ax <= 0.05) continue
    // In widths of the frame: a unit of y is 1/aspect of one.
    separations.set(row.frame, Math.hypot(bx - ax, (by - ay) / aspect))
  }
  const pair = new Map<number, number>()
  for (const [frame, separation] of separations) {
    const near: number[] = []
    for (let f = frame - 5; f <= frame + 5; f += 1) {
      const other = separations.get(f)
      if (other !== undefined) near.push(other)
    }
    if (Math.abs(Math.log(separation / median(near))) <= PAIR_OUTLIER)
      pair.set(frame, separation)
  }

  const boxRange = (width: number) =>
    rangeForWidth(hullLength, width, fov, aspect)
  const products: number[] = []
  for (const [frame, separation] of pair) {
    const width = stitched.get(frame)
    if (width !== undefined) products.push(boxRange(width) * separation)
  }
  const scale = products.length > 0 ? median(products) : null

  const beats: FitBeat[] = []
  const pairOverBox: { frame: number; ratio: number }[] = []
  for (const row of window) {
    const width = stitched.get(row.frame)
    const separation = pair.get(row.frame)
    let range = boxRange(width ?? row.w)
    if (scale !== null && separation !== undefined) {
      range = scale / separation
      if (width !== undefined) {
        channels.set(row.frame, 'pair')
        pairOverBox.push({ frame: row.frame, ratio: range / boxRange(width) })
      }
    } else if (width !== undefined) channels.set(row.frame, 'box')
    else if (!channels.has(row.frame)) channels.set(row.frame, 'no range')
    beats.push({
      frame: row.frame,
      x: row.cx,
      y: row.cy,
      range,
      weight: width === undefined ? 0 : 1,
    })
  }
  return { beats, channels, pairOverBox }
}

/**
 * The centroid is far from every neighbor's for one frame, or the frame has no
 * neighbor to be checked against.
 *
 * Every neighbor rather than their midpoint: a frame beside a transient has
 * the transient for one of its two neighbors, and the midpoint of those two is
 * half the jump away — 0.05 to 0.2 of the frame, past `TRANSIENT` — so a
 * midpoint test drops both clean frames either side of each jump with it.
 */
function isTransient(
  row: SubjectTrackRow,
  byFrame: ReadonlyMap<number, SubjectTrackRow>,
): boolean {
  const before = byFrame.get(row.frame - 1)
  const after = byFrame.get(row.frame + 1)
  const near = [before, after].filter((other) => other !== undefined)
  // A detection with no neighbor is not yet a track: f1767 is a 0.40-wide mass
  // in the middle of the frame, three frames before the hull appears at its top.
  if (near.length === 0) return true
  return near.every(
    (other) => Math.hypot(row.cx - other.cx, row.cy - other.cy) > TRANSIENT,
  )
}

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
