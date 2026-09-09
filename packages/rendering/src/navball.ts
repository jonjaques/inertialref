import {
  type Quat,
  Quaternion as Q,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'

/*
 * The attitude indicator's arithmetic.
 *
 * A navball is a sphere painted with the horizon — sky above, ground below,
 * a pitch ladder and a compass rose — held still in the world while the hull
 * turns around it, and looked at through a window in the panel that always
 * faces the nose. So the picture is one rotation: the horizon's axes seen
 * from inside the hull. Everything the instrument prints — the heading, the
 * pitch, the bank, where on the ball the velocity points — is a reading off
 * that one quaternion, and it is here rather than in the component because
 * a reading is something a test can hold to the truth and a canvas is not.
 *
 * Two frames, both right-handed and both with −Z forward, so a level hull
 * pointing north has the identity attitude:
 *
 *   - **horizon** axes: +X east, +Y up, −Z north.
 *   - **hull** axes: +X starboard, +Y dorsal, −Z the nose.
 *
 * The horizon under a ship is `RenderScene.horizon`; with no body in reach
 * the render axes themselves stand in, which is the inertial reference the
 * game is named for and the only frame that means anything out there.
 */

/** The horizon as two unit vectors, in whatever axes the ship is posed in. */
export interface HorizonFrame {
  readonly up: Vec3
  readonly north: Vec3
}

/** The three angles a pilot reads off the horizon. Radians. */
export interface Attitude {
  /** Above the horizon, −π/2..π/2. */
  readonly pitch: number
  /** Clockwise from north as seen from above, 0..2π. */
  readonly heading: number
  /** About the nose, positive with the starboard side down, −π..π. */
  readonly roll: number
}

/** The horizon with nothing to measure against: the axes as they are. */
export const INERTIAL_HORIZON: HorizonFrame = Object.freeze({
  up: vec3(0, 1, 0),
  north: vec3(0, 0, -1),
})

/**
 * The horizon as an orientation: the rotation taking horizon axes into the
 * axes the frame is expressed in.
 *
 * `north` is squared against `up` before it is used, because a horizon
 * built from a body's pole is only perpendicular to within the rounding of
 * the projection that made it, and a basis a millionth off orthonormal is a
 * quaternion `fromBasis` normalizes into a slightly different rotation.
 */
export function horizonOrientation(horizon: HorizonFrame): Quat {
  const up = Vec.normalize(horizon.up)
  const north = Vec.normalize(
    Vec.sub(horizon.north, Vec.scale(up, Vec.dot(horizon.north, up))),
  )
  const east = Vec.cross(north, up)
  return Q.fromBasis(east, up, Vec.negate(north))
}

/**
 * The hull's orientation in the horizon's own axes — the one rotation the
 * whole instrument is a picture of.
 */
export const hullInHorizon = (ship: Quat, horizon: HorizonFrame): Quat =>
  Q.multiply(Q.conjugate(horizonOrientation(horizon)), ship)

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v))
const TAU = Math.PI * 2

/** Radians onto 0..2π. */
export const wrapHeading = (radians: number): number =>
  ((radians % TAU) + TAU) % TAU

/**
 * The attitude of a hull against a horizon.
 *
 * Heading is the nose laid flat on the horizon and measured from north
 * toward east. Pitch is the nose above it. Roll is the angle from the level
 * starboard direction — the horizon's own, for this nose — round to the
 * hull's, positive when the starboard side has gone down, which is the way
 * `flight.rollRight` turns it. Over a pole the level direction vanishes and
 * the roll is reported as zero, because there is no horizon to bank against.
 */
export function attitudeOf(ship: Quat, horizon: HorizonFrame): Attitude {
  const local = hullInHorizon(ship, horizon)
  const forward = Q.rotate(local, vec3(0, 0, -1))
  const starboard = Q.rotate(local, vec3(1, 0, 0))
  const pitch = Math.asin(clamp1(forward.y))
  const heading = wrapHeading(Math.atan2(forward.x, -forward.z))
  /*
   * The level triad about *this* nose: starboard along the horizon, and the
   * up that goes with it — `level × forward`, which leans away from the
   * horizon's own up by the pitch. The bank is measured in that plane. Taken
   * against the horizon's up instead, the sine comes out scaled by the
   * cosine of the pitch, and a hull banked a radian while pitched to 86°
   * reads a quarter of it.
   */
  const level = Vec.cross(forward, vec3(0, 1, 0))
  const flat = Vec.length(level)
  if (flat < 1e-9) return { pitch, heading, roll: 0 }
  const levelStarboard = Vec.scale(level, 1 / flat)
  const levelUp = Vec.cross(levelStarboard, forward)
  const roll = Math.atan2(
    -Vec.dot(starboard, levelUp),
    Vec.dot(starboard, levelStarboard),
  )
  return { pitch, heading, roll }
}

/**
 * The hull orientation that has a given attitude against a horizon — the
 * inverse of `attitudeOf`, and how a test states one.
 *
 * Yaw about the horizon's up, then pitch about the yawed hull's starboard,
 * then roll about the pitched hull's nose: the aerospace order, and each
 * turn in the hull's own axes so the three read as the three numbers a
 * pilot means by them.
 */
export function orientationFor(
  attitude: Attitude,
  horizon: HorizonFrame,
): Quat {
  const yaw = Q.fromAxisAngle(vec3(0, 1, 0), -attitude.heading)
  const pitch = Q.fromAxisAngle(vec3(1, 0, 0), attitude.pitch)
  const roll = Q.fromAxisAngle(vec3(0, 0, -1), attitude.roll)
  return Q.multiply(
    horizonOrientation(horizon),
    Q.multiply(Q.multiply(yaw, pitch), roll),
  )
}

/** A direction on the painted sphere, in horizon axes, for a heading and a pitch. */
export function horizonDirection(heading: number, pitch: number): Vec3 {
  const flat = Math.cos(pitch)
  return vec3(
    Math.sin(heading) * flat,
    Math.sin(pitch),
    -Math.cos(heading) * flat,
  )
}

/**
 * Where a direction lands on the instrument's face.
 *
 * `direction` is in the same axes as `local` was measured in, and the result
 * is in the hull's: `x` runs to starboard and `y` up the panel, both −1..1
 * across the ball, and `depth` is how far toward the viewer the point sits —
 * positive on the face the nose looks at, negative round the back, where it
 * is not drawn. A direction along the nose lands dead centre at depth 1,
 * which is what puts the level mark under the horizon a hull is flying on.
 */
export function onBall(
  local: Quat,
  direction: Vec3,
): { readonly x: number; readonly y: number; readonly depth: number } {
  const v = Q.rotateInverse(local, direction)
  return { x: v.x, y: v.y, depth: -v.z }
}
