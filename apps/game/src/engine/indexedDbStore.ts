import { err, ok, type Result } from '@inertialref/shared'
import type { SaveStore } from '@inertialref/persistence'

/*
 * IndexedDB save store.
 *
 * Offline-first means saves have to survive with no server, and localStorage is
 * a synchronous 5 MB box that blocks the main thread — fine for the 600-byte
 * saves this milestone produces, wrong the moment persistent mutations arrive.
 * Starting on IndexedDB avoids a migration later.
 *
 * The whole thing is behind `SaveStore`, so Node tests and the headless runner
 * use the in-memory implementation and never see this file.
 */

const DATABASE = 'inertialref'
const STORE = 'saves'
const VERSION = 1

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

export class IndexedDbSaveStore implements SaveStore {
  async read(slot: string): Promise<Result<string, string>> {
    try {
      const db = await open()
      const value = await promisify<string | undefined>(
        db.transaction(STORE, 'readonly').objectStore(STORE).get(slot) as IDBRequest<string | undefined>,
      )
      db.close()
      return value === undefined ? err(`No save in slot "${slot}"`) : ok(value)
    } catch (cause) {
      return err(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async write(slot: string, contents: string): Promise<Result<void, string>> {
    try {
      const db = await open()
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(contents, slot)
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('write failed'))
      })
      db.close()
      return ok(undefined)
    } catch (cause) {
      return err(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async list(): Promise<readonly string[]> {
    try {
      const db = await open()
      const keys = await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys())
      db.close()
      return keys.map((key) => String(key)).sort()
    } catch {
      return []
    }
  }

  async remove(slot: string): Promise<void> {
    const db = await open()
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(slot)
    db.close()
  }
}
