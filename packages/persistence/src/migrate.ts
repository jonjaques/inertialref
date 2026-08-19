import { err, ok, type Result } from '@inertialref/shared'
import { SAVE_SCHEMA_VERSION } from '@inertialref/protocol'

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
  describe: 'wrap the single ship in an entity list and record generation versions',
  migrate(raw) {
    const ship = raw['ship']
    return {
      schemaVersion: 1,
      seed: raw['seed'] ?? 'inertialref',
      galaxy: raw['galaxy'] ?? 'milky-way',
      tick: raw['tick'] ?? 0,
      generation: raw['generation'] ?? {},
      entities: ship === undefined ? [] : [ship],
      playerEntity: ship === undefined ? null : (ship as { id?: string }).id ?? null,
      dynamicIdCounter: raw['dynamicIdCounter'] ?? 1,
      loadedSystems: raw['loadedSystems'] ?? [],
      mutations: [],
      meta: { migratedFrom: 'v0' },
    }
  },
}

export const MIGRATIONS: readonly Migration[] = [v0ToV1]

export function migrateSave(raw: unknown): Result<Record<string, unknown>, string> {
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
    if (step === undefined) return err(`no migration from save schema v${version}`)
    current = step.migrate(current)
    version = step.to
    guard += 1
    if (guard > 32) return err('migration chain did not terminate')
  }
  return ok(current)
}
