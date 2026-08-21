import { ok } from '@inertialref/shared'
import {
  decodeArray,
  decodeBoolean,
  decodeInteger,
  decodeNumber,
  decodeNumberRecord,
  decodeObject,
  decodeOptional,
  decodeEnum,
  decodeString,
  decodeStringRecord,
  type Decoder,
} from './codec.ts'
import {
  decodeWireFrameState,
  decodeWireVec3,
  type WireFrameState,
  type WireVec3,
} from './wire.ts'

/*
 * Save format (ADR-0007).
 *
 * A save is the seed, the tick, and the things that could not have been
 * regenerated. Not one byte of procedural output: the universe is a pure
 * function of (seed, address, algorithm version), so persisting a planet would
 * be persisting a cache — one that goes stale the moment a generator changes,
 * and that is measured in terabytes if the player travels.
 *
 * What must be stored is therefore exactly:
 *   - the seed and the algorithm versions it was generated with,
 *   - the simulation tick,
 *   - dynamic entities (the ship), which have no address to regenerate from,
 *   - mutations: deliberate departures from what generation would produce.
 *
 * `mutations` is empty in this milestone and the shape is provisional, but the
 * field exists now so that adding the first one is a migration of data rather
 * than a change of model.
 */

export const SAVE_SCHEMA_VERSION = 1

export interface SaveEntity {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly state: WireFrameState
  readonly mass: number
  readonly landed: boolean
  readonly hasThrusters: boolean
  readonly ballisticCoefficient: number
  /**
   * Current control input. Part of canonical state, not a UI detail: saving
   * mid-burn and resuming coasting is a different universe, and the round-trip
   * determinism test caught exactly that.
   */
  readonly control: {
    readonly translation: WireVec3
    readonly rotation: WireVec3
  }
  readonly flightAssist: boolean
}

export const SAVE_MUTATION_KINDS = [
  'discovered',
  'destroyed',
  'placed',
  'terrain',
] as const
export type SaveMutationKind = (typeof SAVE_MUTATION_KINDS)[number]

export interface SaveMutation {
  /** Universe address the mutation applies to. */
  readonly address: string
  readonly kind: SaveMutationKind
  /** Payload shape is per-kind and validated by whoever consumes it. */
  readonly data: string
  readonly tick: number
}

export interface SaveGame {
  readonly schemaVersion: number
  readonly seed: string
  readonly galaxy: string
  readonly tick: number
  readonly generation: Readonly<Record<string, number>>
  readonly entities: readonly SaveEntity[]
  readonly playerEntity: string | null
  readonly dynamicIdCounter: number
  readonly loadedSystems: readonly string[]
  readonly mutations: readonly SaveMutation[]
  /** Free-form, never load-bearing: build id, wall-clock date, notes. */
  readonly meta: Readonly<Record<string, string>>
}

export const decodeSaveEntity: Decoder<SaveEntity> = decodeObject({
  id: decodeString,
  kind: decodeString,
  name: decodeString,
  state: decodeWireFrameState,
  mass: decodeNumber,
  landed: decodeBoolean,
  hasThrusters: decodeBoolean,
  ballisticCoefficient: decodeNumber,
  // Added after the first v1 saves existed; defaulted rather than versioned,
  // because a missing control input has an unambiguous meaning: hands off.
  control: decodeOptional(
    decodeObject({ translation: decodeWireVec3, rotation: decodeWireVec3 }),
    { translation: [0, 0, 0] as WireVec3, rotation: [0, 0, 0] as WireVec3 },
  ),
  flightAssist: decodeOptional(decodeBoolean, true),
})

export const decodeSaveMutation: Decoder<SaveMutation> = decodeObject({
  address: decodeString,
  kind: decodeEnum(...SAVE_MUTATION_KINDS),
  data: decodeString,
  tick: decodeInteger,
})

/**
 * Decode a save of the *current* schema version.
 *
 * Older versions are handled by the migration chain in the persistence package
 * before they reach here, so this decoder only ever sees v1 shapes. Keeping the
 * validator and the migrator separate is what makes it possible to add v2
 * without weakening the v1 checks into "some fields might be missing".
 */
export const decodeSaveGame: Decoder<SaveGame> = decodeObject({
  schemaVersion: decodeInteger,
  seed: decodeString,
  galaxy: decodeString,
  tick: decodeInteger,
  generation: decodeNumberRecord,
  entities: decodeArray(decodeSaveEntity),
  playerEntity: (value, path) =>
    value === null ? ok(null) : decodeString(value, path),
  dynamicIdCounter: decodeInteger,
  loadedSystems: decodeArray(decodeString),
  mutations: decodeOptional(decodeArray(decodeSaveMutation), []),
  meta: decodeOptional(decodeStringRecord, {}),
})
