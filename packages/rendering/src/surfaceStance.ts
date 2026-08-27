import type { Meters, Radians } from '@inertialref/shared'
import { type Quat, Vec, type Vec3, vec3 } from '@inertialref/spatial'
import { lookAlong } from './cinematic.ts'
import { ELEVATION_LIMIT, MIN_DISTANCE_RADII } from './observer.ts'

/*
 * The observer's other arm: standing on a surface instead of orbiting one.
 *
 * `observer.ts` is a camera that orbits a *center* — three numbers about a
 * point, clamped 1.5 radii out because below that a planetarium is showing you
 * ground with no horizon in it. That clamp is right for looking at a world and
 * is the reason there has never been a way to *inspect* one: terrain arrives
 * below the floor the camera cannot go under, so the only way to see a mountain
 * was to fly a ship at it.
 *
 * This is the arm below the floor. Five numbers about a point *on* the ground —
 * where on the sphere, how high above it, and which way the head is turned —
 * and it is arithmetic for the same reason the orbit arm is: given a ground
 * radius and a stance it returns an offset and an orientation in body-fixed
 * axes, with no idea what a body, an address or a frame is. Resolving those and
 * sampling the terrain is `devtools/observatory.ts`, exactly as it already is
 * for the orbit arm.
 *
 * The two arms meet and do not overlap. `surfaceHeightBounds` puts the ceiling
 * at `(MIN_DISTANCE_RADII − 1)` radii, which is precisely the orbit arm's floor:
 * above half a radius you are looking at a world, below it you are standing on
 * one, and there is no band that is both or neither.
 */

/** Where a viewer stands on a body, and which way they are facing. */
export interface SurfaceStance {
  readonly latitude: Radians
  /** East-positive, matching `geodeticDirection`. */
  readonly longitude: Radians
  /**
   * Height above the *ground below the stance*, meters — not above the datum.
   *
   * A height above the datum would put the camera underground on any peak and
   * a kilometer up in any basin, which is the one thing a control called
   * "altitude" must never do. What the ground is at this latitude and longitude
   * is a terrain sample, so it is supplied by the caller rather than solved
   * here: `packages/rendering` cannot reach `surfaceRadius`.
   */
  readonly height: Meters
  /** Compass heading: 0 is north, increasing toward east. */
  readonly heading: Radians
  /** Above the horizon. Negative looks down; clamped short of straight up. */
  readonly pitch: Radians
}

/**
 * How close to vertical the view may pitch, radians.
 *
 * `ELEVATION_LIMIT` itself, not a restatement of it: the argument and the
 * margin are the same — `lookAlong` levels the horizon against the local up,
 * so a view aimed exactly along it has no horizon to level and rolls a half
 * turn in one pointer-pixel — and two constants that must agree drift the
 * first time one is retuned. Two degrees is invisible and removes the
 * singularity instead of special-casing it.
 */
export const PITCH_LIMIT = ELEVATION_LIMIT

/**
 * The lowest the eye may sit above the ground, meters.
 *
 * Eye height, not clearance: 2 m is a person looking at the rock in front of
 * them, which is the bottom of the range the terrain milestone has to hold up
 * at. Below it the near plane (0.05 m) starts clipping the ground the camera is
 * standing on rather than the ground being what is in frame.
 */
export const MIN_STANCE_HEIGHT: Meters = 2

export const clampPitch = (pitch: number): number =>
  pitch < -PITCH_LIMIT
    ? -PITCH_LIMIT
    : pitch > PITCH_LIMIT
      ? PITCH_LIMIT
      : pitch

/**
 * The height band the surface arm covers for a body of this radius.
 *
 * The ceiling is the orbit arm's floor — see the header. It is a function of
 * the body rather than a constant because the two arms have to meet on Luna
 * (869 km) and on Earth (3,186 km) alike, and a fixed ceiling would leave a gap
 * over one and an overlap over the other.
 */
export function surfaceHeightBounds(radius: Meters): {
  readonly min: Meters
  readonly max: Meters
} {
  const max = Math.max(MIN_STANCE_HEIGHT * 8, radius * (MIN_DISTANCE_RADII - 1))
  return { min: MIN_STANCE_HEIGHT, max }
}

export function clampStanceHeight(height: Meters, radius: Meters): Meters {
  const { min, max } = surfaceHeightBounds(radius)
  return height < min ? min : height > max ? max : height
}

/**
 * A scrub position in [0, 1] as a height, and its inverse.
 *
 * Logarithmic, for the reason `observer.ts` gives about distance and for a
 * worse version of it: this band is 2 m to 3,186 km on Earth, which is six
 * decades. A linear slider spends 99.9% of its travel above 3 km — the whole
 * approach, the low pass and the landing all live in the last pixel — so the
 * control that exists to reach 2 m would be the one control that cannot.
 */
export function heightForScrub(radius: Meters, t: number): Meters {
  const { min, max } = surfaceHeightBounds(radius)
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return min * (max / min) ** clamped
}

export function scrubForHeight(radius: Meters, height: Meters): number {
  const { min, max } = surfaceHeightBounds(radius)
  const clamped = clampStanceHeight(height, radius)
  return Math.log(clamped / min) / Math.log(max / min)
}

/** The local east/north/up triad at a body-fixed up direction. */
export interface LocalTriad {
  readonly east: Vec3
  readonly north: Vec3
  readonly up: Vec3
}

/**
 * East, north and up at a point on the sphere.
 *
 * `+Y is the pole`, the same convention `geodeticDirection` and `spinEvaluator`
 * use. At the poles the pole and the up direction are parallel and east is
 * undefined; any perpendicular is as good as any other there, which is the same
 * bargain `lookAlong` makes about a nadir shot. Without the fallback the triad
 * degenerates to zeros and the camera's orientation becomes NaN — a black
 * frame, with nothing in the console.
 */
export function localTriad(up: Vec3): LocalTriad {
  const u = Vec.normalize(up)
  const pole = vec3(0, 1, 0)
  const across = Vec.cross(pole, u)
  const east =
    Vec.length(across) > 1e-6
      ? Vec.normalize(across)
      : Vec.normalize(Vec.cross(vec3(1, 0, 0), u))
  return { east, north: Vec.cross(u, east), up: u }
}

/**
 * Where the eye goes and where it looks, in the body's *rotating* axes.
 *
 * `groundRadius` is what the terrain says the surface radius is under this
 * stance — `surfaceRadius(body, geodeticDirection(lat, lon))` at the caller.
 * Handing it in rather than sampling here is the layer rule doing its job, and
 * it is also what lets the descent probe walk a stance down a heightfield it
 * generated itself without a world anywhere in the loop.
 */
export function surfaceStancePose(
  up: Vec3,
  groundRadius: Meters,
  stance: SurfaceStance,
): { readonly offset: Vec3; readonly orientation: Quat } {
  const triad = localTriad(up)
  const height = Math.max(0, stance.height)
  const offset = Vec.scale(triad.up, groundRadius + height)

  const heading = stance.heading
  const pitch = clampPitch(stance.pitch)
  // North at heading 0, swinging toward east — a compass, not a math angle.
  const along = Vec.add(
    Vec.scale(triad.north, Math.cos(heading)),
    Vec.scale(triad.east, Math.sin(heading)),
  )
  const forward = Vec.normalize(
    Vec.add(
      Vec.scale(along, Math.cos(pitch)),
      Vec.scale(triad.up, Math.sin(pitch)),
    ),
  )
  // Levelled against the *local* up rather than the pole: standing at 60° north
  // with the pole as the hint tilts the horizon by the co-latitude, which reads
  // as the whole world being on a slope.
  return { offset, orientation: lookAlong(forward, triad.up) }
}

/**
 * The pitch that puts the horizon on the middle of the frame from `height`.
 *
 * Below the horizon, and by more than people expect: from 2 m up on an
 * Earth-sized body the horizon is 0.045° down, and from 400 km it is 19.6°.
 * A scrub that held pitch at zero from orbit to the ground would therefore
 * spend the top of its travel aimed at empty sky — the body is *below* you up
 * there — so the descent control tracks this instead. `acos(r / (r + h))` is
 * the exact dip to the tangent point; the small-angle version is wrong by a
 * factor of two at orbital heights.
 */
export function horizonPitch(radius: Meters, height: Meters): Radians {
  if (!(radius > 0) || !(height > 0)) return 0
  return -Math.acos(Math.min(1, radius / (radius + height)))
}
