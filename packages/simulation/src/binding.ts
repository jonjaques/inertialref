import type { Meters, Mu } from '@inertialref/shared'
import type { Atmosphere } from '@inertialref/physics'
import type { FrameId } from '@inertialref/spatial'
import type { Body, StarSystem, SystemId } from '@inertialref/universe'

/**
 * What the simulation needs to know about a frame in order to fly in it.
 *
 * The frame graph deliberately knows nothing about mass or atmospheres, and the
 * universe package deliberately knows nothing about ships. This is the join:
 * one lookup table, built when a system is loaded, that answers "if an entity
 * is in this frame, what is pulling on it and where can it go next".
 */
export interface FrameBinding {
  readonly frame: FrameId
  readonly kind: 'system' | 'body'
  readonly system: SystemId
  /** Gravitational parameter of the mass at this frame's origin. */
  readonly mu: Mu
  /** Radius of the attracting body, 0 for a system barycentre. */
  readonly radius: Meters
  /** Beyond this the entity is no longer bound here. Infinity for a system. */
  readonly sphereOfInfluence: Meters
  readonly atmosphere: Atmosphere | null
  /** Rotating frame of the same body, where one exists. */
  readonly spinFrame: FrameId | null
  readonly parent: FrameId | null
  /** Frames an entity in this one could descend into (moons, planets). */
  readonly children: readonly FrameId[]
  readonly body: Body | null
  readonly star: StarSystem['star'] | null
}
