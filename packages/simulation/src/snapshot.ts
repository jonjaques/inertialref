import type { Meters, Seconds, Tick } from '@inertialref/shared'
import {
  canonicalOrientation,
  canonicalPosition,
  canonicalVelocity,
  type FrameId,
  type FrameState,
  type Quat,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import {
  type BodyAppearance,
  type BodyFigure,
  bodyFixedFrameId,
  bodyFrameId,
  type EntityId,
  formatAddress,
  type UniverseAddress,
} from '@inertialref/universe'
import { TICK_DURATION } from './clock.ts'
import type { Entity, EntityKind } from './entity.ts'
import { type ThrustDemand, thrustDemand } from './flight.ts'
import type { World, WorldEvent } from './world.ts'

/*
 * The presentation bridge.
 *
 * A snapshot is a plain, immutable, structured-cloneable description of the
 * world at an instant. The renderer reads snapshots and never reaches into the
 * simulation; that boundary is what keeps canonical state out of React and
 * makes it possible to move the simulation into a worker without the renderer
 * noticing.
 *
 * Interpolation renders one tick in the past — the standard fixed-step
 * presentation trick. Note the asymmetry: entity positions are lerped between
 * two ticks, but *bodies are not*, because their frames are analytic and can be
 * evaluated exactly at the fractional render time. Planets therefore have no
 * interpolation error at all, at any time warp.
 */

export interface EntitySnapshot {
  readonly id: EntityId
  readonly name: string
  readonly kind: EntityKind
  readonly frame: FrameId
  readonly frameChain: readonly FrameId[]
  readonly address: string | null
  /** Canonical universe position, interpolated. */
  readonly position: UniverseVector
  /** Orientation in universe axes. */
  readonly orientation: Quat
  /** Velocity in universe axes, m/s. */
  readonly velocity: Vec3
  /** Position within its own frame — the small numbers gameplay works in. */
  readonly localPosition: Vec3
  readonly localVelocity: Vec3
  readonly speed: number
  readonly landed: boolean
  readonly altitude: Meters | null
  /**
   * What the thrusters are firing this tick, as fractions of their authority
   * in body axes — the assist's damping included, so a spin being nulled draws
   * the nozzles nulling it. Null for anything that cannot maneuver.
   */
  readonly thrust: ThrustDemand | null
}

export interface BodySnapshot {
  readonly address: string
  readonly name: string
  readonly kind: string
  readonly radius: Meters
  /** Polar radius. Smaller than `radius` for anything that spins. */
  readonly polarRadius: Meters
  /**
   * Sidereal rotation period, seconds, negative for retrograde. The renderer
   * needs it because a cloud deck's drift is *relative to the surface*, and
   * the surface's own turn rate is not recoverable from the orientation.
   */
  readonly rotationPeriod: Seconds
  /** What it looks like: maps, roughness, clouds, rings. */
  readonly appearance: BodyAppearance
  readonly position: UniverseVector
  readonly orientation: Quat
  readonly frame: FrameId
  readonly hasAtmosphere: boolean
  readonly atmosphereCeiling: Meters
  /** Peak-to-datum terrain relief, so the renderer can sink the datum sphere. */
  readonly relief: Meters
  /**
   * The measured figure, for a body that is not a spheroid, or null for one
   * that is. See `BodyFigure` in `@inertialref/universe`.
   */
  readonly figure: BodyFigure | null
}

export interface StarSnapshot {
  readonly system: string
  readonly name: string
  readonly position: UniverseVector
  readonly radius: Meters
  readonly temperature: number
  readonly luminosity: number
}

export interface WorldSnapshot {
  readonly tick: Tick
  readonly time: Seconds
  readonly renderTime: Seconds
  readonly alpha: number
  readonly timeScale: number
  readonly paused: boolean
  readonly droppedTicks: number
  readonly entities: readonly EntitySnapshot[]
  readonly bodies: readonly BodySnapshot[]
  readonly stars: readonly StarSnapshot[]
  readonly events: readonly WorldEvent[]
  readonly stateHash: string
}

const lerpState = (
  previous: FrameState,
  current: FrameState,
  alpha: number,
): FrameState => {
  // A frame change between the two ticks makes the local coordinates
  // incomparable; snapping to the newer frame for one frame is invisible, while
  // interpolating between them would fling the entity across the system.
  if (previous.frame !== current.frame) return current
  return {
    frame: current.frame,
    position: Vec.lerp(previous.position, current.position, alpha),
    velocity: Vec.lerp(previous.velocity, current.velocity, alpha),
    orientation: current.orientation,
    angularVelocity: current.angularVelocity,
  }
}

/**
 * One entity's view at an interpolation alpha.
 *
 * Exported on its own because an inspector asking about one ship does not
 * need the poses of a hundred and twenty-nine bodies to answer — and it was
 * building the whole snapshot, twice a sample, to read one entry out of it.
 */
export function entitySnapshot(
  world: World,
  entity: Entity,
  alpha = world.clock.alpha,
): EntitySnapshot {
  const renderTime = world.clock.renderTimeAt(alpha)
  const previous = world.previousState(entity.id) ?? entity.state
  const state = lerpState(previous, entity.state, alpha)
  const address: UniverseAddress | null = entity.address
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    frame: state.frame,
    frameChain: world.frames.has(state.frame)
      ? world.frames.chain(state.frame)
      : [state.frame],
    address: address === null ? null : formatAddress(address),
    position: canonicalPosition(world.frames, state, renderTime),
    orientation: canonicalOrientation(world.frames, state, renderTime),
    velocity: canonicalVelocity(world.frames, state, renderTime),
    localPosition: state.position,
    localVelocity: state.velocity,
    speed: Vec.length(state.velocity),
    landed: world.isLanded(entity.id),
    altitude: world.altitudeOf(entity.id),
    // The current tick's command, not an interpolation: a valve is open or it
    // is not, and the assist term is a function of the spin the tick started
    // with, which is the one the entity holds.
    thrust: thrustDemand(entity, TICK_DURATION),
  }
}

export function snapshot(
  world: World,
  alpha = world.clock.alpha,
): WorldSnapshot {
  const status = world.clock.status()
  // Present one tick behind so there is always a pair to interpolate between.
  // The arithmetic belongs to the clock: anything else that places something in
  // a frame has to arrive at the same number, and a second copy of it here is
  // how the observatory came to be placing its camera at the tick instead.
  const renderTime = world.clock.renderTimeAt(alpha)

  const entities: EntitySnapshot[] = []
  for (const entity of world.entities.ordered())
    entities.push(entitySnapshot(world, entity, alpha))

  const bodies: BodySnapshot[] = []
  const stars: StarSnapshot[] = []
  for (const system of world.loadedSystems()) {
    stars.push({
      system: system.id,
      name: system.star.name,
      position: system.position,
      radius: system.star.radius,
      temperature: system.star.temperature,
      luminosity: system.star.luminosity,
    })
    const collect = (body: (typeof system.planets)[number]): void => {
      const frame = bodyFrameId(body.address)
      const pose = world.frames.pose(frame, renderTime)
      // The rotating frame, resolved once. It was spelled out twice inside the
      // ternary below — `has` and then the read — which is two template
      // strings and two address formats per body per frame for one answer.
      const spin = bodyFixedFrameId(body.address)
      bodies.push({
        address: formatAddress(body.address),
        name: body.name,
        kind: body.kind,
        radius: body.radius,
        polarRadius: body.polarRadius,
        figure: body.figure,
        rotationPeriod: body.rotationPeriod,
        appearance: body.appearance,
        position: pose.position,
        // The visible orientation is the rotating one, not the orbital frame.
        orientation: world.frames.pose(
          world.frames.has(spin) ? spin : frame,
          renderTime,
        ).orientation,
        frame,
        hasAtmosphere: body.atmosphere !== null,
        atmosphereCeiling: body.atmosphere?.ceiling ?? 0,
        relief: body.surface.maxElevation,
      })
      for (const moon of body.moons) collect(moon)
    }
    for (const planet of system.planets) collect(planet)
  }

  return {
    tick: status.tick,
    time: status.time,
    renderTime,
    alpha,
    timeScale: status.timeScale,
    paused: status.paused,
    droppedTicks: status.droppedTicks,
    entities,
    bodies,
    stars,
    events: world.events(16),
    stateHash: world.stateHash(),
  }
}
