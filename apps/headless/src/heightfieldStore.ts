import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deserialize, serialize } from 'node:v8'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {
  HeightfieldCacheRecord,
  HeightfieldStore,
  HeightfieldStoreStats,
} from '@inertialref/workers'

export const DEFAULT_HEIGHTFIELD_DIRECTORY = fileURLToPath(
  new URL('../../../.data/heightfields/', import.meta.url),
)
export interface DiskHeightfieldStoreOptions {
  readonly directory?: string
  readonly maxEntries?: number
  readonly maxBytes?: number
}

/** SQLite makes eviction and tile replacement atomic across simultaneous test processes. */
export class DiskHeightfieldStore implements HeightfieldStore {
  readonly #filename: string
  readonly #maxEntries: number
  readonly #maxBytes: number
  #db: DatabaseSync | null = null
  constructor(options: DiskHeightfieldStoreOptions = {}) {
    this.#filename = join(
      options.directory ?? DEFAULT_HEIGHTFIELD_DIRECTORY,
      'tiles.sqlite',
    )
    this.#maxEntries = Math.max(0, Math.floor(options.maxEntries ?? 65_536))
    this.#maxBytes = Math.max(0, Math.floor(options.maxBytes ?? 4 * 1024 ** 3))
  }
  #open(): DatabaseSync {
    if (this.#db !== null) return this.#db
    mkdirSync(dirname(this.#filename), { recursive: true })
    const db = new DatabaseSync(this.#filename)
    try {
      db.exec(`PRAGMA busy_timeout=100; PRAGMA auto_vacuum=FULL;
        CREATE TABLE IF NOT EXISTS tiles (key TEXT PRIMARY KEY, data BLOB NOT NULL, bytes INTEGER NOT NULL, used INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS tiles_used ON tiles(used);
        CREATE TABLE IF NOT EXISTS tally (id INTEGER PRIMARY KEY CHECK(id=1), entries INTEGER NOT NULL, bytes INTEGER NOT NULL, sequence INTEGER NOT NULL);
        INSERT OR IGNORE INTO tally VALUES(1,0,0,0);
        CREATE TRIGGER IF NOT EXISTS tile_added AFTER INSERT ON tiles BEGIN UPDATE tally SET entries=entries+1, bytes=bytes+NEW.bytes WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS tile_removed AFTER DELETE ON tiles BEGIN UPDATE tally SET entries=entries-1, bytes=bytes-OLD.bytes WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS tile_updated AFTER UPDATE OF bytes ON tiles BEGIN UPDATE tally SET bytes=bytes+NEW.bytes-OLD.bytes WHERE id=1; END;`)
      this.#db = db
      return db
    } catch (cause) {
      db.close()
      throw cause
    }
  }
  #key(key: string): string {
    return createHash('sha256').update(key).digest('hex')
  }
  #transaction<T>(run: (db: DatabaseSync) => T): T {
    const db = this.#open()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = run(db)
      db.exec('COMMIT')
      return result
    } catch (cause) {
      db.exec('ROLLBACK')
      throw cause
    }
  }
  async read(key: string): Promise<unknown> {
    return this.#transaction((db) => {
      const digest = this.#key(key)
      const row = db.prepare('SELECT data FROM tiles WHERE key=?').get(digest)
      if (row === undefined) return null
      db.exec('UPDATE tally SET sequence=sequence+1 WHERE id=1')
      db.prepare(
        'UPDATE tiles SET used=(SELECT sequence FROM tally WHERE id=1) WHERE key=?',
      ).run(digest)
      try {
        return deserialize(row.data as Uint8Array) as unknown
      } catch {
        db.prepare('DELETE FROM tiles WHERE key=?').run(digest)
        return null
      }
    })
  }
  async write(record: HeightfieldCacheRecord): Promise<boolean> {
    const data = serialize(record)
    // SQLite's payload is what occupies disk; the portable estimate is for IndexedDB.
    if (data.byteLength > this.#maxBytes || this.#maxEntries === 0) return false
    this.#transaction((db) => {
      db.exec('UPDATE tally SET sequence=sequence+1 WHERE id=1')
      db.prepare(
        `INSERT INTO tiles VALUES(?,?,?,(SELECT sequence FROM tally WHERE id=1)) ON CONFLICT(key) DO UPDATE SET data=excluded.data, bytes=excluded.bytes, used=excluded.used`,
      ).run(this.#key(record.key), data, data.byteLength)
      for (;;) {
        const tally = db
          .prepare('SELECT entries,bytes FROM tally WHERE id=1')
          .get()!
        if (
          Number(tally.entries) <= this.#maxEntries &&
          Number(tally.bytes) <= this.#maxBytes
        )
          break
        // The tally is the triggers' running total, not a count of rows, so
        // the loop's exit condition and its progress come from two places. An
        // empty table makes the subquery NULL, the delete match nothing and
        // the tally still say it is over budget — a synchronous spin with no
        // timeout above it. Stop on the delete that removes nothing instead.
        const { changes } = db
          .prepare(
            'DELETE FROM tiles WHERE key=(SELECT key FROM tiles ORDER BY used,key LIMIT 1)',
          )
          .run()
        if (Number(changes) === 0) break
      }
    })
    return true
  }
  async remove(key: string): Promise<void> {
    this.#open().prepare('DELETE FROM tiles WHERE key=?').run(this.#key(key))
  }
  async clear(): Promise<void> {
    this.#open().exec('DELETE FROM tiles')
  }
  async stats(): Promise<HeightfieldStoreStats> {
    const tally = this.#open()
      .prepare('SELECT entries,bytes FROM tally WHERE id=1')
      .get()!
    return {
      entries: Number(tally.entries),
      bytes: Number(tally.bytes),
      maxEntries: this.#maxEntries,
      maxBytes: this.#maxBytes,
    }
  }
  close(): void {
    this.#db?.close()
    this.#db = null
  }
}
