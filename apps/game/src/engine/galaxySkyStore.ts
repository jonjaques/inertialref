import {
  GALAXY_SKY_ARCHIVE_ENTRIES,
  galaxySkyArchiveKey,
  validateGalaxySkyArchive,
  type GalaxySkyArchiveRecord,
  type GalaxySkyQuery,
  type GalaxySkyStore,
} from '../render/galaxySkyArchive.ts'

// Regenerable radiance has its own quota and lifetime. The save DB is untouched.
const DATABASE = 'inertialref-galaxy-sky'
const STORE = 'completed'
const VERSION = 1
const OPEN_TIMEOUT_MS = 1000
const TRANSACTION_TIMEOUT_MS = 5000

interface StoredSky {
  readonly key: string
  readonly used: number
  readonly record: unknown
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
        if (!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, { keyPath: 'key' })
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
    return this.#access(query)
  }

  async write(record: GalaxySkyArchiveRecord): Promise<void> {
    if (validateGalaxySkyArchive(record, record) === null) return
    await this.#access(record, record)
  }

  async #access(
    query: GalaxySkyQuery,
    write?: GalaxySkyArchiveRecord,
  ): Promise<GalaxySkyArchiveRecord | null> {
    if (this.#factory === undefined) return null
    let db: IDBDatabase | null = null
    try {
      const key = galaxySkyArchiveKey(query)
      db = await open(this.#factory)
      return await new Promise<GalaxySkyArchiveRecord | null>(
        (resolve, reject) => {
          const transaction = db!.transaction(STORE, 'readwrite')
          const store = transaction.objectStore(STORE)
          let found: GalaxySkyArchiveRecord | null = null
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
          const request = store.getAll()
          request.onerror = fail
          request.onsuccess = () => {
            try {
              const rows = (request.result as unknown[]).filter(storedSky)
              const used =
                rows.reduce((max, row) => Math.max(max, row.used), 0) + 1
              if (write !== undefined) {
                const retained = rows
                  .filter((row) => row.key !== key)
                  .sort((a, b) => b.used - a.used)
                  .slice(0, GALAXY_SKY_ARCHIVE_ENTRIES - 1)
                // Replacing this tiny set also retires malformed metadata that
                // cannot participate in LRU ordering. Commit keeps it atomic.
                store.clear()
                for (const row of retained) store.put(row)
                store.put({ key, used, record: write } satisfies StoredSky)
                return
              }
              // Both records are bounded. Looking beyond the regional key avoids
              // a false miss when a nearby observer crosses a bucket boundary.
              rows.sort((a, b) => Number(b.key === key) - Number(a.key === key))
              for (const row of rows) {
                const valid = validateGalaxySkyArchive(row.record, query)
                if (valid === null) continue
                found = valid
                store.put({ ...row, used } satisfies StoredSky)
                return
              }
            } catch {
              transaction.abort()
              fail()
            }
          }
        },
      )
    } catch {
      return null
    } finally {
      db?.close()
    }
  }
}
