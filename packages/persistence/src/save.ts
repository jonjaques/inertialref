import { err, ok, type Result, tick as asTick } from '@inertialref/shared'
import {
  decodeSaveGame,
  decode,
  decodeFrameState,
  decodeRailsEpoch,
  describeDrift,
  encodeFrameState,
  encodeRailsEpoch,
  encodeVec3,
  SAVE_SCHEMA_VERSION,
  type SaveEntity,
  type SaveGame,
  type VersionDrift,
  versionDrift,
} from '@inertialref/protocol'
import { type FrameId, vec3 } from '@inertialref/spatial'
import {
  DEBUG_SHIP_THRUSTERS,
  type EntityKind,
  World,
} from '@inertialref/simulation'
import {
  GENERATION_VERSIONS,
  galaxyId,
  SOL_ONLY_CATALOG,
  type EntityId,
  type StarCatalog,
  type SystemId,
} from '@inertialref/universe'
import { migrateSave } from './migrate.ts'

/*
 * Turning a world into a save and back.
 *
 * What goes in: the seed, the tick, the dynamic entities, which systems were
 * loaded, and the schema/generation versions. What stays out: every planet,
 * moon, orbit, star and heightfield in the universe, all of which are a pure
 * function of the seed and would be a cache rather than a save.
 *
 * The reload therefore *regenerates* rather than restores, and the test that
 * matters is that the state hash after a save/load round trip is identical to
 * the hash before it — not that the file contains what it should.
 */

export interface SaveOptions {
  readonly meta?: Readonly<Record<string, string>>
}

export function captureSave(
  world: World,
  playerEntity: EntityId | null,
  options: SaveOptions = {},
): SaveGame {
  const landed = new Set(world.landedEntities())
  const entities: SaveEntity[] = world.entities.ordered().map((entity) => ({
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    state: encodeFrameState(entity.state),
    mass: entity.mass,
    landed: landed.has(entity.id),
    hasThrusters: entity.thrusters !== null,
    ballisticCoefficient: entity.ballisticCoefficient,
    control: {
      translation: encodeVec3(entity.control.translation),
      rotation: encodeVec3(entity.control.rotation),
    },
    flightAssist: entity.flightAssist,
    rails: entity.rails === null ? null : encodeRailsEpoch(entity.rails),
  }))

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    seed: world.seedText,
    galaxy: world.galaxy,
    tick: world.clock.tick,
    generation: GENERATION_VERSIONS,
    // The second generation input. `generation` is a map of numbers and the
    // catalog version is not one, so it rides beside it rather than inside —
    // but it is exactly as load-bearing: a save written against `hyg-4.4` and
    // reloaded against `hyg-4.5` may find a body the catalog has moved.
    catalog: world.catalog.version,
    entities,
    playerEntity,
    dynamicIdCounter: world.entities.dynamicIdCounter,
    loadedSystems: world.loadedSystems().map((system) => system.id),
    mutations: [],
    meta: options.meta ?? {},
  }
}

export const serializeSave = (save: SaveGame): string => JSON.stringify(save)

export interface RestoredWorld {
  readonly world: World
  readonly playerEntity: EntityId | null
  /** Generation versions the save was written with. */
  readonly generation: Readonly<Record<string, number>>
  /** The catalog version the save was written against. */
  readonly catalog: string
  /**
   * Every way the save's universe differs from this build's — empty when they
   * agree, which is the ordinary case.
   *
   * Returned on **success**, not only on failure, and that is the change this
   * field exists to make. A save whose catalog moved usually loads: the systems
   * it names still resolve, the entities still spawn, and the only symptom is
   * that a star is a few light years from where it was. The old code could only
   * mention the versions while building an error message for a load that had
   * already failed, so the interesting case — it worked, and it is not the same
   * sky — had nowhere to be reported. `describeDrift` turns this into a
   * sentence; the caller decides whether that is a notice or a refusal.
   */
  readonly drift: readonly VersionDrift[]
}

/**
 * Rebuild a world from a save.
 *
 * Order matters: systems are loaded before entities, because an entity's frame
 * only exists once its system does, and surface frames are regenerated on
 * demand from the frame id.
 */
export function restoreSave(
  save: SaveGame,
  catalog: StarCatalog = SOL_ONLY_CATALOG,
): Result<RestoredWorld, string> {
  const world = new World({
    seed: save.seed,
    galaxy: galaxyId(save.galaxy),
    startTick: asTick(save.tick),
    catalog,
  })

  /*
   * The verdict, computed once and used twice.
   *
   * The same function the handshake reads, so "is this the same universe" gets
   * one answer whether it is asked of a peer or of a file. It is computed
   * before the load rather than after because it is the explanation for a
   * failure below *and* the notice on a success — a save from a degraded
   * session, where the catalog asset failed to fetch and the game fell back to
   * `SOL_ONLY_CATALOG`, can reference procedural stars the full catalog
   * suppresses, and vice versa.
   */
  const drift = versionDrift(
    { generation: save.generation, catalog: save.catalog },
    { generation: GENERATION_VERSIONS, catalog: catalog.version },
  )

  for (const system of save.loadedSystems) {
    try {
      world.loadSystem(system as SystemId)
    } catch (cause) {
      // Naming the drift turns "cannot load system" from a mystery into a
      // diagnosis; the revision notice that would *resolve* it is a roadmap
      // seam.
      const mismatch =
        drift.length === 0 ? '' : ` (saved against ${describeDrift(drift)})`
      return err(
        `cannot load system ${system}${mismatch}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  const landed: EntityId[] = []
  for (const entity of save.entities) {
    const state = decode(decodeFrameState, entity.state)
    if (!state.ok) return err(`entity ${entity.id}: ${state.error}`)
    const rails =
      entity.rails === null ? ok(null) : decode(decodeRailsEpoch, entity.rails)
    if (!rails.ok) return err(`entity ${entity.id} rails: ${rails.error}`)
    if (!world.ensureFrame(state.value.frame as FrameId)) {
      return err(
        `entity ${entity.id} refers to frame ${state.value.frame}, which does not exist`,
      )
    }
    const spawned = world.spawn({
      id: entity.id as EntityId,
      kind: entity.kind as EntityKind,
      name: entity.name,
      state: state.value,
      mass: entity.mass,
      thrusters: entity.hasThrusters ? DEBUG_SHIP_THRUSTERS : null,
      ballisticCoefficient: entity.ballisticCoefficient,
      rails: rails.value,
    })
    world.entities.update(spawned.id, {
      control: {
        translation: vec3(
          entity.control.translation[0],
          entity.control.translation[1],
          entity.control.translation[2],
        ),
        rotation: vec3(
          entity.control.rotation[0],
          entity.control.rotation[1],
          entity.control.rotation[2],
        ),
      },
      flightAssist: entity.flightAssist,
    })
    if (entity.landed) landed.push(entity.id as EntityId)
  }

  world.entities.restoreDynamicIdCounter(save.dynamicIdCounter)
  world.restoreLanded(landed)

  return ok({
    world,
    playerEntity:
      save.playerEntity === null ? null : (save.playerEntity as EntityId),
    generation: save.generation,
    catalog: save.catalog,
    drift,
  })
}

/** Parse, migrate and validate save text. The whole trust boundary, in order. */
export function parseSave(text: string): Result<SaveGame, string> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    return err(
      `malformed save: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const migrated = migrateSave(raw)
  if (!migrated.ok) return migrated
  return decode(decodeSaveGame, migrated.value)
}
