import type { Meters, Mu } from '@inertialref/shared'
import type { Atmosphere } from '@inertialref/physics'
import type { FrameId } from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'

/**
 * What the simulation needs to know about a frame in order to fly in it.
 *
 * The frame graph deliberately knows nothing about mass or atmospheres, and the
 * universe package deliberately knows nothing about ships. This is the join:
 * one lookup table, built when a system is loaded, that answers "if an entity
 * is in this frame, what is pulling on it and where can it go next".
 */
/*
 * Four fields were removed from this interface because nothing read them:
 * `kind`, `system`, `star`, and `children`.
 *
 * `children` was the actively harmful one. It read as the answer to the question
 * `considerFrameChange` asks — "where could an entity here descend to?" — and it
 * was constructed as `[]` at both call sites, always. The real children come
 * from `World.#children` via `bindingsUnder`, so anyone who trusted the field
 * got an empty list and anyone who did not had to work out why two things that
 * look like the same answer disagree.
 */
export interface FrameBinding {
  readonly frame: FrameId
  /** Gravitational parameter of the mass at this frame's origin. */
  readonly mu: Mu
  /** Radius of the attracting body, 0 for a system barycenter. */
  readonly radius: Meters
  /** Beyond this the entity is no longer bound here. Infinity for a system. */
  readonly sphereOfInfluence: Meters
  readonly atmosphere: Atmosphere | null
  /** Rotating frame of the same body, where one exists. */
  readonly spinFrame: FrameId | null
  readonly parent: FrameId | null
  readonly body: Body | null
}
