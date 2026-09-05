import {
  formatDuration,
  formatReading,
  type Meters,
  type Seconds,
} from '@inertialref/shared'
import { conicOf } from '@inertialref/physics'
import { formatSeed } from '@inertialref/procedural'
import { UV, Vec } from '@inertialref/spatial'
import type {
  EntitySnapshot,
  FrameBinding,
  World,
} from '@inertialref/simulation'
import {
  airVelocity,
  entitySnapshot,
  thrustDemand,
  TICK_DURATION,
} from '@inertialref/simulation'
import {
  type EntityId,
  formatAddress,
  partitionForFrames,
} from '@inertialref/universe'
import type { RenderScene } from '@inertialref/rendering'

/*
 * Inspection (spec §20).
 *
 * Everything invisible about the simulation, in one structured record: entity
 * id, universe address, frame chain, local *and* canonical coordinates,
 * velocity, tick, seed, LOD, loaded regions, authority partition and worker
 * queue. Complex coordinate systems are miserable to debug without this, and
 * the point of building it early is that the debugging is happening now.
 *
 * Values come in both raw and formatted forms: the raw ones are what tests and
 * the harness assert on, the formatted ones are what a human reads in the HUD.
 */

export interface EntityInspection {
  readonly id: EntityId
  readonly name: string
  readonly kind: string
  readonly address: string | null
  readonly frame: string
  readonly frameChain: readonly string[]
  readonly canonical: {
    readonly sector: readonly [number, number, number]
    readonly offset: readonly [number, number, number]
    readonly text: string
  }
  readonly local: {
    readonly x: number
    readonly y: number
    readonly z: number
  }
  readonly velocity: {
    readonly x: number
    readonly y: number
    readonly z: number
  }
  /** Speed in universe axes — what an outside observer measures. */
  readonly speed: number
  readonly speedText: string
  /** Speed within its own frame — ground speed when landed, orbital when orbiting. */
  readonly localSpeed: number
  readonly localSpeedText: string
  readonly altitude: Meters | null
  readonly altitudeText: string | null
  readonly landed: boolean
  /** On rails: propagated from an epoch rather than integrated (ADR-0025). */
  readonly coasting: boolean
  readonly partition: string
  /** The main drive's throttle, 0..1. */
  readonly throttle: number
  readonly flightAssist: boolean
  /** Whether any thruster valve is open this tick, the assist's included. */
  readonly thrusting: boolean
  /**
   * Speed against the ground and the air under the ship, m/s — the body's
   * spin taken out of the frame speed. Null with no body to measure against.
   */
  readonly surfaceSpeed: number | null
  /** Rate of climb, m/s, positive away from the body. Null in deep space. */
  readonly verticalSpeed: number | null
  /** The conic about the frame's body, or null with nothing to be on one about. */
  readonly orbit: OrbitInspection | null
}

/**
 * The orbit a ship is on, as the numbers a pilot reads: how high it goes and
 * how low, above the datum rather than from the centre, and how long a lap is.
 */
export interface OrbitInspection {
  /** Lowest altitude above the datum, meters. Below zero is a ground track. */
  readonly periapsis: Meters
  /** Highest altitude above the datum, or null for an orbit that does not come back. */
  readonly apoapsis: Meters | null
  readonly eccentricity: number
  /** Seconds per revolution, or null for an escape. */
  readonly period: Seconds | null
}

export interface WorldInspection {
  readonly seed: string
  readonly seedHex: string
  readonly galaxy: string
  readonly tick: number
  readonly time: number
  readonly timeText: string
  readonly timeScale: number
  /** What the clock is actually delivering. Below `timeScale` when warp is capped. */
  readonly achievedTimeScale: number
  readonly paused: boolean
  readonly droppedTicks: number
  readonly stateHash: string
  readonly entityCount: number
  readonly loadedSystems: readonly {
    readonly id: string
    readonly name: string
    readonly bodies: number
  }[]
  readonly frames: number
  readonly entities: readonly EntityInspection[]
  readonly events: readonly {
    readonly tick: number
    readonly kind: string
    readonly detail: string
  }[]
}

export interface RenderInspection {
  readonly originSector: readonly [number, number, number]
  readonly originGeneration: number
  readonly anchorFrame: string
  readonly cameraRenderPosition: readonly [number, number, number]
  readonly bodies: readonly {
    readonly name: string
    readonly tier: string
    readonly distance: number
    readonly distanceText: string
    readonly compressed: boolean
  }[]
  readonly starCount: number
  readonly terrainCandidates: readonly string[]
}

export function inspectEntity(
  world: World,
  id: EntityId,
): EntityInspection | null {
  const entity = world.entities.get(id)
  if (entity === undefined) return null
  // The one entity, at the tick. A whole world snapshot here — every body's
  // orbit and spin pose, searched for one id — is paid twice a status sample:
  // once for the player and once per entity in the list.
  const view = entitySnapshot(world, entity, 0)
  const altitude = world.altitudeOf(id)

  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    address: entity.address === null ? null : formatAddress(entity.address),
    frame: view.frame,
    frameChain: view.frameChain,
    canonical: {
      sector: [view.position.sx, view.position.sy, view.position.sz],
      offset: [view.position.ox, view.position.oy, view.position.oz],
      text: UV.format(view.position),
    },
    local: {
      x: view.localPosition.x,
      y: view.localPosition.y,
      z: view.localPosition.z,
    },
    velocity: { x: view.velocity.x, y: view.velocity.y, z: view.velocity.z },
    speed: Vec.length(view.velocity),
    speedText: `${Vec.length(view.velocity).toFixed(1)} m/s`,
    localSpeed: Vec.length(view.localVelocity),
    localSpeedText: `${Vec.length(view.localVelocity).toFixed(1)} m/s`,
    altitude,
    altitudeText: altitude === null ? null : formatReading(altitude),
    landed: view.landed,
    coasting: entity.rails !== null,
    // Derived by `universe`, not open-coded here — see partitionForFrames.
    partition: partitionForFrames(world.galaxy, view.frameChain, view.position),
    throttle: entity.control.throttle,
    flightAssist: entity.flightAssist,
    thrusting: isThrusting(thrustDemand(entity, TICK_DURATION)),
    ...againstTheBody(world, view),
  }
}

/**
 * The readings that exist only about a body: the ground-relative speed, the
 * rate of climb, and the conic.
 *
 * All three are measured in the body's own inertial frame, so they are
 * null when the entity is somewhere else — a surface frame, where the local
 * velocity is already the ground-relative one and is read directly; a
 * system frame, where the star is the attractor but there is no ground to
 * be above; deep space, where there is nothing at all.
 */
function againstTheBody(
  world: World,
  view: EntitySnapshot,
): Pick<EntityInspection, 'surfaceSpeed' | 'verticalSpeed' | 'orbit'> {
  if (view.landed) {
    // A surface frame's velocity is against the ground by construction, and
    // its +Y is up.
    return {
      surfaceSpeed: Vec.length(view.localVelocity),
      verticalSpeed: view.localVelocity.y,
      orbit: null,
    }
  }
  const binding = world.binding(view.frame)
  const nothing = { surfaceSpeed: null, verticalSpeed: null, orbit: null }
  if (binding === undefined || binding.body === null || binding.radius <= 0)
    return nothing
  const radius = view.localPosition
  const distance = Vec.length(radius)
  if (distance <= 0) return nothing
  const up = Vec.scale(radius, 1 / distance)
  const ground = airVelocity(world, binding, radius, world.clock.time)
  return {
    surfaceSpeed: Vec.length(Vec.sub(view.localVelocity, ground)),
    verticalSpeed: Vec.dot(view.localVelocity, up),
    orbit: binding.mu > 0 ? orbitOf(view, binding) : null,
  }
}

/** Any valve open: the demand the tick fired, not the hand on the keys. */
const isThrusting = (demand: ReturnType<typeof thrustDemand>): boolean =>
  demand !== null &&
  (Vec.lengthSquared(demand.linear) > 0 ||
    Vec.lengthSquared(demand.angular) > 0)

function orbitOf(view: EntitySnapshot, binding: FrameBinding): OrbitInspection {
  const conic = conicOf(
    { position: view.localPosition, velocity: view.localVelocity },
    binding.mu,
  )
  const e = conic.eccentricity
  // Bound below one; a parabola's apoapsis is at infinity and a hyperbola's
  // is behind it, and neither is a number a readout can print.
  const semiMajor = e < 1 ? conic.periapsis / (1 - e) : null
  return {
    periapsis: conic.periapsis - binding.radius,
    apoapsis: semiMajor === null ? null : semiMajor * (1 + e) - binding.radius,
    eccentricity: e,
    period:
      semiMajor === null
        ? null
        : 2 *
          Math.PI *
          Math.sqrt((semiMajor * semiMajor * semiMajor) / binding.mu),
  }
}

export function inspectWorld(world: World): WorldInspection {
  const status = world.clock.status()
  return {
    seed: world.seedText,
    seedHex: formatSeed(world.rootSeed),
    galaxy: world.galaxy,
    tick: status.tick,
    time: status.time,
    timeText: formatDuration(status.time),
    timeScale: status.timeScale,
    achievedTimeScale: status.achievedTimeScale,
    paused: status.paused,
    droppedTicks: status.droppedTicks,
    stateHash: world.stateHash(),
    entityCount: world.entities.size,
    loadedSystems: world.loadedSystems().map((system) => ({
      id: system.id,
      name: system.name,
      bodies: system.planets.reduce(
        (total, planet) => total + 1 + planet.moons.length,
        0,
      ),
    })),
    frames: world.frames.ids().length,
    entities: world.entities
      .ordered()
      .map((entity) => inspectEntity(world, entity.id))
      .filter((entry): entry is EntityInspection => entry !== null),
    events: world.events(12).map((event) => ({
      tick: event.tick,
      kind: event.kind,
      detail: event.detail,
    })),
  }
}

export function inspectRender(scene: RenderScene): RenderInspection {
  return {
    originSector: [
      scene.origin.position.sx,
      scene.origin.position.sy,
      scene.origin.position.sz,
    ],
    originGeneration: scene.origin.generation,
    anchorFrame: scene.origin.anchorFrame,
    cameraRenderPosition: [
      scene.camera.position.x,
      scene.camera.position.y,
      scene.camera.position.z,
    ],
    bodies: scene.bodies
      .slice()
      .sort((a, b) => a.placement.distance - b.placement.distance)
      .slice(0, 12)
      .map((body) => ({
        name: body.name,
        tier: body.placement.tier,
        distance: body.placement.distance,
        distanceText: formatReading(body.placement.distance),
        compressed: body.placement.compressed,
      })),
    starCount: scene.stars.length,
    terrainCandidates: scene.terrainCandidates.map((body) => body.address),
  }
}
