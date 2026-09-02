import { invariant, type Meters, type Seconds } from '@inertialref/shared'
import {
  apoapsis,
  atmosphericDensity,
  type BodyState,
  conicOf,
  dampingTorque,
  dragAcceleration,
  integrateBody,
  periapsis,
  pointMassAcceleration,
  propagateTwoBody,
  resolveThrust,
} from '@inertialref/physics'
import {
  canonicalPosition,
  type FrameGraph,
  type FrameId,
  type FrameState,
  Quaternion as Q,
  reframe,
  type UniverseVector,
  UV,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  type BodyFixedDirection,
  bodyFixedDirection,
  surfaceRadius,
} from '@inertialref/universe'
import type { FrameBinding } from './binding.ts'
import type { Entity, RailsEpoch } from './entity.ts'

/*
 * Flight.
 *
 * Two rules shape everything here.
 *
 * 1. Ships integrate only in *non-rotating* frames. Integrating in a rotating
 *    frame without Coriolis and centrifugal terms is simply wrong, and adding
 *    those terms is a lot of subtle code to support one case. A landed ship is
 *    instead attached kinematically to a surface frame and not integrated at
 *    all, which is both correct and cheaper. Taking off hands the ship back to
 *    the inertial frame, and `reframe` supplies the 465 m/s of ground speed it
 *    inherits without anything having to know that number.
 *
 * 2. Gravity is patched-conic: inside a sphere of influence only that body
 *    attracts. The frame is already falling along its own Kepler orbit, so
 *    adding the primary's pull as well would double-count it.
 *
 * A third follows from the second. Inside one sphere of influence, a ship that
 * is not thrusting and not in air is on a conic, exactly — so it does not need
 * integrating at all, any more than the planet it orbits does. `coastState`
 * evaluates that conic from a recorded epoch (ADR-0025), and `railsEpoch`
 * decides when a ship is on one.
 */

export interface FlightWorld {
  readonly frames: FrameGraph
  binding(frame: FrameId): FrameBinding | undefined
  bindingsUnder(frame: FrameId): readonly FrameBinding[]
}

/** Hysteresis on the sphere-of-influence boundary, so a grazing pass cannot flap. */
const SOI_ENTER = 0.95
const SOI_LEAVE = 1.05

/** How close the hull has to be to the ground, and how slowly, before it sticks. */
export const LANDING_CLEARANCE: Meters = 4
export const LANDING_SPEED_LIMIT = 12

/**
 * How far above a body's highest ground the terrain is still sampled.
 *
 * Above the band a sphere is an exact answer for everything flight needs: the
 * drag model has stopped (the band is at least the atmosphere's ceiling) and
 * nothing can be in contact. The field's peak is `maxElevation` by
 * construction; the margin covers the clearance test's own reach and leaves a
 * round number over it, so a ship skimming a summit at the limit still meets
 * the ground rather than the datum.
 */
const GROUND_BAND_MARGIN: Meters = 100 + LANDING_CLEARANCE * 2

/**
 * Altitude above the datum below which a body's ground has to be asked.
 *
 * A gate at a quarter of the body's radius — 1,600 km on an Earth-sized
 * world — has every tick of a 400 km orbit sampling fourteen octaves of noise
 * twice for an answer the datum sphere already gives to nine kilometers.
 * Measured: 12.5 µs a tick sampling, against 1 µs on the datum.
 */
export function groundBand(binding: FrameBinding): Meters {
  const relief = binding.body === null ? 0 : binding.body.surface.maxElevation
  const air = binding.atmosphere === null ? 0 : binding.atmosphere.ceiling
  return Math.max(relief, air) + GROUND_BAND_MARGIN
}

export interface FrameChange {
  readonly from: FrameId
  readonly to: FrameId
  readonly reason: string
}

/**
 * What a frame's sphere-of-influence tests already know, so most ticks can
 * skip them.
 *
 * For each child of the frame, and for the frame's own boundary in the last
 * slot, the gap between the entity and the sphere as of `at`, measured from
 * `origin`. A gap is consumed by how far the entity has since moved from the
 * origin plus how far the child could have moved toward it — its periapsis
 * speed times the elapsed time — and while what is left is positive the
 * triangle inequality says the entity cannot be inside. That is a subtraction
 * and a multiply per child in place of a Kepler solve and a pose composition,
 * and it is what makes sixty-six children cost nothing on a tick that is not
 * near any of them.
 *
 * Derived, never saved: a world that has none makes every test on its first
 * tick and gets the answers the bounds were standing in for.
 */
export interface SoiWatch {
  readonly frame: FrameId
  at: Seconds
  origin: Vec3
  /** One per child, then the parent boundary. Mutated in place. */
  readonly gaps: Float64Array
}

export interface FlightResult {
  readonly state: FrameState
  readonly landed: boolean
  /** Set when the entity changed frame this tick; devtools surface it. */
  readonly frameChange: FrameChange | null
  /** The ship just touched down; the world owns installing the surface frame. */
  readonly touchdown: boolean
  /** Speed at contact, m/s. Above LANDING_SPEED_LIMIT this was a crash. */
  readonly impactSpeed: number
  /** The ship just left the ground and must be handed back to the inertial frame. */
  readonly liftOff: boolean
  readonly altitude: Meters | null
  readonly gravity: Vec3
  /**
   * The bounds the sphere-of-influence tests are carrying forward, or null when
   * this tick changed frame or made no test.
   */
  readonly soi: SoiWatch | null
}

/**
 * Vector from the attracting body's center to the entity, in the entity's frame
 * axes.
 *
 * Goes through universe coordinates rather than subtracting frame-local
 * positions: the entity may be in a surface frame several levels below the
 * body, and only the canonical position is comparable across frames.
 */
function radiusVector(
  world: FlightWorld,
  state: FrameState,
  binding: FrameBinding,
  t: Seconds,
): Vec3 {
  if (state.frame === binding.frame) return state.position
  const framePose = world.frames.pose(state.frame, t)
  const bodyPose = world.frames.pose(binding.frame, t)
  const universe = canonicalPosition(world.frames, state, t)
  return Q.rotateInverse(
    framePose.orientation,
    UV.difference(universe, bodyPose.position),
  )
}

/** Air velocity at a point, from the body's rotation, in the entity's frame axes. */
function airVelocity(
  world: FlightWorld,
  binding: FrameBinding,
  radius: Vec3,
  t: Seconds,
): Vec3 {
  if (binding.spinFrame === null) return Vec.ZERO
  const spin = world.frames.pose(binding.spinFrame, t)
  const bodyFrame = world.frames.pose(binding.frame, t)
  const omega = Q.rotateInverse(bodyFrame.orientation, spin.angularVelocity)
  return Vec.cross(omega, radius)
}

export interface StepFlightOptions {
  readonly dt: Seconds
  readonly time: Seconds
  /**
   * The ground altitude the previous tick measured at this tick's starting
   * position and instant, if it measured one.
   *
   * The previous tick's contact test samples the terrain under where the
   * entity *ended up*, at the instant it got there — which is exactly this
   * tick's starting position and instant, so the number is reused rather than
   * sampled again. It is bit-identical to a fresh sample by construction,
   * which is what lets a world restored from a save, with no previous tick to
   * remember, sample fresh and continue on the same hash.
   */
  readonly previousAltitude?: Meters | undefined
  /** The bounds the previous tick's sphere-of-influence tests left behind. */
  readonly soi?: SoiWatch | null | undefined
}

/**
 * Advance one entity by one tick.
 *
 * Pure with respect to the world: it reads frames and bindings and returns a
 * new state, which is what lets the same function run in a worker or on a
 * server. The one thing it writes is the `soi` watch it is handed — the
 * bounds are re-based in place and the same object comes back in the result —
 * so a watch belongs to exactly one sequence of calls, and a call whose result
 * is discarded has still consumed the watch's gaps.
 */
export function stepFlight(
  world: FlightWorld,
  entity: Entity,
  landed: boolean,
  options: StepFlightOptions,
): FlightResult {
  const { dt, time } = options
  const binding = world.binding(entity.state.frame)
  if (binding === undefined) {
    // Deep space between systems: no gravity source, straight-line coasting.
    return {
      state: integrateFree(entity, Vec.ZERO, dt),
      landed: false,
      frameChange: null,
      touchdown: false,
      liftOff: false,
      impactSpeed: 0,
      altitude: null,
      gravity: Vec.ZERO,
      soi: null,
    }
  }

  if (landed) return stepLanded(entity, options)

  const radius = radiusVector(world, entity.state, binding, time)
  const distance = Vec.length(radius)
  const gravity = pointMassAcceleration(binding.mu, radius)
  // The integrated state is the state at the *end* of the tick, and the
  // contact test and the frame test both look at it. Asking them at the tick's
  // start put the planet where it was 1/64 s ago under a ship that had moved
  // on: 470 m of Earth's orbital motion at every sphere-of-influence crossing,
  // and seven meters of ground rotation under every landing.
  const after = time + dt

  let acceleration = gravity
  let altitude: Meters | null = null

  if (binding.body !== null && binding.radius > 0) {
    // Sampled through the same helper as the contact test below, in body-fixed
    // axes — the altitude the atmosphere is evaluated against, so a wrong
    // sample here moves with the planet's rotation phase.
    altitude =
      options.previousAltitude ??
      groundAltitude(world, entity, binding, radius, distance, time)
  }

  if (
    binding.atmosphere !== null &&
    altitude !== null &&
    altitude < binding.atmosphere.ceiling
  ) {
    const density = atmosphericDensity(binding.atmosphere, altitude)
    const relative = Vec.sub(
      entity.state.velocity,
      airVelocity(world, binding, radius, time),
    )
    acceleration = Vec.add(
      acceleration,
      dragAcceleration(density, relative, entity.ballisticCoefficient),
    )
  }

  const state = integrateFree(entity, acceleration, dt)
  const moved = { ...entity, state }

  // Ground contact is tested *after* integrating, against the new position.
  // Testing the old one lets a fast descent step straight through the crust —
  // at 20 km/s a tick covers 300 m, so "was I close last tick" is not a
  // collision test, it is a coin flip.
  if (
    binding.body !== null &&
    binding.spinFrame !== null &&
    altitude !== null
  ) {
    const radiusAfter = radiusVector(world, state, binding, after)
    const afterAltitude = groundAltitude(
      world,
      moved,
      binding,
      radiusAfter,
      Vec.length(radiusAfter),
      after,
    )
    const speed = Vec.length(state.velocity)
    const contact =
      afterAltitude <= 0 ||
      (afterAltitude <= LANDING_CLEARANCE && speed < LANDING_SPEED_LIMIT)
    if (contact) {
      return {
        state,
        landed: true,
        touchdown: true,
        liftOff: false,
        impactSpeed: speed,
        frameChange: null,
        altitude: afterAltitude,
        gravity,
        soi: null,
      }
    }
    altitude = afterAltitude
  }

  const transition = considerFrameChange(
    world,
    moved,
    binding,
    after,
    options.soi ?? null,
    null,
  )
  return {
    state: transition.change?.state ?? state,
    landed: false,
    touchdown: false,
    liftOff: false,
    impactSpeed: 0,
    frameChange: transition.change?.change ?? null,
    altitude,
    gravity,
    soi: transition.change === null ? transition.watch : null,
  }
}

/**
 * Height of an entity above the generated terrain, in meters.
 *
 * The direction is taken in the *body-fixed* frame, not the body-centered
 * inertial one. Terrain is a function of position on the rotating body, so
 * sampling it with an inertial direction leaves the mountains standing still in
 * inertial space while the planet turns underneath them — which showed up as a
 * ship landing 83 m above the ground it had just touched.
 *
 * Above `groundBand` the datum sphere is the answer, exactly: nothing up there
 * can touch the ground or feel the air, and the noise is the expensive half of
 * a tick.
 */
function groundAltitude(
  world: FlightWorld,
  entity: Entity,
  binding: FrameBinding,
  radius: Vec3,
  distance: Meters,
  time: Seconds,
): Meters {
  const datum = distance - binding.radius
  if (binding.body === null || datum > groundBand(binding)) return datum
  return (
    distance -
    surfaceRadius(
      binding.body,
      groundDirection(world, entity, binding, radius, time),
    )
  )
}

/**
 * Unit vector from the body's center to the entity, in body-fixed axes.
 *
 * The only way to obtain a `BodyFixedDirection` for an entity, which is what
 * makes `surfaceRadius` impossible to call with the wrong axes. A body with no
 * spin frame is not rotating, so its inertial and body-fixed axes coincide and
 * the brand is honest.
 */
function groundDirection(
  world: FlightWorld,
  entity: Entity,
  binding: FrameBinding,
  radius: Vec3,
  time: Seconds,
): BodyFixedDirection {
  if (binding.spinFrame === null) {
    return Vec.normalize(radius) as BodyFixedDirection
  }
  const spin = world.frames.pose(binding.spinFrame, time)
  return bodyFixedDirection(
    spin,
    canonicalPosition(world.frames, entity.state, time),
  )
}

/** A landed entity is carried by the ground; only a thrust command frees it. */
function stepLanded(entity: Entity, options: StepFlightOptions): FlightResult {
  const wantsToLift =
    entity.thrusters !== null &&
    (Math.abs(entity.control.translation.x) > 0.01 ||
      Math.abs(entity.control.translation.y) > 0.01 ||
      Math.abs(entity.control.translation.z) > 0.01)

  if (!wantsToLift) {
    // Attitude control still works on the pad; nothing else moves.
    const state =
      entity.thrusters === null ? entity.state : rotateOnly(entity, options.dt)
    return {
      state,
      landed: true,
      touchdown: false,
      liftOff: false,
      impactSpeed: 0,
      frameChange: null,
      altitude: 0,
      gravity: Vec.ZERO,
      soi: null,
    }
  }

  // Unstick: leave the pad with a little clearance. Without it the ship is at
  // altitude zero on the tick after lift-off, the contact test fires again, and
  // it lands on the spot it just left, forever.
  return {
    state: {
      ...entity.state,
      position: Vec.add(
        entity.state.position,
        vec3(0, LANDING_CLEARANCE * 2, 0),
      ),
    },
    landed: false,
    touchdown: false,
    liftOff: true,
    impactSpeed: 0,
    frameChange: null,
    altitude: LANDING_CLEARANCE * 2,
    gravity: Vec.ZERO,
    soi: null,
  }
}

function rotateOnly(entity: Entity, dt: Seconds): FrameState {
  const thrusters = entity.thrusters
  invariant(thrusters !== null, 'rotateOnly needs thrusters')
  const { angular } = resolveThrust(thrusters, entity.control)
  const assist =
    entity.flightAssist && Vec.lengthSquared(entity.control.rotation) < 1e-6
      ? dampingTorque(entity.state.angularVelocity, thrusters, dt)
      : Vec.ZERO
  const body: BodyState = {
    position: entity.state.position,
    velocity: Vec.ZERO,
    orientation: entity.state.orientation,
    angularVelocity: entity.state.angularVelocity,
  }
  const next = integrateBody(body, Vec.ZERO, Vec.add(angular, assist), dt)
  return {
    frame: entity.state.frame,
    position: entity.state.position,
    orientation: next.orientation,
    velocity: Vec.ZERO,
    angularVelocity: next.angularVelocity,
  }
}

function integrateFree(
  entity: Entity,
  externalAcceleration: Vec3,
  dt: Seconds,
): FrameState {
  const thrusters = entity.thrusters
  let linear = externalAcceleration
  let angular = Vec.ZERO

  if (thrusters !== null) {
    const resolved = resolveThrust(thrusters, entity.control)
    // Thrust is generated in body axes and applied in frame axes.
    linear = Vec.add(
      linear,
      Q.rotate(entity.state.orientation, resolved.linear),
    )
    angular = resolved.angular
    if (
      entity.flightAssist &&
      Vec.lengthSquared(entity.control.rotation) < 1e-6
    ) {
      angular = Vec.add(
        angular,
        dampingTorque(entity.state.angularVelocity, thrusters, dt),
      )
    }
  }

  const body: BodyState = {
    position: entity.state.position,
    velocity: entity.state.velocity,
    orientation: entity.state.orientation,
    angularVelocity: entity.state.angularVelocity,
  }
  const next = integrateBody(body, linear, angular, dt)
  return {
    frame: entity.state.frame,
    position: next.position,
    orientation: next.orientation,
    velocity: next.velocity,
    angularVelocity: next.angularVelocity,
  }
}

/* ------------------------------------------------------------------------- */
/* Spheres of influence                                                       */
/* ------------------------------------------------------------------------- */

export interface FrameTransition {
  readonly state: FrameState
  readonly change: FrameChange
}

export interface SoiVerdict {
  /** The move to make, or null to stay. */
  readonly change: FrameTransition | null
  /** The bounds to carry to the next test. Meaningless after a change. */
  readonly watch: SoiWatch
  /**
   * How long, in seconds, no sphere can be reached — from the entity's own
   * speed bound and every child's. `Infinity` when the caller passed no bound
   * or there is nothing to reach.
   */
  readonly safeFor: Seconds
}

/**
 * Move an entity up or down the frame hierarchy as it enters and leaves spheres
 * of influence.
 *
 * This is the "transition into increasingly local coordinate frames" the
 * vertical slice has to demonstrate, and it is deliberately invisible: the
 * entity's canonical position and velocity are unchanged by the move. Only the
 * numbers it carries change.
 *
 * Descend first: being inside a moon's SOI is more specific than being inside
 * its planet's, and checking children before the parent gets that ordering
 * right without a special case.
 *
 * The loop is over every child of the current frame, which for a star is every
 * body orbiting it — sixty-seven in Sol — and each one's honest test is a Kepler
 * solve and a pose composition. Two things keep it from being paid per child
 * per tick. A child can only be within reach if the entity's distance from the
 * parent overlaps the child's own orbital band, which `periapsis` and
 * `apoapsis` give exactly, by the triangle inequality. And a child that was
 * found to be `g` meters out of reach cannot be in reach until the entity and
 * the child have between them closed `g`, which `SoiWatch` carries forward as
 * a gap that each tick's movement consumes. Only a child whose gap has run out
 * is looked at again — and when one is, every gap is re-based on the entity's
 * new position, so the bound never loosens through accumulated travel.
 *
 * `speedBound` is how fast the entity can move, when the caller knows: a coast
 * has one (its periapsis speed) and turns `safeFor` into the next instant any
 * test could fire, so a warping frame can jump straight to it. A thrusting ship
 * has no such bound and passes null.
 */
export function considerFrameChange(
  world: FlightWorld,
  entity: Entity,
  binding: FrameBinding,
  time: Seconds,
  previous: SoiWatch | null,
  speedBound: number | null,
): SoiVerdict {
  const children = world.bindingsUnder(binding.frame)
  const state = entity.state
  // The bounds are distances in the binding's own frame. An entity that is
  // somewhere below it — a surface frame, for the tick after lift-off — makes
  // every test honestly and carries nothing forward.
  const inFrame = state.frame === binding.frame
  const watch =
    inFrame &&
    previous !== null &&
    previous.frame === binding.frame &&
    previous.gaps.length === children.length + 1
      ? previous
      : {
          frame: binding.frame,
          at: time,
          origin: state.position,
          gaps: new Float64Array(children.length + 1).fill(-Infinity),
        }
  // What the watch's gaps have to give up before they can be read: how far
  // the entity has come from the origin, and how long the children have had
  // to close in. Both go to zero once the watch is re-based on this instant.
  let travel = inFrame ? Vec.distance(state.position, watch.origin) : 0
  let elapsed = time - watch.at
  const gaps = watch.gaps
  const rebaseHere = (): void => {
    rebase(watch, children, state.position, time, travel, elapsed)
    travel = 0
    elapsed = 0
  }

  // The entity's distance from the parent, for the band prune and the parent
  // boundary. In the frame it is a length; below it, the canonical route.
  const parentDistance = inFrame
    ? Vec.length(state.position)
    : Vec.length(radiusVector(world, state, binding, time))

  let universe: UniverseVector | null = null
  let safeFor = Infinity
  const n = children.length

  for (let i = 0; i < n; i += 1) {
    const child = children[i] as FrameBinding
    const reach = child.sphereOfInfluence * SOI_ENTER
    const remaining = (gaps[i] as number) - travel - child.maxSpeed * elapsed
    if (remaining > 0) {
      if (speedBound !== null)
        safeFor = Math.min(safeFor, remaining / (speedBound + child.maxSpeed))
      continue
    }

    // This child has to be looked at. The whole watch is re-based on where
    // the entity is now, so the gaps below are measured from here.
    if (travel !== 0 || elapsed !== 0) rebaseHere()

    let gap: number
    const elements = child.body?.elements
    const near = elements === undefined ? -Infinity : periapsis(elements)
    const far = elements === undefined ? Infinity : apoapsis(elements)
    if (parentDistance + reach < near) {
      gap = near - parentDistance - reach
    } else if (parentDistance - reach > far) {
      gap = parentDistance - far - reach
    } else {
      universe ??= canonicalPosition(world.frames, state, time)
      const childPose = world.frames.pose(child.frame, time)
      const childDistance = UV.distance(universe, childPose.position)
      if (childDistance < reach) {
        return {
          change: {
            state: reframe(world.frames, state, child.frame, time),
            change: {
              from: state.frame,
              to: child.frame,
              reason: 'entered sphere of influence',
            },
          },
          watch,
          safeFor: 0,
        }
      }
      gap = childDistance - reach
    }
    gaps[i] = gap
    if (speedBound !== null)
      safeFor = Math.min(safeFor, gap / (speedBound + child.maxSpeed))
  }

  // The parent boundary, in the last slot. The parent does not move in its own
  // frame, so only the entity's travel consumes this one.
  const leaveAt = binding.sphereOfInfluence * SOI_LEAVE
  if (binding.parent !== null) {
    const remaining = (gaps[n] as number) - travel
    if (remaining <= 0) {
      if (parentDistance > leaveAt) {
        return {
          change: {
            state: reframe(world.frames, state, binding.parent, time),
            change: {
              from: state.frame,
              to: binding.parent,
              reason: 'left sphere of influence',
            },
          },
          watch,
          safeFor: 0,
        }
      }
      if (travel !== 0 || elapsed !== 0) rebaseHere()
      gaps[n] = leaveAt - parentDistance
    }
    if (speedBound !== null)
      safeFor = Math.min(safeFor, ((gaps[n] as number) - travel) / speedBound)
  } else {
    gaps[n] = Infinity
  }

  return { change: null, watch, safeFor }
}

/**
 * Measure every gap from a new origin and instant.
 *
 * A gap is a lower bound on the distance to a sphere as of the watch's origin,
 * and what has been consumed since is the entity's travel from that origin and
 * the child's possible approach in the time elapsed. Subtracting both leaves a
 * bound that is still sound from *here*, which is what makes moving the origin
 * legal without re-solving every child.
 */
function rebase(
  watch: SoiWatch,
  children: readonly FrameBinding[],
  origin: Vec3,
  at: Seconds,
  travel: number,
  elapsed: Seconds,
): void {
  const gaps = watch.gaps
  for (let i = 0; i < children.length; i += 1) {
    gaps[i] =
      (gaps[i] as number) -
      travel -
      (children[i] as FrameBinding).maxSpeed * elapsed
  }
  gaps[children.length] = (gaps[children.length] as number) - travel
  watch.origin = origin
  watch.at = at
}

/* ------------------------------------------------------------------------- */
/* Rails                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Whether a state can be coasted analytically from here, and if so from what.
 *
 * Four conditions, and each names a term the integrator would otherwise have to
 * supply. No control input, because thrust is the one acceleration a conic
 * does not include. No spin under flight assist, because the assist is a
 * torque; a spin with the assist off is a constant, and the coast carries it.
 * A periapsis above the ground band, because below it the air and the ground
 * are terms too — and a state that is currently inside the band has a
 * periapsis inside it, so the one test covers "not in air now" as well. And
 * the entity in the binding's own frame, so the conic is about the attractor
 * that is actually pulling.
 *
 * Deep space qualifies unconditionally: with no attractor the conic is a line.
 */
export function railsEpoch(
  world: FlightWorld,
  entity: Entity,
  landed: boolean,
  time: Seconds,
): RailsEpoch | null {
  if (landed) return null
  const { control, state } = entity
  if (
    Vec.lengthSquared(control.translation) !== 0 ||
    Vec.lengthSquared(control.rotation) !== 0
  )
    return null
  if (entity.flightAssist && Vec.lengthSquared(state.angularVelocity) !== 0)
    return null
  const binding = world.binding(state.frame)
  if (binding !== undefined) {
    if (state.frame !== binding.frame) return null
    const conic = conicOf(state, binding.mu)
    if (!(conic.periapsis > binding.radius + groundBand(binding))) return null
  }
  return {
    time,
    position: state.position,
    velocity: state.velocity,
    orientation: state.orientation,
    angularVelocity: state.angularVelocity,
  }
}

/**
 * The fastest a coasting entity ever moves in its frame — the bound its
 * sphere-of-influence tests are skipped against.
 */
export function railsSpeedBound(
  world: FlightWorld,
  frame: FrameId,
  epoch: RailsEpoch,
): number {
  const binding = world.binding(frame)
  if (binding === undefined) return Vec.length(epoch.velocity)
  return conicOf(epoch, binding.mu).periapsisSpeed
}

/**
 * Where a coasting entity is at `time`, from its epoch.
 *
 * A pure function of the epoch and the instant — never of the previous tick —
 * which is the whole property: a frame that jumps ten thousand ticks and one
 * that steps them land on the same bits.
 */
export function coastState(
  world: FlightWorld,
  frame: FrameId,
  epoch: RailsEpoch,
  time: Seconds,
): FrameState {
  const mu = world.binding(frame)?.mu ?? 0
  const elapsed = time - epoch.time
  const { position, velocity } = propagateTwoBody(epoch, mu, elapsed)
  // The same exact axis-angle rotation the integrator applies per tick, over
  // the whole elapsed time at once: a constant spin composes.
  return {
    frame,
    position,
    velocity,
    orientation: Q.integrate(epoch.orientation, epoch.angularVelocity, elapsed),
    angularVelocity: epoch.angularVelocity,
  }
}
