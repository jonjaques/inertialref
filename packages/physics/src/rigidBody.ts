import type { Kilograms, Meters, Mu, Seconds } from '@inertialref/shared'
import {
  Quaternion as Q,
  type Quat,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'

/**
 * Kinematic state of a 6-DoF body, expressed in some reference frame.
 *
 * Deliberately the same shape as the position/velocity half of a FrameState so
 * the simulation can hand one to the integrator and put the result straight
 * back without a translation step that could drop a term.
 */
export interface BodyState {
  readonly position: Vec3
  readonly velocity: Vec3
  readonly orientation: Quat
  readonly angularVelocity: Vec3
}

/**
 * Advance a body by one fixed step.
 *
 * Semi-implicit (symplectic) Euler: velocity first, then position from the new
 * velocity. Explicit Euler pumps energy into every orbit — a ship left coasting
 * would slowly climb out of a gravity well — and that failure is invisible for
 * minutes and obvious after an hour of time warp. The cost of the better
 * integrator is one line.
 *
 * `linearAcceleration` is in frame axes; `angularAcceleration` is in body axes,
 * because torque comes from thrusters bolted to the hull.
 */
export function integrateBody(
  state: BodyState,
  linearAcceleration: Vec3,
  angularAcceleration: Vec3,
  dt: Seconds,
): BodyState {
  const velocity = Vec.add(state.velocity, Vec.scale(linearAcceleration, dt))
  const position = Vec.add(state.position, Vec.scale(velocity, dt))
  const angularVelocity = Vec.add(
    state.angularVelocity,
    Vec.scale(angularAcceleration, dt),
  )
  return {
    position,
    velocity,
    orientation: Q.integrate(state.orientation, angularVelocity, dt),
    angularVelocity,
  }
}

/** Newtonian point-mass attraction toward a primary at the frame origin. */
export function pointMassAcceleration(mu: Mu, relativePosition: Vec3): Vec3 {
  const r = Vec.length(relativePosition)
  if (r === 0) return Vec.ZERO
  return Vec.scale(relativePosition, -mu / (r * r * r))
}

export const standardGravitationalParameter = (mass: Kilograms): Mu =>
  6.674_3e-11 * mass

/** Surface gravity of a uniform sphere, m/s². */
export const surfaceGravity = (mu: Mu, radius: Meters): number =>
  mu / (radius * radius)

/* ------------------------------------------------------------------------- */
/* Atmosphere                                                                 */
/* ------------------------------------------------------------------------- */

export interface Atmosphere {
  /** Density at the datum surface, kg/m³. */
  readonly surfaceDensity: number
  /** e-folding height, meters. */
  readonly scaleHeight: Meters
  /** Altitude above which density is treated as zero, meters. */
  readonly ceiling: Meters
}

/** Isothermal exponential atmosphere — enough for entry heating and drag feel. */
export function atmosphericDensity(
  atmosphere: Atmosphere,
  altitude: Meters,
): number {
  if (altitude >= atmosphere.ceiling) return 0
  if (altitude <= 0) return atmosphere.surfaceDensity
  return (
    atmosphere.surfaceDensity * Math.exp(-altitude / atmosphere.scaleHeight)
  )
}

/**
 * Drag acceleration for a body moving through an atmosphere.
 *
 * `ballisticCoefficient` is mass / (dragCoefficient × area) in kg/m²; higher
 * means it punches through. Velocity must be relative to the *air*, which on a
 * rotating planet is not the same as velocity in the planet-centered frame —
 * expressing it in the rotating surface frame is what gets that right for free.
 */
export function dragAcceleration(
  density: number,
  relativeVelocity: Vec3,
  ballisticCoefficient: number,
): Vec3 {
  const speed = Vec.length(relativeVelocity)
  if (speed === 0 || density === 0) return Vec.ZERO
  const magnitude = (0.5 * density * speed * speed) / ballisticCoefficient
  return Vec.scale(relativeVelocity, -magnitude / speed)
}

/* ------------------------------------------------------------------------- */
/* Control                                                                    */
/* ------------------------------------------------------------------------- */

/*
 * A ship has two kinds of engine, and they are not two sizes of one thing.
 *
 * The **thrusters** are a reaction-control system: small valves all over the
 * hull that push it any of six ways and turn it about any of three axes, at
 * an authority measured in single meters per second squared. The **main
 * drive** is one engine on the axis, pointing aft, that pushes ahead and
 * nowhere else, at an authority measured in g. A retro is not the drive run
 * backwards — there is no such thing — it is the bow thrusters, or a flip and
 * a burn, which is the whole discipline `docs/design/flight.md` is built on.
 *
 * So the control carries them separately. `translation` is what the
 * thrusters are asked for, ahead and astern included; `throttle` is how hard
 * the drive burns, a setting that stays where it is put rather than a key
 * that is held. Folding the drive into the forward translation gave a ship
 * that decelerated at three g on fourteen bow jets the size of a fist.
 */

/** Per-axis authority of a spacecraft's engines, in body axes. */
export interface ThrusterProfile {
  /** The main drive at full throttle, along −Z (ahead) and only that way, m/s². */
  readonly mainThrust: number
  /** The thrusters' authority on every axis, ahead and astern included, m/s². */
  readonly rcsThrust: number
  /** Angular authority about each body axis, rad/s². */
  readonly torque: number
}

export interface ControlInput {
  /**
   * −1..1 per body axis for the thrusters: right, up, ahead. Forward is −Z,
   * so a +1 on the third asks for thrust ahead and a −1 for a retro.
   */
  readonly translation: Vec3
  /** −1..1 per body axis: pitch (X), yaw (Y), roll (Z). */
  readonly rotation: Vec3
  /** 0..1: how hard the main drive burns. Zero is a cold drive. */
  readonly throttle: number
}

export const NEUTRAL_CONTROL: ControlInput = Object.freeze({
  translation: vec3(0, 0, 0),
  rotation: vec3(0, 0, 0),
  throttle: 0,
})

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v))

/** A throttle is a fraction; anything else — a NaN included — is a cold drive. */
export const clampThrottle = (v: number): number => (v >= 1 ? 1 : v > 0 ? v : 0)

/**
 * What the engines produce for an input, in body axes.
 *
 * `linear` is the sum the integrator applies; `thrusters` and `drive` are its
 * two parts kept apart, because a picture of the hull has to know which
 * engine is firing and the sum cannot say. Both are accelerations in m/s²,
 * and `drive` is unsigned: it only ever pushes ahead.
 */
export interface ResolvedThrust {
  readonly linear: Vec3
  readonly angular: Vec3
  /** The thrusters' share of `linear`, signed along the body axes. */
  readonly thrusters: Vec3
  /** The drive's share, as a magnitude along −Z. */
  readonly drive: number
}

/** Resolve control input into body-axes linear and angular acceleration. */
export function resolveThrust(
  profile: ThrusterProfile,
  input: ControlInput,
): ResolvedThrust {
  const thrusters = vec3(
    clamp1(input.translation.x) * profile.rcsThrust,
    clamp1(input.translation.y) * profile.rcsThrust,
    // Forward is −Z, matching the camera convention.
    -clamp1(input.translation.z) * profile.rcsThrust,
  )
  const drive = clampThrottle(input.throttle) * profile.mainThrust
  return {
    linear: vec3(thrusters.x, thrusters.y, thrusters.z - drive),
    angular: vec3(
      clamp1(input.rotation.x) * profile.torque,
      clamp1(input.rotation.y) * profile.torque,
      clamp1(input.rotation.z) * profile.torque,
    ),
    thrusters,
    drive,
  }
}

/**
 * Rotational damping, the "flight assist" every 6-DoF game needs.
 *
 * Applied as an acceleration bounded by the available torque rather than as a
 * velocity multiplier: a multiplier is frame-rate-shaped even at a fixed step,
 * and it makes the ship's handling depend on the tick rate.
 */
export function dampingTorque(
  angularVelocity: Vec3,
  profile: ThrusterProfile,
  dt: Seconds,
): Vec3 {
  const needed = Vec.scale(angularVelocity, -1 / dt)
  const magnitude = Vec.length(needed)
  if (magnitude <= profile.torque) return needed
  return Vec.scale(needed, profile.torque / magnitude)
}
