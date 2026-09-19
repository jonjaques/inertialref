import type {
  HeightfieldCacheRecord,
  HeightfieldStore,
  HeightfieldStoreStats,
} from '@inertialref/workers'

export const TERRAIN_CACHE_DATABASE = 'inertialref-terrain'
const TILES = 'tiles'
const METADATA = 'metadata'
const TALLY = 'tally'
const ALL_STORES = [TILES, METADATA, TALLY]
interface Tally {
  entries: number
  bytes: number
  sequence: number
}
interface Metadata {
  key: string
  bytes: number
  used: number
}
const EMPTY: Tally = { entries: 0, bytes: 0, sequence: 0 }
export interface TerrainStoreOptions {
  readonly factory?: IDBFactory | null
  readonly maxEntries?: number
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

/** A bounded archive of regenerable terrain, with no connection to the save database. */
export class IndexedDbHeightfieldStore implements HeightfieldStore {
  readonly #factory: IDBFactory | undefined
  readonly #maxEntries: number
  readonly #maxBytes: number
  readonly #timeout: number
  #database: Promise<IDBDatabase> | null = null
  readonly #digests = new Map<string, Promise<string>>()
  constructor(options: TerrainStoreOptions = {}) {
    this.#factory =
      options.factory === null
        ? undefined
        : (options.factory ?? globalThis.indexedDB)
    this.#maxEntries = Math.max(0, Math.floor(options.maxEntries ?? 8192))
    this.#maxBytes = Math.max(
      0,
      Math.floor(options.maxBytes ?? 256 * 1024 ** 2),
    )
    this.#timeout = options.timeoutMs ?? 1000
  }
  #key(signature: string): Promise<string> {
    const known = this.#digests.get(signature)
    if (known !== undefined) return known
    const digest = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(signature))
      .then((bytes) =>
        Array.from(new Uint8Array(bytes), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      )
    this.#digests.set(signature, digest)
    if (this.#digests.size > 2048)
      this.#digests.delete(this.#digests.keys().next().value!)
    return digest
  }
  #open(): Promise<IDBDatabase> {
    if (this.#database !== null) return this.#database
    if (this.#factory === undefined)
      return Promise.reject(new Error('Terrain cache storage unavailable'))
    const factory = this.#factory
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(TERRAIN_CACHE_DATABASE, 1)
      let settled = false
      const fail = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('Terrain cache open failed'))
      }
      const timer = setTimeout(fail, this.#timeout)
      request.onerror = fail
      request.onblocked = fail
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort()
          return
        }
        try {
          const db = request.result
          db.createObjectStore(TILES)
          const metadata = db.createObjectStore(METADATA, { keyPath: 'key' })
          metadata.createIndex('used', 'used')
          db.createObjectStore(TALLY)
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
        db.onversionchange = () => {
          db.close()
          this.#database = null
        }
        resolve(db)
      }
    })
    this.#database = opening
    void opening.catch(() => {
      if (this.#database === opening) this.#database = null
    })
    return opening
  }
  async #run<T>(
    mode: IDBTransactionMode,
    initial: T,
    operate: (transaction: IDBTransaction, result: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.#open()
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(ALL_STORES, mode)
      let value = initial
      const fail = () => {
        clearTimeout(timer)
        reject(new Error('Terrain cache transaction failed'))
      }
      const timer = setTimeout(() => {
        try {
          transaction.abort()
        } catch {
          /* A completed transaction cannot abort. */
        }
        fail()
      }, this.#timeout)
      transaction.onerror = fail
      transaction.onabort = fail
      transaction.oncomplete = () => {
        clearTimeout(timer)
        resolve(value)
      }
      try {
        operate(transaction, (next) => {
          value = next
        })
      } catch {
        transaction.abort()
        fail()
      }
    })
  }
  async read(signature: string): Promise<unknown> {
    const key = await this.#key(signature)
    return this.#run<unknown>('readwrite', null, (transaction, result) => {
      const tiles = transaction.objectStore(TILES)
      const meta = transaction.objectStore(METADATA)
      const tally = transaction.objectStore(TALLY)
      const read = tiles.get(key)
      read.onsuccess = () => {
        result(read.result ?? null)
        if (read.result === undefined) return
        const row = meta.get(key)
        row.onsuccess = () => {
          if (row.result === undefined) return
          const state = tally.get(0)
          state.onsuccess = () => {
            const next = { ...(state.result ?? EMPTY) } as Tally
            next.sequence++
            meta.put({ ...(row.result as Metadata), used: next.sequence })
            tally.put(next, 0)
          }
        }
      }
    })
  }
  async write(record: HeightfieldCacheRecord): Promise<void> {
    const key = await this.#key(record.key)
    if (record.bytes > this.#maxBytes || this.#maxEntries === 0) return
    await this.#run<void>('readwrite', undefined, (transaction) => {
      const tiles = transaction.objectStore(TILES)
      const meta = transaction.objectStore(METADATA)
      const tally = transaction.objectStore(TALLY)
      const old = meta.get(key)
      old.onsuccess = () => {
        const state = tally.get(0)
        state.onsuccess = () => {
          const next = { ...(state.result ?? EMPTY) } as Tally
          const prior = old.result as Metadata | undefined
          next.entries += prior === undefined ? 1 : 0
          next.bytes += record.bytes - (prior?.bytes ?? 0)
          next.sequence++
          tiles.put(record, key)
          meta.put({
            key,
            bytes: record.bytes,
            used: next.sequence,
          })
          const evict = meta.index('used').openCursor()
          evict.onsuccess = () => {
            if (
              next.entries <= this.#maxEntries &&
              next.bytes <= this.#maxBytes
            ) {
              tally.put(next, 0)
              return
            }
            const cursor = evict.result
            if (cursor === null) {
              transaction.abort()
              return
            }
            const entry = cursor.value as Metadata
            tiles.delete(entry.key)
            cursor.delete()
            next.entries--
            next.bytes -= entry.bytes
            cursor.continue()
          }
        }
      }
    })
  }
  async remove(signature: string): Promise<void> {
    const key = await this.#key(signature)
    await this.#run<void>('readwrite', undefined, (transaction) => {
      const meta = transaction.objectStore(METADATA)
      const old = meta.get(key)
      old.onsuccess = () => {
        if (old.result === undefined) return
        const tally = transaction.objectStore(TALLY)
        const state = tally.get(0)
        state.onsuccess = () => {
          const next = { ...(state.result ?? EMPTY) } as Tally
          next.entries--
          next.bytes -= (old.result as Metadata).bytes
          meta.delete(key)
          transaction.objectStore(TILES).delete(key)
          tally.put(next, 0)
        }
      }
    })
  }
  async clear(): Promise<void> {
    await this.#run<void>('readwrite', undefined, (transaction) => {
      for (const name of ALL_STORES) transaction.objectStore(name).clear()
    })
  }
  async stats(): Promise<HeightfieldStoreStats> {
    return this.#run(
      'readonly',
      {
        entries: 0,
        bytes: 0,
        maxEntries: this.#maxEntries,
        maxBytes: this.#maxBytes,
      },
      (transaction, result) => {
        const read = transaction.objectStore(TALLY).get(0)
        read.onsuccess = () => {
          const tally = (read.result ?? EMPTY) as Tally
          result({
            entries: tally.entries,
            bytes: tally.bytes,
            maxEntries: this.#maxEntries,
            maxBytes: this.#maxBytes,
          })
        }
      },
    )
  }
}
