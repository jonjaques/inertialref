import type { Meters, Radians } from '@inertialref/shared'
import { Vec, type Vec3, vec3 } from '@inertialref/spatial'
import { smooth } from './cinematic.ts'
import { MIN_STANCE_HEIGHT } from './surfaceStance.ts'

/*
 * The drop: a ballistic entry from the eye to a point on the ground.
 *
 * A viewer in orbit drags a figure onto a world and the camera goes down to
 * stand where it landed. The path it takes is the conic an unpowered body
 * would follow — a Keplerian orbit about the body's centre through the eye and
 * the touchdown point, with its apoapsis at the eye. Its periapsis lies under
 * the ground, which is what makes it an *entry* rather than an orbit, and it is
 * the shape the aid draws while the figure is being dragged: the arc from the
 * eye to the point, and the rest of the conic continuing through the body.
 *
 * All of it is arithmetic over displacements from the centre, in whatever axes
 * the caller supplies — body-fixed, in practice, so the touchdown point stays
 * put while the body turns — and none of it knows what a body, a frame or a
 * stance is. `devtools/observatory.ts` resolves those, exactly as it does for
 * the two arms it already has.
 *
 * Two points and a centre fix the conic once the apoapsis is placed at the eye.
 * With `r_a` the eye's radius, `r_t` the touchdown radius and `φ` the angle at
 * the centre between them, the polar form `r(ψ) = p / (1 − e cos ψ)` measured
 * from apoapsis gives `r(0) = r_a` and `r(φ) = r_t`, so
 *
 *     1 − e = 2 r_t sin²(φ/2) / (r_a − r_t cos φ)      p = r_a (1 − e)
 *
 * **The complement `1 − e` is the number held, not `e`.** A drop from far out
 * onto the ground nearly under the eye has `e` within 1e-13 of one, and the
 * denominator `1 − e cos ψ` written as a subtraction loses every digit it has
 * there; written as `(1 − e) + 2e sin²(ψ/2)` it is a sum of two positive terms
 * and loses none. `e` is in `[0, 1)` whenever the eye is outside the ground,
 * because `r_t cos φ < r_t < r_a`. A touchdown directly under the eye has
 * `φ = 0` and `e = 1` exactly: the ellipse has collapsed to a radial line,
 * which is the right answer and is drawn as one.
 */

/** A ballistic entry, as the numbers that fix it. */
export interface EntryArc {
  /** The eye's distance from the centre — the conic's apoapsis. */
  readonly apoapsis: Meters
  /** The touchdown point's distance from the centre. Below `apoapsis`. */
  readonly touchdown: Meters
  /** Angle at the centre from the eye to the touchdown point, `[0, π)`. */
  readonly sweep: Radians
  readonly eccentricity: number
  /** `1 − eccentricity`, held exactly; see the header. Zero on the radial line. */
  readonly complement: number
  /** The semi-latus rectum `p`. Zero for the radial case. */
  readonly latusRectum: Meters
  /** Unit vector from the centre toward the eye. */
  readonly toEye: Vec3
  /** Unit vector perpendicular to `toEye`, in the plane, toward the touchdown. */
  readonly across: Vec3
}

/**
 * The conic from `eye` down to `ground`, both displacements from the centre in
 * the same axes, or `null` when the eye is not above the ground.
 *
 * `ground` carries the touchdown *radius* as its length, so a caller that
 * wants to arrive two meters over a mountain hands in the mountain's radius
 * plus two meters and the arc ends exactly there.
 */
export function entryArc(eye: Vec3, ground: Vec3): EntryArc | null {
  const apoapsis = Vec.length(eye)
  const touchdown = Vec.length(ground)
  if (!(apoapsis > touchdown) || !(touchdown > 0)) return null
  const toEye = Vec.scale(eye, 1 / apoapsis)
  const toGround = Vec.scale(ground, 1 / touchdown)
  const cosSweep = Math.max(-1, Math.min(1, Vec.dot(toEye, toGround)))
  const sweep = Math.acos(cosSweep)
  // The in-plane perpendicular, by removing the radial part of the touchdown
  // direction. Degenerate exactly when the touchdown is under the eye, where
  // any perpendicular does, because it multiplies `sin 0`.
  const sideways = Vec.sub(toGround, Vec.scale(toEye, cosSweep))
  const across =
    Vec.length(sideways) > 1e-9
      ? Vec.normalize(sideways)
      : Vec.normalize(
          Vec.cross(
            Math.abs(toEye.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0),
            toEye,
          ),
        )
  const half = Math.sin(sweep / 2)
  const complement =
    (2 * touchdown * half * half) / (apoapsis - touchdown * cosSweep)
  return {
    apoapsis,
    touchdown,
    sweep,
    eccentricity: 1 - complement,
    complement,
    latusRectum: apoapsis * complement,
    toEye,
    across,
  }
}

/** Whether the conic has collapsed to the radial line under the eye. */
export const isRadial = (arc: EntryArc): boolean => arc.complement <= 0

/**
 * Distance from the centre at an angle `psi` from apoapsis.
 *
 * On the radial line the angle means nothing and the radius is not a function
 * of it; callers there parametrize by radius through `arcAnomaly`, which is
 * the identity map, and this returns the apoapsis so a caller that asks
 * anyway gets the one radius the line is certain about.
 */
export function arcRadius(arc: EntryArc, psi: Radians): Meters {
  if (isRadial(arc)) return arc.apoapsis
  const half = Math.sin(psi / 2)
  return arc.latusRectum / (arc.complement + 2 * arc.eccentricity * half * half)
}

/**
 * The angle from apoapsis at which the conic passes `radius`, on the way down.
 *
 * The inverse of `arcRadius` over the descending half: `[0, π]`. A radius
 * outside `[periapsis, apoapsis]` is clamped, so a caller stepping a height
 * schedule never receives `NaN` from a rounding error at either end.
 */
export function arcAnomaly(arc: EntryArc, radius: Meters): Radians {
  if (isRadial(arc)) return 0
  // From `r = p / ((1 − e) + 2e sin²(ψ/2))` with `p = r_a (1 − e)`.
  const halfSquared =
    (arc.complement * (arc.apoapsis / radius - 1)) / (2 * arc.eccentricity)
  return 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, halfSquared))))
}

/**
 * A point of the conic, as a displacement from the centre.
 *
 * `psi` from apoapsis; `radius` overrides the conic's own — the radial case
 * has no other way to say where along the line it is, and a descent that has
 * clamped its height above a mountain wants the direction of the conic at the
 * radius it is actually at.
 */
export function arcPoint(
  arc: EntryArc,
  psi: Radians,
  radius: Meters = arcRadius(arc, psi),
): Vec3 {
  const direction = isRadial(arc)
    ? arc.toEye
    : Vec.add(
        Vec.scale(arc.toEye, Math.cos(psi)),
        Vec.scale(arc.across, Math.sin(psi)),
      )
  return Vec.scale(direction, radius)
}

/**
 * The visible arc, eye to touchdown, as `count` displacements.
 *
 * Spaced evenly in angle rather than in radius: the eye's end of the conic is
 * nearly straight and the ground's end turns hardest, and even angles put the
 * samples where the curve is.
 */
export function arcSamples(arc: EntryArc, count: number): readonly Vec3[] {
  const steps = Math.max(1, Math.floor(count) - 1)
  const out: Vec3[] = []
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps
    if (isRadial(arc)) {
      out.push(
        arcPoint(arc, 0, arc.apoapsis + (arc.touchdown - arc.apoapsis) * t),
      )
      continue
    }
    out.push(arcPoint(arc, arc.sweep * t))
  }
  return out
}

/**
 * The rest of the conic, from the touchdown down through periapsis and back
 * up to the far side, as `count` displacements.
 *
 * What the aid draws *through* the body: the trajectory the camera does not
 * follow, which is what says the path is an entry and not an orbit. On the
 * radial line it is the chord through the centre.
 */
export function arcContinuation(arc: EntryArc, count: number): readonly Vec3[] {
  const steps = Math.max(1, Math.floor(count) - 1)
  const out: Vec3[] = []
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps
    if (isRadial(arc)) {
      out.push(Vec.scale(arc.toEye, arc.touchdown * (1 - 2 * t)))
      continue
    }
    // From the touchdown round to its mirror on the far side, through
    // periapsis at ψ = π.
    out.push(arcPoint(arc, arc.sweep + (2 * Math.PI - 2 * arc.sweep) * t))
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* The schedule                                                               */
/* ------------------------------------------------------------------------- */

/**
 * How long a drop takes, seconds of wall clock.
 *
 * Long enough that the scale change reads — a drop from an orbit worth of
 * altitude to eye height crosses six or seven decades of height — and short
 * enough that it is a move and not a wait. Tuned against a drop onto Earth
 * from the default framing: at six seconds the ground arrived before the
 * horizon had time to be a horizon; at ten the last decade dragged.
 */
export const DROP_SECONDS = 8

/**
 * The share of the drop over which the orbit camera's roll is blended into
 * the surface camera's.
 *
 * The orbit arm keeps the pole up and the surface arm keeps the local vertical
 * up, and at a mid-latitude the two differ by tens of degrees. A cut between
 * them at release would be a horizon that snaps; a slerp over the first fifth
 * is a horizon that settles.
 */
export const DROP_BLEND_SHARE = 0.2

/**
 * Where in the drop the camera stops watching the ground and turns to face
 * the star along the horizon.
 *
 * Late, because the ground rushing up is the picture; from here to the end the
 * heading swings to the star's bearing and the pitch rises from the touchdown
 * point to the horizon, so the last thing the viewer sees is the world they
 * landed on, lit from where the light is.
 */
export const DROP_LEVEL_FROM = 0.65

const saturate = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

/** How far a drop has come, `[0, 1]`, from its elapsed and total seconds. */
export const dropProgress = (elapsed: number, seconds: number): number =>
  seconds > 0 ? saturate(elapsed / seconds) : 1

/**
 * The radius the camera is at, `progress` of the way down.
 *
 * Logarithmic in height, for the reason the surface arm's scrub and the orbit
 * arm's ease are: the band from an orbit to eye height is six decades, and a
 * linear schedule spends 99.9% of the drop above the altitude where terrain
 * is drawn at all and then arrives in a frame. Eased at both ends so the
 * release is not a lurch and the landing is not a stop. The height is measured
 * from two meters under the touchdown radius, so the log has a floor to end
 * on and the last frame lands exactly at `touchdown`.
 */
export function dropRadius(arc: EntryArc, progress: number): Meters {
  const floor = arc.touchdown - MIN_STANCE_HEIGHT
  const top = arc.apoapsis - floor
  const eased = smooth(saturate(progress))
  return floor + top * (MIN_STANCE_HEIGHT / top) ** eased
}

/** How much of the surface camera's roll is showing, `[0, 1]`. */
export const dropBlend = (progress: number): number =>
  smooth(saturate(progress / DROP_BLEND_SHARE))

/** How far the head has turned from the ground to the star, `[0, 1]`. */
export const dropLevel = (progress: number): number =>
  smooth(saturate((progress - DROP_LEVEL_FROM) / (1 - DROP_LEVEL_FROM)))
