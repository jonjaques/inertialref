import { invariant, type Meters, type Seconds } from '@inertialref/shared'
import {
  atmosphericDensity,
  type BodyState,
  dampingTorque,
  dragAcceleration,
  integrateBody,
  pointMassAcceleration,
  resolveThrust,
} from '@inertialref/physics'
import {
  canonicalPosition,
  type FrameGraph,
  type FrameId,
  type FrameState,
  Quaternion as Q,
  reframe,
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
import type { Entity } from './entity.ts'

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

export interface FrameChange {
  readonly from: FrameId
  readonly to: FrameId
  readonly reason: string
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
  /** Terrain sampling is the expensive part; skip it above this altitude. */
  readonly terrainSampleAltitude?: Meters
}

/**
 * Advance one entity by one tick.
 *
 * Pure with respect to the world: it reads frames and bindings and returns a
 * new state. Nothing here mutates, which is what lets the same function run in
 * a worker or on a server.
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
    }
  }

  if (landed) return stepLanded(entity, options)

  const radius = radiusVector(world, entity.state, binding, time)
  const distance = Vec.length(radius)
  const gravity = pointMassAcceleration(binding.mu, radius)

  let acceleration = gravity
  let altitude: Meters | null = null

  if (binding.body !== null && binding.radius > 0) {
    // Sampled through the same helper as the contact test below. This used to
    // be `Vec.normalize(radius)` — an *inertial* direction — and it is the
    // altitude the atmosphere is evaluated against. The terrain gate here is
    // `radius * 0.25` (~1,600 km on an Earth-sized world) while an atmosphere
    // ceiling is 60–180 km, so every atmospheric pass in the game took the
    // wrong sample, and the error moved with the planet's rotation phase.
    const sampleBelow = options.terrainSampleAltitude ?? binding.radius * 0.25
    if (distance - binding.radius < sampleBelow) {
      altitude =
        distance -
        surfaceRadius(
          binding.body,
          groundDirection(world, entity, binding, time),
        )
    } else {
      altitude = distance - binding.radius
    }
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

  // Ground contact is tested *after* integrating, against the new position.
  // Testing the old one lets a fast descent step straight through the crust —
  // at 20 km/s a tick covers 300 m, so "was I close last tick" is not a
  // collision test, it is a coin flip.
  if (
    binding.body !== null &&
    binding.spinFrame !== null &&
    altitude !== null
  ) {
    const after = groundAltitude(world, { ...entity, state }, binding, time)
    const speed = Vec.length(state.velocity)
    const contact =
      after <= 0 || (after <= LANDING_CLEARANCE && speed < LANDING_SPEED_LIMIT)
    if (contact) {
      return {
        state,
        landed: true,
        touchdown: true,
        liftOff: false,
        impactSpeed: speed,
        frameChange: null,
        altitude: after,
        gravity,
      }
    }
    altitude = after
  }

  const transition = considerFrameChange(
    world,
    { ...entity, state },
    binding,
    distance,
    time,
  )
  return {
    state: transition?.state ?? state,
    landed: false,
    touchdown: false,
    liftOff: false,
    impactSpeed: 0,
    frameChange: transition?.change ?? null,
    altitude,
    gravity,
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
 */
function groundAltitude(
  world: FlightWorld,
  entity: Entity,
  binding: FrameBinding,
  time: Seconds,
): Meters {
  const radius = radiusVector(world, entity.state, binding, time)
  const distance = Vec.length(radius)
  if (binding.body === null) return distance - binding.radius
  // Sampling terrain is fourteen octaves of 3D noise; only worth it near the
  // ground, and a sphere is an exact answer everywhere else.
  if (distance - binding.radius > binding.radius * 0.25)
    return distance - binding.radius
  return (
    distance -
    surfaceRadius(binding.body, groundDirection(world, entity, binding, time))
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
export function groundDirection(
  world: FlightWorld,
  entity: Entity,
  binding: FrameBinding,
  time: Seconds,
): BodyFixedDirection {
  if (binding.spinFrame === null) {
    return Vec.normalize(
      radiusVector(world, entity.state, binding, time),
    ) as BodyFixedDirection
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

/**
 * Move an entity up or down the frame hierarchy as it enters and leaves spheres
 * of influence.
 *
 * This is the "transition into increasingly local coordinate frames" the
 * vertical slice has to demonstrate, and it is deliberately invisible: the
 * entity's canonical position and velocity are unchanged by the move. Only the
 * numbers it carries change.
 */
function considerFrameChange(
  world: FlightWorld,
  entity: Entity,
  binding: FrameBinding,
  distance: Meters,
  time: Seconds,
): { state: FrameState; change: FrameChange } | null {
  // Descend first: being inside a moon's SOI is more specific than being inside
  // its planet's, and checking children before the parent gets that ordering
  // right without a special case.
  for (const child of world.bindingsUnder(binding.frame)) {
    const childPose = world.frames.pose(child.frame, time)
    const universe = canonicalPosition(world.frames, entity.state, time)
    const childDistance = UV.distance(universe, childPose.position)
    if (childDistance < child.sphereOfInfluence * SOI_ENTER) {
      return {
        state: reframe(world.frames, entity.state, child.frame, time),
        change: {
          from: entity.state.frame,
          to: child.frame,
          reason: 'entered sphere of influence',
        },
      }
    }
  }

  if (
    binding.parent !== null &&
    distance > binding.sphereOfInfluence * SOI_LEAVE
  ) {
    return {
      state: reframe(world.frames, entity.state, binding.parent, time),
      change: {
        from: entity.state.frame,
        to: binding.parent,
        reason: 'left sphere of influence',
      },
    }
  }

  return null
}
