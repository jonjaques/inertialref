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
  bodyFrameId,
  type EntityId,
  formatAddress,
  type UniverseAddress,
} from '@inertialref/universe'
import { TICK_DURATION } from './clock.ts'
import type { EntityKind } from './entity.ts'
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
}

export interface BodySnapshot {
  readonly address: string
  readonly name: string
  readonly kind: string
  readonly radius: Meters
  readonly position: UniverseVector
  readonly orientation: Quat
  readonly frame: FrameId
  readonly hasAtmosphere: boolean
  readonly atmosphereCeiling: Meters
  /** Peak-to-datum terrain relief, so the renderer can sink the datum sphere. */
  readonly relief: Meters
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

export function snapshot(
  world: World,
  alpha = world.clock.alpha,
): WorldSnapshot {
  const status = world.clock.status()
  // Present one tick behind so there is always a pair to interpolate between.
  const renderTime = status.time - (1 - alpha) * TICK_DURATION

  const entities: EntitySnapshot[] = []
  for (const entity of world.entities.ordered()) {
    const previous = world.previousState(entity.id) ?? entity.state
    const state = lerpState(previous, entity.state, alpha)
    const address: UniverseAddress | null = entity.address
    entities.push({
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
    })
  }

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
      bodies.push({
        address: formatAddress(body.address),
        name: body.name,
        kind: body.kind,
        radius: body.radius,
        position: pose.position,
        orientation: world.frames.pose(
          // The visible orientation is the rotating one, not the orbital frame.
          world.frames.has(`bf:${formatAddress(body.address)}` as FrameId)
            ? (`bf:${formatAddress(body.address)}` as FrameId)
            : frame,
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
