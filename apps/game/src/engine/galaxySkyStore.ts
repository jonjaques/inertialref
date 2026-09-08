import {
  GALAXY_SKY_ARCHIVE_ENTRIES,
  galaxySkyArchiveKey,
  galaxySkyArchiveMatches,
  validateGalaxySkyArchiveAsync,
  type GalaxySkyArchiveRecord,
  type GalaxySkyQuery,
  type GalaxySkyStore,
} from '../render/galaxySkyArchive.ts'

// Regenerable radiance has its own quota and lifetime. The save DB is untouched.
const DATABASE = 'inertialref-galaxy-sky'
const STORE = 'completed'
const METADATA = 'metadata'
const VERSION = 2
const OPEN_TIMEOUT_MS = 1000
const TRANSACTION_TIMEOUT_MS = 5000

interface StoredSky {
  readonly key: string
  readonly used: number
  readonly query: unknown
}

function storedSky(value: unknown): value is StoredSky {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<StoredSky>
  return (
    typeof row.key === 'string' &&
    typeof row.used === 'number' &&
    Number.isSafeInteger(row.used) &&
    row.used >= 0 &&
    row.used < Number.MAX_SAFE_INTEGER
  )
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, VERSION)
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('Physical sky cache is unavailable'))
    }
    const timer = setTimeout(fail, OPEN_TIMEOUT_MS)
    request.onblocked = fail
    request.onerror = fail
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort()
        return
      }
      try {
        const db = request.result
        if (!db.objectStoreNames.contains(METADATA)) {
          // Version 1 mixed LRU metadata with 12 MiB cubes. These are regenerable;
          // retire that cache once rather than clone it during the upgrade.
          if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE)
          db.createObjectStore(STORE, { keyPath: 'key' })
          db.createObjectStore(METADATA, { keyPath: 'key' })
        }
      } catch {
        request.transaction?.abort()
        fail()
      }
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      settled = true
      clearTimeout(timer)
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
}

/**
 * Two completed cubes survive reload. Read and touch share a transaction with
 * eviction, so concurrent tabs cannot retain an unbounded set of regions.
 */
export class IndexedDbGalaxySkyStore implements GalaxySkyStore {
  readonly #factory: IDBFactory | undefined

  constructor(factory: IDBFactory | undefined = globalThis.indexedDB) {
    this.#factory = factory
  }

  async read(query: GalaxySkyQuery): Promise<GalaxySkyArchiveRecord | null> {
    // Never await validation inside an IDB transaction: yielding would let it
    // auto-commit. Only metadata and eligible payload requests live there.
    for (const value of await this.#access(query)) {
      const record = await validateGalaxySkyArchiveAsync(value, query)
      if (record !== null) return record
    }
    return null
  }

  async write(record: GalaxySkyArchiveRecord): Promise<void> {
    if ((await validateGalaxySkyArchiveAsync(record, record)) === null) return
    await this.#access(record, record)
  }

  async #access(
    query: GalaxySkyQuery,
    write?: GalaxySkyArchiveRecord,
  ): Promise<unknown[]> {
    if (this.#factory === undefined) return []
    let db: IDBDatabase | null = null
    try {
      const key = galaxySkyArchiveKey(query)
      db = await open(this.#factory)
      return await new Promise<unknown[]>((resolve, reject) => {
        const transaction = db!.transaction([STORE, METADATA], 'readwrite')
        const store = transaction.objectStore(STORE)
        const metadata = transaction.objectStore(METADATA)
        const found: unknown[] = []
        const timer = setTimeout(() => {
          transaction.abort()
          fail()
        }, TRANSACTION_TIMEOUT_MS)
        const fail = () => {
          clearTimeout(timer)
          reject(new Error('Physical sky cache transaction failed'))
        }
        transaction.onerror = fail
        transaction.onabort = fail
        transaction.oncomplete = () => {
          clearTimeout(timer)
          resolve(found)
        }
        const request = metadata.getAll()
        request.onerror = fail
        request.onsuccess = () => {
          try {
            const rows = (request.result as unknown[]).filter(storedSky)
            const used =
              rows.reduce((max, row) => Math.max(max, row.used), 0) + 1
            if (write !== undefined) {
              const retained = rows
                .filter(
                  (row) =>
                    row.key !== key &&
                    galaxySkyArchiveMatches(row.query, row.query),
                )
                .sort((a, b) => b.used - a.used)
                .slice(0, GALAXY_SKY_ARCHIVE_ENTRIES - 1)
              // Enumerate keys, never retained pixel records. Deletion and the
              // small metadata replacement remain atomic with the new payload.
              const keys = store.getAllKeys()
              keys.onsuccess = () => {
                try {
                  const keep = new Set(retained.map((row) => row.key))
                  for (const old of keys.result)
                    if (!keep.has(String(old))) store.delete(old)
                  metadata.clear()
                  for (const row of retained) metadata.put(row)
                  const { faces: _faces, ...header } = write
                  metadata.put({ key, used, query: header } satisfies StoredSky)
                  store.put({ key, record: write })
                } catch {
                  transaction.abort()
                  fail()
                }
              }
              keys.onerror = fail
              return
            }
            // A neighboring key can still be within the physical reuse budget.
            // Inspect its header before asking IDB to clone any pixels.
            rows.sort((a, b) => Number(b.key === key) - Number(a.key === key))
            for (const row of rows) {
              if (!galaxySkyArchiveMatches(row.query, query)) continue
              const payload = store.get(row.key)
              payload.onsuccess = () => {
                const value: unknown = payload.result
                if (
                  typeof value === 'object' &&
                  value !== null &&
                  'record' in value
                )
                  found.push(value.record)
              }
              payload.onerror = fail
              metadata.put({ ...row, used } satisfies StoredSky)
            }
          } catch {
            transaction.abort()
            fail()
          }
        }
      })
    } catch {
      return []
    } finally {
      db?.close()
    }
  }
}
