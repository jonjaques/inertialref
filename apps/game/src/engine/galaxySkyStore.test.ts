import { describe, expect, it, vi } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, type UniverseVector } from '@inertialref/spatial'
import { createGalaxyField } from '@inertialref/universe'
import {
  GALAXY_SKY_ARCHIVE_VERSION,
  galaxySkyArchiveKey,
  galaxySkyQuery,
  type GalaxySkyArchiveRecord,
} from '../render/galaxySkyArchive.ts'
import { IndexedDbGalaxySkyStore } from './galaxySkyStore.ts'

function record(origin: UniverseVector): GalaxySkyArchiveRecord {
  return {
    ...galaxySkyQuery(
      createGalaxyField(rootSeed('archive')),
      origin,
      16,
      'tsl@6',
    ),
    version: GALAXY_SKY_ARCHIVE_VERSION,
    faces: Array.from({ length: 6 }, () => {
      const face = new Uint16Array(16 * 16 * 4)
      for (let i = 3; i < face.length; i += 4) face[i] = 0x3c00
      return face
    }),
  }
}

/** A request/event boundary, including transaction commit and abort. No DOM is installed. */
function database() {
  const rows = new Map<string, unknown>()
  let failTransaction = false
  const close = vi.fn()
  const db = {
    objectStoreNames: { contains: () => false },
    createObjectStore: vi.fn(),
    close,
    transaction: vi.fn(() => {
      const pending = new Map(rows)
      const transaction = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null,
        abort: vi.fn(() => transaction.onabort?.()),
        objectStore: () => ({
          getAll: () => {
            const request = {
              result: [...pending.values()].map((row) => structuredClone(row)),
              onsuccess: null as (() => void) | null,
              onerror: null as (() => void) | null,
            }
            queueMicrotask(() => {
              request.onsuccess?.()
              if (failTransaction) transaction.onabort?.()
              else {
                rows.clear()
                for (const [key, value] of pending) rows.set(key, value)
                transaction.oncomplete?.()
              }
            })
            return request
          },
          put: (value: { key: string }) =>
            pending.set(value.key, structuredClone(value)),
          clear: () => pending.clear(),
          delete: (key: string) => pending.delete(key),
        }),
      }
      return transaction
    }),
  }
  const open = vi.fn((_name: string, _version: number) => {
    const request = {
      result: db,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    }
    queueMicrotask(() => {
      request.onupgradeneeded?.()
      request.onsuccess?.()
    })
    return request
  })
  return {
    factory: { open } as unknown as IDBFactory,
    open,
    rows,
    close,
    failTransactions: () => {
      failTransaction = true
    },
  }
}

describe('IndexedDB physical sky cache', () => {
  it('retains two records, touches a reused entry, and waits for commit', async () => {
    const db = database()
    const store = new IndexedDbGalaxySkyStore(db.factory)
    const a = record(UV.fromMeters(0, 0, 0))
    const b = record(UV.fromMeters(PARSEC, 0, 0))
    const c = record(UV.fromMeters(2 * PARSEC, 0, 0))
    await store.write(a)
    await store.write(b)
    expect((await store.read(a))?.faces).toEqual(a.faces)
    await store.write(c)
    expect(db.rows.size).toBe(2)
    expect(await store.read(b)).toBeNull()
    expect(await store.read(a)).not.toBeNull()
    expect(await store.read(c)).not.toBeNull()
    expect(db.open.mock.calls[0]?.[0]).not.toBe('inertialref')
    expect(db.close).toHaveBeenCalledTimes(db.open.mock.calls.length)
  })

  it('finds a nearby record across a regional key boundary', async () => {
    const db = database()
    const store = new IndexedDbGalaxySkyStore(db.factory)
    const archived = record(UV.universeVector(8191, 0, 0, 0, 0, 0))
    const nextRegion = record(UV.universeVector(8192, 0, 0, 0, 0, 0))
    expect(galaxySkyArchiveKey(archived)).not.toBe(
      galaxySkyArchiveKey(nextRegion),
    )
    await store.write(archived)
    expect(await store.read(nextRegion)).not.toBeNull()
    expect(
      await store.read({ ...nextRegion, kernelVersion: 'tsl@7' }),
    ).toBeNull()
  })

  it('treats unavailable, blocked, and aborted storage as misses', async () => {
    const archived = record(UV.fromMeters(0, 0, 0))
    const absent = new IndexedDbGalaxySkyStore(undefined)
    expect(await absent.read(archived)).toBeNull()
    await expect(absent.write(archived)).resolves.toBeUndefined()
    const blocked = new IndexedDbGalaxySkyStore({
      open: () => {
        const request = { onblocked: null as (() => void) | null }
        queueMicrotask(() => request.onblocked?.())
        return request
      },
    } as unknown as IDBFactory)
    expect(await blocked.read(archived)).toBeNull()
    const db = database()
    const store = new IndexedDbGalaxySkyStore(db.factory)
    db.failTransactions()
    await expect(store.write(archived)).resolves.toBeUndefined()
    expect(db.rows.size).toBe(0)
    expect(await store.read(archived)).toBeNull()
    expect(db.close).toHaveBeenCalledTimes(2)
  })

  it('refuses invalid writes before opening storage and corrupt reads', async () => {
    const db = database()
    const store = new IndexedDbGalaxySkyStore(db.factory)
    const archived = record(UV.fromMeters(0, 0, 0))
    await store.write({ ...archived, faces: [] })
    expect(db.open).not.toHaveBeenCalled()
    await store.write(archived)
    const value = db.rows.values().next().value as {
      record: GalaxySkyArchiveRecord
    }
    value.record.faces[0]![0] = 0x7e00
    expect(await store.read(archived)).toBeNull()
    db.rows.set('damaged metadata', { key: 'damaged metadata', used: NaN })
    await store.write(record(UV.fromMeters(PARSEC, 0, 0)))
    expect(db.rows.size).toBeLessThanOrEqual(2)
    expect(db.rows.has('damaged metadata')).toBe(false)
  })

  it('abandons a stalled open and closes a late database connection', async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn()
      const request = {
        result: { close },
        onsuccess: null as (() => void) | null,
      }
      const store = new IndexedDbGalaxySkyStore({
        open: () => request,
      } as unknown as IDBFactory)
      const reading = store.read(record(UV.fromMeters(0, 0, 0)))
      await vi.advanceTimersByTimeAsync(1001)
      expect(await reading).toBeNull()
      request.onsuccess?.()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
