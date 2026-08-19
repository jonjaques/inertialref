import { formatDistance, formatDuration, type Meters } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import { UV, Vec } from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import { snapshot } from '@inertialref/simulation'
import { type EntityId, formatAddress, partitionForPosition } from '@inertialref/universe'
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
  readonly local: { readonly x: number; readonly y: number; readonly z: number }
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number }
  /** Speed in universe axes — what an outside observer measures. */
  readonly speed: number
  readonly speedText: string
  /** Speed within its own frame — ground speed when landed, orbital when orbiting. */
  readonly localSpeed: number
  readonly localSpeedText: string
  readonly altitude: Meters | null
  readonly altitudeText: string | null
  readonly landed: boolean
  readonly partition: string
}

export interface WorldInspection {
  readonly seed: string
  readonly seedHex: string
  readonly galaxy: string
  readonly tick: number
  readonly time: number
  readonly timeText: string
  readonly timeScale: number
  readonly paused: boolean
  readonly droppedTicks: number
  readonly stateHash: string
  readonly entityCount: number
  readonly loadedSystems: readonly { readonly id: string; readonly name: string; readonly bodies: number }[]
  readonly frames: number
  readonly entities: readonly EntityInspection[]
  readonly events: readonly { readonly tick: number; readonly kind: string; readonly detail: string }[]
}

export interface RenderInspection {
  readonly originSector: readonly [number, number, number]
  readonly originGeneration: number
  readonly anchorFrame: string
  readonly cameraRenderPosition: readonly [number, number, number]
  readonly bodies: readonly { readonly name: string; readonly tier: string; readonly distance: number; readonly distanceText: string; readonly compressed: boolean }[]
  readonly starCount: number
  readonly terrainCandidates: readonly string[]
}

/** The system partition an entity's frame sits under, if any. */
function partitionForFrameChain(chain: readonly string[]): string | null {
  for (const frame of chain) {
    if (frame.startsWith('s:')) return frame
  }
  return null
}

export function inspectEntity(world: World, id: EntityId): EntityInspection | null {
  const entity = world.entities.get(id)
  if (entity === undefined) return null
  const shot = snapshot(world, 0)
  const view = shot.entities.find((candidate) => candidate.id === id)
  if (view === undefined) return null
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
    local: { x: view.localPosition.x, y: view.localPosition.y, z: view.localPosition.z },
    velocity: { x: view.velocity.x, y: view.velocity.y, z: view.velocity.z },
    speed: Vec.length(view.velocity),
    speedText: `${Vec.length(view.velocity).toFixed(1)} m/s`,
    localSpeed: Vec.length(view.localVelocity),
    localSpeedText: `${Vec.length(view.localVelocity).toFixed(1)} m/s`,
    altitude,
    altitudeText: altitude === null ? null : formatDistance(altitude),
    landed: view.landed,
    // Authority follows the frame, not the address: a ship has no address at
    // all, but a ship inside Sol belongs to Sol's partition. Falling back to
    // the galactic cell is only right out in interstellar space.
    partition: partitionForFrameChain(view.frameChain) ?? partitionForPosition(view.position),
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
    paused: status.paused,
    droppedTicks: status.droppedTicks,
    stateHash: world.stateHash(),
    entityCount: world.entities.size,
    loadedSystems: world.loadedSystems().map((system) => ({
      id: system.id,
      name: system.name,
      bodies: system.planets.reduce((total, planet) => total + 1 + planet.moons.length, 0),
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
    originSector: [scene.origin.position.sx, scene.origin.position.sy, scene.origin.position.sz],
    originGeneration: scene.origin.generation,
    anchorFrame: scene.origin.anchorFrame,
    cameraRenderPosition: [scene.camera.position.x, scene.camera.position.y, scene.camera.position.z],
    bodies: scene.bodies
      .slice()
      .sort((a, b) => a.placement.distance - b.placement.distance)
      .slice(0, 12)
      .map((body) => ({
        name: body.name,
        tier: body.placement.tier,
        distance: body.placement.distance,
        distanceText: formatDistance(body.placement.distance),
        compressed: body.placement.compressed,
      })),
    starCount: scene.stars.length,
    terrainCandidates: scene.terrainCandidates.map((body) => body.address),
  }
}
