import { err, ok, type Result } from '@inertialref/shared'
import { SAVE_SCHEMA_VERSION } from '@inertialref/protocol'
import { type GalaxyId, initialStructures } from '@inertialref/universe'

/*
 * Save migrations.
 *
 * A save records the schema version it was written with, and loading walks a
 * chain of single-step migrations up to the current one. Two rules keep this
 * from rotting:
 *
 *   - Migrations operate on raw, unvalidated data and are never typed against
 *     the current interfaces. A migration written against today's `SaveGame`
 *     silently changes meaning the day that interface changes, which defeats
 *     the point of having versions at all.
 *   - The validator only ever sees the current version, so it can stay strict
 *     instead of decaying into "these fields are probably there".
 */

export interface Migration {
  readonly from: number
  readonly to: number
  readonly describe: string
  migrate(raw: Record<string, unknown>): Record<string, unknown>
}

/**
 * v0 → v1.
 *
 * v0 never shipped to anyone; it is the shape this game had for about an hour,
 * when a save was a seed and a ship and nothing else. It is kept because a
 * migration chain with no migrations in it is a chain nobody has ever run, and
 * the first real one should not be the first one to be executed in anger.
 */
const v0ToV1: Migration = {
  from: 0,
  to: 1,
  describe:
    'wrap the single ship in an entity list and record generation versions',
  migrate(raw) {
    const ship = raw['ship']
    return {
      schemaVersion: 1,
      seed: raw['seed'] ?? 'inertialref',
      galaxy: raw['galaxy'] ?? 'milky-way',
      tick: raw['tick'] ?? 0,
      generation: raw['generation'] ?? {},
      entities: ship === undefined ? [] : [ship],
      playerEntity:
        ship === undefined ? null : ((ship as { id?: string }).id ?? null),
      dynamicIdCounter: raw['dynamicIdCounter'] ?? 1,
      loadedSystems: raw['loadedSystems'] ?? [],
      mutations: [],
      meta: { migratedFrom: 'v0' },
    }
  },
}

/**
 * v1 → v2.
 *
 * A v1 save predates structures, so it is a game whose Mars pad was never
 * written down; the facilities a new session in its galaxy seeds go in here,
 * or the landing scene stages a pad the player cannot land on. A save from
 * another galaxy has no Mars, and its list is empty. Fresh copies, because
 * the parser and the world both treat a save's records as their own.
 */
const v1ToV2: Migration = {
  from: 1,
  to: 2,
  describe: 'add durable surface structures, seeding the Mars pad',
  migrate: (raw) => ({
    ...raw,
    schemaVersion: 2,
    structures:
      typeof raw['galaxy'] === 'string'
        ? initialStructures(raw['galaxy'] as GalaxyId).map((placement) => ({
            ...placement,
          }))
        : [],
  }),
}

/**
 * v2 → v3.
 *
 * A v2 entity says whether it has thrusters and not what they are, and the
 * loader answered "what" with the debug ship's profile — which is the only
 * profile a v2 save could have meant, since every ship the game spawned had
 * it. The numbers are written out rather than read from `DEBUG_SHIP_THRUSTERS`
 * because a migration describes the data it reads, and the constant is free
 * to change under it: a v2 ship flew with 30 / 8 / 1.2, whatever the debug
 * ship flies with next year.
 */
const v2ToV3: Migration = {
  from: 2,
  to: 3,
  describe: 'carry the thrust profile rather than whether there is one',
  migrate: (raw) => ({
    ...raw,
    schemaVersion: 3,
    entities: Array.isArray(raw['entities'])
      ? raw['entities'].map((entity: unknown) => {
          if (typeof entity !== 'object' || entity === null) return entity
          const { hasThrusters, ...rest } = entity as Record<string, unknown>
          return {
            ...rest,
            thrusters:
              hasThrusters === true
                ? { mainThrust: 30, rcsThrust: 8, torque: 1.2 }
                : null,
          }
        })
      : [],
  }),
}

export const MIGRATIONS: readonly Migration[] = [v0ToV1, v1ToV2, v2ToV3]

export function migrateSave(
  raw: unknown,
): Result<Record<string, unknown>, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('save is not an object')
  }
  let current = raw as Record<string, unknown>
  const declared = current['schemaVersion']
  let version = typeof declared === 'number' ? declared : 0

  if (version > SAVE_SCHEMA_VERSION) {
    // Refusing is the whole point: a newer save may contain state this build
    // cannot represent, and silently dropping it loses a player's progress.
    return err(
      `save schema v${version} is newer than this build understands (v${SAVE_SCHEMA_VERSION}); update the game`,
    )
  }

  let guard = 0
  while (version < SAVE_SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === version)
    if (step === undefined)
      return err(`no migration from save schema v${version}`)
    current = step.migrate(current)
    version = step.to
    guard += 1
    if (guard > 32) return err('migration chain did not terminate')
  }
  return ok(current)
}
