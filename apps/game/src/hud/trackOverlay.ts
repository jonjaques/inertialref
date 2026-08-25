import { apparentWidth } from '@inertialref/rendering'
import type { CinematicSample } from '@inertialref/rendering'
import {
  screenPositionOf,
  TNG_CUTS,
  TNG_HULL_LENGTH,
  TNG_LENS,
} from '@inertialref/devtools'
import {
  Quaternion as Q,
  type Quat,
  UV,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'

/*
 * The arithmetic behind the track overlay, with no DOM in it.
 *
 * `TrackOverlay.tsx` is a rAF loop that writes SVG attributes; everything it
 * writes is computed here, so the part that can be wrong is the part a Node
 * test can reach. The split is `hud/warp.ts`'s.
 *
 * ## One coordinate space, and it is the reference's
 *
 * Every number that leaves this module is in the **authored frame**: normalized
 * 0..1, origin top-left, x right, y down, on the 16:9 composition
 * `tngIntro.ts` solves its shots for. That is deliberate and it is the whole
 * point of the overlay — it is the space `data/reference/tng-subject-track.json`
 * reports its boxes in, and the space `compare_render.py` computes `dcx`,
 * `dcy` and `dw` in. Projecting the render into it makes the two boxes on
 * screen the same two numbers as the row of the CSV.
 *
 * It is not the *viewport*. Three.js takes `fov` as the vertical field, and so
 * does `screenDirection`, so the vertical mapping is exact in any window; only
 * the horizontal one depends on shape. `frameToPixels` below is that one
 * conversion, and it is the only place the window's own size is allowed in.
 */

/** The reference's tracked subject for one frame, as `export_track.py` writes it. */
export interface ReferenceSubject {
  readonly frame: number
  /** Area-weighted centroid of the lit non-title mass. */
  readonly cx: number
  readonly cy: number
  /** Bounding box of that mass, as a fraction of the frame. */
  readonly w: number
  readonly h: number
  readonly area: number
  /** Principal axis in degrees; absent where the fit is degenerate. */
  readonly angle?: number
  readonly elong?: number
  readonly aspect?: number
}

/** The whole track, indexed by frame. 1,639 of 2,742 frames are tracked. */
export type ReferenceTrack = ReadonlyMap<number, ReferenceSubject>

/** A short vector from the hull, in authored-frame coordinates. */
export interface TrackVector {
  readonly dx: number
  readonly dy: number
  /**
   * How much of the vector survived the projection, 0..1.
   *
   * 1 for a direction square to the view axis and 0 for one pointing straight
   * down it. Carried separately because it is the interesting half: a nose
   * vector that has shrunk to nothing is the hull flying at the lens, which
   * reads as "no heading" if only the drawn length is available.
   */
  readonly foreshortening: number
}

/** The render's own hull, projected into the reference's coordinates. */
export interface RenderSubject {
  readonly x: number
  readonly y: number
  /** Distance from the lens, meters. */
  readonly range: number
  /** Apparent hull length as a fraction of the frame's width — the `w` column. */
  readonly width: number
  readonly nose: TrackVector
  /** The chord over `CHORD_STEP` frames either side: the smoothed heading. */
  readonly velocity: TrackVector
  /** The half-frame difference: the local heading. */
  readonly instant: TrackVector
  /** Meters per reference frame along the chord, camera-relative. */
  readonly speed: number
  /**
   * How far the two windows disagree, degrees.
   *
   * Zero where the hull is on a line and both windows measure the same thing.
   * Large where the path curves or wobbles inside the longer window — which is
   * exactly the condition under which a heading must come from a fitted line
   * rather than from any finite difference.
   */
  readonly jitterDeg: number
}

/** Forward is −Z in a hull's own frame, as everywhere else in this repository. */
const NOSE = vec3(0, 0, -1)

/**
 * How far along a direction to step before projecting it, as a fraction of the
 * range.
 *
 * A projected step rather than the direction itself, so foreshortening is
 * visible: the difference between the nose and the flight path is an angle in
 * three dimensions and only its shadow is on screen, which is the thing being
 * compared. A fraction of the range rather than a fixed distance because the
 * approach covers four decades — a 60 m probe is the whole hull at f916 and
 * invisible at f200.
 */
const PROBE = 0.06

/** The length of a fully square-on probe in authored-frame *height* units. */
const PROBE_SPAN = PROBE / (2 * Math.tan((TNG_LENS.fov * Math.PI) / 360))

/**
 * How many frames either side of the playhead each velocity is measured over.
 *
 * Two windows, because their disagreement is the reading.
 *
 * `VELOCITY_STEP` is the local one — half a frame either side, the tightest
 * difference the sampler can answer. `CHORD_STEP` is four frames either side, a
 * third of a second of the 24 fps edit, which averages out the sub-pixel wobble
 * that `cinematics.md` warns turns into large angular velocity near the lens.
 *
 * **Neither is the truth, and the smoothed one is not automatically the better
 * one.** A chord across a curving path is a secant, not a tangent, so where the
 * hull is really turning the long window is the one that lies: measured on the
 * script, the local difference sits 0.88° off the authored nose at f2100 while
 * the chord sits 5.07° off it, and at f916 — inside the authored bank-away —
 * both are 21.8° off, because there the nose is *meant* to leave the path.
 * Where the two windows agree the hull is on a line and either may be believed;
 * where they diverge, the path is curving or wobbling inside the window and no
 * heading taken from a finite difference should be trusted at all. That is why
 * `orientationAlong` derives its attitude from a fitted line rather than from
 * either of these, and why both are drawn instead of one being picked.
 */
export const VELOCITY_STEP = 0.5
export const CHORD_STEP = 4

/**
 * The hull's camera-relative offset, from a pair of render-space poses.
 *
 * Render space is a rebase, not a compression, so the difference of two
 * render-space positions is a true displacement in meters — but it is that
 * displacement *rotated by the origin's own pose*, because `toRenderSpace` is
 * `rotateInverse(origin.orientation, …)` and an origin is a planet's frame,
 * not the identity. What makes this the camera-axes offset anyway is that
 * `orientationToRenderSpace` carried the same rotation into
 * `camera.orientation`, so rotating back out by it cancels exactly. The pair
 * has to come from the same space; a render-space position difference against
 * a universe-space camera orientation is silently rotated, and the whole point
 * of this module is that its numbers are the reference CSV's.
 */
export const offsetOf = (
  camera: { readonly position: Vec3; readonly orientation: Quat },
  ship: { readonly position: Vec3 },
): Vec3 =>
  Q.rotateInverse(camera.orientation, Vec.sub(ship.position, camera.position))

/** The same offset from a director sample, whose poses are universe positions. */
export const offsetOfSample = (sample: CinematicSample): Vec3 =>
  Q.rotateInverse(
    sample.camera.orientation,
    UV.difference(sample.ship.position, sample.camera.position),
  )

/** The hull's nose as a camera-space direction. */
export const noseOf = (cameraOrientation: Quat, shipOrientation: Quat): Vec3 =>
  Q.rotateInverse(cameraOrientation, Q.rotate(shipOrientation, NOSE))

/**
 * Where a short step along `direction` from the hull lands, as a screen delta.
 *
 * Returns a zero vector rather than a wrong one for the two cases that have no
 * answer: a direction of zero length (a hull that is not moving), and a probe
 * that lands behind the lens, where the perspective divide flips sign and
 * projects the point to the opposite side of the frame.
 */
export function projectDirection(offset: Vec3, direction: Vec3): TrackVector {
  const range = Vec.length(offset)
  const unit = Vec.normalize(direction)
  if (range < 1e-6 || Vec.lengthSquared(unit) < 0.5)
    return { dx: 0, dy: 0, foreshortening: 0 }
  const ahead = Vec.add(offset, Vec.scale(unit, range * PROBE))
  if (-ahead.z <= 0) return { dx: 0, dy: 0, foreshortening: 0 }
  const from = screenPositionOf(offset)
  const to = screenPositionOf(ahead)
  const dx = to.x - from.x
  const dy = to.y - from.y
  // In height units, because that is the axis the pixel mapping does not
  // rescale — see `frameToPixels`. A square-on probe measures `PROBE_SPAN`.
  const span = Math.hypot(dx * TNG_LENS.aspect, dy)
  return { dx, dy, foreshortening: Math.min(1, span / PROBE_SPAN) }
}

/**
 * The render's hull, in the terms the reference's row is written in.
 *
 * `width` is `apparentWidth` of the hull's whole length, which is the same
 * quantity the tracker's `w` column reports and is why the two boxes can be
 * put beside each other at all. It is not the same *thing*: the tracker
 * measures lit pixels, so where the hull is bow-on its box is the saucer's
 * disc and where a nacelle is the only lit part it is a nacelle. That
 * disagreement is a reading of the overlay, not a fault in it —
 * `tngIntro.ts`'s `atWidth` note and the plan's §10 are where it is written
 * down.
 */
export function projectHull(
  offset: Vec3,
  nose: Vec3,
  velocity: Vec3,
  instant: Vec3,
): RenderSubject {
  const { x, y, range } = screenPositionOf(offset)
  return {
    x,
    y,
    range,
    width: apparentWidth(TNG_HULL_LENGTH, range, TNG_LENS.fov, TNG_LENS.aspect),
    nose: projectDirection(offset, nose),
    velocity: projectDirection(offset, velocity),
    instant: projectDirection(offset, instant),
    speed: Vec.length(velocity),
    jitterDeg: angleBetween(velocity, instant),
  }
}

/**
 * The angle between two directions, degrees, or 0 when either has no direction.
 *
 * Zero rather than NaN for a still hull: "no disagreement" is the right reading
 * of a ship that is not moving, and a NaN would print as a hole in the readout.
 */
export function angleBetween(a: Vec3, b: Vec3): number {
  const unitA = Vec.normalize(a)
  const unitB = Vec.normalize(b)
  if (Vec.lengthSquared(unitA) < 0.5 || Vec.lengthSquared(unitB) < 0.5) return 0
  const dot = Math.min(1, Math.max(-1, Vec.dot(unitA, unitB)))
  return (Math.acos(dot) * 180) / Math.PI
}

/**
 * Which shot the playhead is inside.
 *
 * From `TNG_CUTS`, so the label cannot drift from the cut table the script and
 * its tests both read. An em dash for a frame past the end rather than a
 * throw: the overlay draws while the transport is being dragged.
 *
 * Rounded first, for the same reason `tngIntro.ts`'s own `shotAt` falls back
 * to the nearest shot: cuts are contiguous over *integers* and `view.frame` is
 * `(renderTime - epoch) * fps`, fractional on essentially every rendered
 * frame. Tested against the table as written, f239.4 belongs to no shot at
 * all, and the readout blinks to an em dash at every cut boundary — on the one
 * surface whose job is to say which shot you are looking at.
 */
export function shotAt(frame: number): string {
  const at = Math.round(frame)
  const cut = TNG_CUTS.find((one) => at >= one.from && at <= one.to)
  return cut?.id ?? '—'
}

/**
 * The reference's row for the frame on screen, or null where it has none.
 *
 * Rounded rather than interpolated: the track is a per-frame measurement of a
 * 24 fps edit and the frames between its samples are not a thing that was
 * measured. 1,103 frames have no row at all — black, title-only, or a subject
 * under the tracker's area floor — and those draw no ghost box, which is
 * itself worth seeing.
 */
export function referenceAt(
  track: ReferenceTrack | null,
  frame: number,
): ReferenceSubject | null {
  if (track === null || !Number.isFinite(frame)) return null
  return track.get(Math.round(frame)) ?? null
}

/**
 * Index the exported track by frame.
 *
 * Separate from the fetch (`referenceTrack.ts`) so this half runs in Node: the
 * file is checked in, so a test can assert that the shape this reads is the
 * shape `export_track.py` writes.
 */
export function indexTrack(text: string): ReferenceTrack {
  const parsed = JSON.parse(text) as { track?: readonly ReferenceSubject[] }
  const rows = parsed.track ?? []
  const byFrame = new Map<number, ReferenceSubject>()
  for (const row of rows) byFrame.set(row.frame, row)
  return byFrame
}

/**
 * Where the authored frame lands in a window of this shape.
 *
 * The vertical field is fixed, so one authored-frame height is exactly the
 * window's height in pixels however wide the window is; the authored frame's
 * *width* is that same scale times 16/9, centered. A window wider than 16:9
 * shows scene either side of the composition and a narrower one crops it, and
 * in both cases this puts the overlay exactly where the render put the hull.
 *
 * The window's size arrives as an argument rather than being read here. Chrome
 * is never sized against the viewport in this interface — but this is picture,
 * drawn in the same space as the rendered frame, so it is the *element's* own
 * box that is measured, once per resize, by the component.
 */
export function frameToPixels(
  width: number,
  height: number,
): { x: (fx: number) => number; y: (fy: number) => number; scale: number } {
  const scale = height
  const half = (scale * TNG_LENS.aspect) / 2
  const centre = width / 2
  return {
    x: (fx) => centre + (fx - 0.5) * 2 * half,
    y: (fy) => fy * scale,
    scale,
  }
}
