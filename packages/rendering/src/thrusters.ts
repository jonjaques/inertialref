import type { Meters } from '@inertialref/shared'
import { Vec, type Vec3 } from '@inertialref/spatial'
import type { ThrustDemand } from '@inertialref/simulation'

/*
 * Which nozzles fire, given what the flight model asked for.
 *
 * The simulation resolves a six-axis demand and applies it as one force and
 * one torque; a hull has thirty valves. This is the map between them, and it
 * is presentation: nothing here changes where the ship goes, only which
 * plumes are drawn while it goes there. So it is a projection rather than an
 * allocation. A real reaction-control system solves for the set of valves
 * whose sum is the demand and nothing else; a picture only has to open the
 * valves whose thrust helps, in proportion to how much it helps, and let the
 * physics — which already applied the demand exactly — be the thing that
 * makes the ship move as if the set were perfect.
 *
 * Arithmetic and no Three.js, so a layout measured off a hull can be held to
 * its symmetries in Node, and the map from a demand to a firing set can be
 * tested without a GPU.
 */

export type NozzleKind = 'rcs' | 'pod'

/** One valve on the hull. */
export interface Nozzle {
  /** The mouth, in hull axes: meters from the hull's centre, forward −Z. */
  readonly position: Vec3
  /** The way the gas leaves — a unit vector in hull axes. */
  readonly exhaust: Vec3
  /** The mouth's radius, meters; the plume is drawn in multiples of it. */
  readonly radius: Meters
  /**
   * A reaction-control jet or a maneuvering pod. The two draw differently —
   * a pod is a chemical engine with a flame, a jet is a puff — and they are
   * told apart here rather than by radius so a small pod stays a pod.
   */
  readonly kind: NozzleKind
}

/** The main drive: one exit plane, always along +Z, always on the axis. */
export interface MainDrive {
  /** The centre of the exit plane, in hull axes. */
  readonly position: Vec3
  /** The exit plane's radius, meters. */
  readonly radius: Meters
}

export interface ThrusterLayout {
  readonly nozzles: readonly Nozzle[]
  /** Null for a hull with no modeled drive — the plumes alone are drawn. */
  readonly drive: MainDrive | null
}

/**
 * The lever at which a nozzle's torque counts in full, meters.
 *
 * A nozzle's torque is taken by *direction*, not magnitude: the bow cluster on
 * a 46 m hull sits sixteen meters from the centre and a belly pod two, and a
 * pitch-up that lit the bow at full and the pods at an eighth would draw the
 * ship being pitched by its nose alone, which is not how a maneuvering system
 * is flown. Below this lever the direction is scaled down toward nothing, so
 * a valve sitting on the centre of mass — which has no torque direction at
 * all — is not lit by a rotation it cannot help with.
 */
export const TORQUE_LEVER: Meters = 2

/** What one nozzle contributes, precomputed once per layout. */
export interface NozzleWrench {
  /** The thrust direction: opposite the exhaust, unit. */
  readonly thrust: Vec3
  /** The direction of the torque its thrust produces about the centre, unit — or zero on the axis. */
  readonly torque: Vec3
  /** How much of `torque` counts, 0..1, from the lever against `TORQUE_LEVER`. */
  readonly leverage: number
}

/**
 * A lever under a nanometer is no lever.
 *
 * The moment of a valve on the axis comes out as rounding rather than as
 * zero, and normalizing it would turn a direction nobody can name into a unit
 * vector that then counts for nothing anyway; below a subnormal it is a NaN.
 */
const NO_LEVER: Meters = 1e-9

export function nozzleWrench(nozzle: Nozzle): NozzleWrench {
  const thrust = Vec.negate(Vec.normalize(nozzle.exhaust))
  const moment = Vec.cross(nozzle.position, thrust)
  const lever = Vec.length(moment)
  if (lever < NO_LEVER) return { thrust, torque: Vec.ZERO, leverage: 0 }
  return {
    thrust,
    torque: Vec.scale(moment, 1 / lever),
    leverage: Math.min(1, lever / TORQUE_LEVER),
  }
}

/**
 * A layout, prepared for `nozzleFiring`: every valve's wrench, and whether
 * the forward axis belongs to a drive.
 *
 * A hull with a main drive burns ahead on the drive alone, so the valves never
 * see the forward half of the linear demand — a stern pod whose exhaust leans
 * a little aft would otherwise glow at a quarter through every burn, which is
 * not how a ship with an Epstein drive is flown. A hull with no drive has
 * nothing else to push it, and its aft-blowing valves take the burn.
 */
export interface NozzleAllocation {
  readonly wrenches: readonly NozzleWrench[]
  readonly forwardByDrive: boolean
}

export const prepareNozzles = (layout: ThrusterLayout): NozzleAllocation => ({
  wrenches: layout.nozzles.map(nozzleWrench),
  forwardByDrive: layout.drive !== null,
})

// `<= 0` rather than `< 0`, so a negated zero comes out as the zero it is: a
// valve is not open by `−0`, and `Object.is` in a test says so.
const clamp01 = (value: number): number =>
  value <= 0 ? 0 : value > 1 ? 1 : value

/**
 * How hard each nozzle fires for a demand, 0..1, written into `out`.
 *
 * The projection: a valve's thrust against the linear demand, plus its torque
 * direction against the angular one, clamped. A valve whose thrust opposes
 * what was asked for stays shut; one that serves both — a bow jet pushing the
 * nose down while the ship is also asked to translate down — fires harder
 * than either alone, which is what an allocator would do with it too.
 *
 * `out` is written in place because this runs per frame for every nozzle on
 * the hull, and the array it fills is the one the GPU attribute is uploaded
 * from.
 */
export function nozzleFiring(
  allocation: NozzleAllocation,
  demand: ThrustDemand,
  out: Float32Array,
): void {
  const { wrenches, forwardByDrive } = allocation
  const linear =
    forwardByDrive && demand.linear.z < 0
      ? { x: demand.linear.x, y: demand.linear.y, z: 0 }
      : demand.linear
  const angular = demand.angular
  for (let i = 0; i < wrenches.length; i += 1) {
    const wrench = wrenches[i] as NozzleWrench
    out[i] = clamp01(
      Vec.dot(wrench.thrust, linear) +
        wrench.leverage * Vec.dot(wrench.torque, angular),
    )
  }
}

/**
 * The main drive's throttle, 0..1: the forward demand alone.
 *
 * Forward is −Z, so a burn ahead is a negative `linear.z`. A retro command
 * lights nothing here — the drive is not reversible — and the bow jets whose
 * exhaust points ahead pick it up through `nozzleFiring` instead.
 */
export const driveThrottle = (demand: ThrustDemand): number =>
  clamp01(-demand.linear.z)
