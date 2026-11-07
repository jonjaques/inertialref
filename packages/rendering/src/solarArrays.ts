import { Quaternion as Q, Vec, type Vec3 } from '@inertialref/spatial'

/*
 * Turning a station's solar arrays to the Sun.
 *
 * The ISS does it with two kinds of joint, and so does its model. An alpha
 * joint turns the whole outboard truss about the truss's own axis, once an
 * orbit in nadir attitude; a beta joint turns one wing about its mast. Alpha
 * alone can face a wing at the Sun only when the Sun lies in the plane the
 * masts sweep, and beta alone only when it lies across the mast — between
 * them, any direction.
 *
 * Arithmetic and nothing else, so it can be tested in Node: the joints'
 * axes, masts and rest normals come from the model (`asset.extras` and each
 * joint node's own extras), and the host sets the node rotations this hands
 * back. A wing faces the Sun exactly when its mast is perpendicular to the
 * Sun, so alpha puts the masts there and beta turns each blanket's face round
 * the mast to meet it.
 */

/** A wing on a beta joint, in its alpha joint's axes at rest. */
export interface ArrayWing {
  readonly name: string
  /** The mast: the beta joint's axis. */
  readonly axis: Vec3
  /** The blanket's cell side at rest, perpendicular to the mast. */
  readonly normal: Vec3
}

/** An alpha joint and the wings it carries, in the station's axes at rest. */
export interface ArrayRotor {
  readonly name: string
  /** The truss axis the joint turns about. */
  readonly axis: Vec3
  /** The direction its wings' masts point at rest, perpendicular to the axis. */
  readonly mast: Vec3
  readonly wings: readonly ArrayWing[]
}

/** `v` with its component along unit `axis` removed, normalized; null if nothing is left. */
function across(v: Vec3, axis: Vec3): Vec3 | null {
  const rest = Vec.sub(v, Vec.scale(axis, Vec.dot(v, axis)))
  const length = Vec.length(rest)
  return length < 1e-9 ? null : Vec.scale(rest, 1 / length)
}

/**
 * The angle, radians about each joint's own axis, that faces every wing at
 * `sun` — a unit direction in the station's axes. Keyed by joint name.
 *
 * Alpha is the turn that puts the rest mast `m` perpendicular to the Sun:
 * `m cos α + (a × m) sin α` has no component along `s` at
 * `α = atan2(−m·s, (a × m)·s)`. Of the two solutions this picks the one with
 * the masts' rotated cross product toward the Sun; the other is a half turn
 * from it and differs only in which way the masts point. Beta then maximizes
 * the blanket normal's component along the Sun, seen from the alpha joint:
 * `β = atan2(s·(b × n), s·n)`, which with the mast already across the Sun is
 * the exact facing rather than the best of a bad job.
 *
 * With the Sun straight down the truss there is no turn of alpha that helps,
 * and none that hurts; `atan2(0, 0)` is zero.
 */
export function sunTracking(
  sun: Vec3,
  rotors: readonly ArrayRotor[],
): ReadonlyMap<string, number> {
  const angles = new Map<string, number>()
  for (const rotor of rotors) {
    const axis = Vec.normalize(rotor.axis)
    const mast = across(rotor.mast, axis)
    const alpha =
      mast === null
        ? 0
        : Math.atan2(-Vec.dot(mast, sun), Vec.dot(Vec.cross(axis, mast), sun))
    angles.set(rotor.name, alpha)
    // The Sun as the alpha joint's turned axes see it.
    const local = Q.rotate(Q.fromAxisAngle(axis, -alpha), sun)
    for (const wing of rotor.wings) {
      const beta = Vec.normalize(wing.axis)
      const normal = across(wing.normal, beta)
      angles.set(
        wing.name,
        normal === null
          ? 0
          : Math.atan2(
              Vec.dot(local, Vec.cross(beta, normal)),
              Vec.dot(local, normal),
            ),
      )
    }
  }
  return angles
}
