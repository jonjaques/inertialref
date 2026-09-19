import { describe, expect, it, vi } from 'vitest'
import type { HeightfieldCacheRecord } from '@inertialref/workers'
import {
  IndexedDbHeightfieldStore,
  TERRAIN_CACHE_DATABASE,
} from './terrainStore.ts'

function database() {
  const stores = new Map<string, Map<unknown, unknown>>()
  let quota = false
  let held = false
  let active = 0
  let peak = 0
  const commits: (() => void)[] = []
  const modes: string[] = []
  const db = {
    close: vi.fn(),
    createObjectStore: (name: string) => {
      stores.set(name, new Map())
      return { createIndex() {} }
    },
    transaction: (_stores: string[], mode: string) => {
      modes.push(mode)
      active++
      peak = Math.max(peak, active)
      const values = new Map(
        [...stores].map(([name, rows]) => [name, new Map(rows)]),
      )
      let pending = 0
      let aborted = false
      let complete = false
      const transaction = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        abort: () => {
          if (aborted) return
          aborted = true
          active--
          transaction.onabort?.()
        },
        objectStore: (name: string) => {
          const rows = values.get(name)!
          function enqueue(
            run: () => unknown,
            existing?: { result: unknown; onsuccess: (() => void) | null },
          ): { result: unknown; onsuccess: (() => void) | null } {
            pending++
            const request = existing ?? { result: undefined, onsuccess: null }
            queueMicrotask(() => {
              if (aborted) return
              try {
                request.result = run()
                request.onsuccess?.()
              } catch {
                transaction.abort()
              }
              pending--
              if (pending !== 0 || complete || aborted) return
              complete = true
              if (quota) {
                transaction.abort()
                return
              }
              const commit = () => {
                if (aborted) return
                for (const [key, map] of values) stores.set(key, map)
                active--
                transaction.oncomplete?.()
              }
              if (held) commits.push(commit)
              else commit()
            })
            return request
          }
          return {
            get: (key: unknown) =>
              enqueue(() => structuredClone(rows.get(key))),
            put: (value: unknown, key?: unknown) =>
              enqueue(() =>
                rows.set(
                  key ?? (value as { key: unknown }).key,
                  structuredClone(value),
                ),
              ),
            delete: (key: unknown) => enqueue(() => rows.delete(key)),
            clear: () => enqueue(() => rows.clear()),
            index: () => ({
              openCursor: () => {
                const ordered = [...rows.values()].sort(
                  (a, b) =>
                    (a as { used: number }).used - (b as { used: number }).used,
                ) as { key: string }[]
                let index = 0
                const request = {
                  result: undefined as unknown,
                  onsuccess: null as (() => void) | null,
                }
                const next = (): unknown => {
                  const value = ordered[index++]
                  return value === undefined
                    ? null
                    : {
                        value,
                        delete: () => enqueue(() => rows.delete(value.key)),
                        continue: () => enqueue(next, request),
                      }
                }
                return enqueue(next, request)
              },
            }),
          }
        },
      }
      return transaction
    },
  }
  let initialized = false
  const open = vi.fn(() => {
    const request = {
      result: db,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
    }
    queueMicrotask(() => {
      if (!initialized) {
        initialized = true
        request.onupgradeneeded?.()
      }
      request.onsuccess?.()
    })
    return request
  })
  return {
    factory: { open } as unknown as IDBFactory,
    stores,
    open,
    quota: () => {
      quota = true
    },
    modes,
    pending: () => commits.length,
    peak: () => peak,
    hold: () => {
      held = true
    },
    release: () => {
      held = false
      for (const commit of commits.splice(0)) commit()
    },
  }
}
const record = (key: string, bytes = 100): HeightfieldCacheRecord => ({
  key,
  bytes,
  checksum: 0,
  field: {} as HeightfieldCacheRecord['field'],
})

describe('browser terrain archive', () => {
  it('stores tiles in its own database and evicts by recent reads', async () => {
    const db = database()
    const store = new IndexedDbHeightfieldStore({
      factory: db.factory,
      maxEntries: 2,
    })
    await store.write(record('a'))
    await store.write(record('b'))
    await store.read('a')
    await store.write(record('c'))
    expect(await store.read('b')).toBeNull()
    expect(await store.read('a')).toEqual(record('a'))
    expect(await store.stats()).toMatchObject({ entries: 2, bytes: 200 })
    expect(db.open).toHaveBeenCalledWith(TERRAIN_CACHE_DATABASE, 1)
    expect(db.open).toHaveBeenCalledOnce()
  })
  it('accounts replacement, byte eviction, oversize refusal, removal and clearing', async () => {
    const db = database()
    const store = new IndexedDbHeightfieldStore({
      factory: db.factory,
      maxBytes: 150,
    })
    await store.write(record('a', 50))
    await store.write(record('a', 100))
    await store.write(record('b', 100))
    expect(await store.read('a')).toBeNull()
    expect(await store.write(record('large', 200))).toBe(false)
    expect(await store.stats()).toMatchObject({ entries: 1, bytes: 100 })
    await store.remove('b')
    expect(await store.stats()).toMatchObject({ entries: 0, bytes: 0 })
    await store.write(record('c'))
    await store.clear()
    expect(await store.stats()).toMatchObject({ entries: 0, bytes: 0 })
  })
  it('rejects a quota abort without committing its metadata', async () => {
    const db = database()
    const store = new IndexedDbHeightfieldStore({ factory: db.factory })
    await store.write(record('a'))
    db.quota()
    await expect(store.write(record('b'))).rejects.toThrow('transaction failed')
    expect(db.stores.get('metadata')?.size).toBe(1)
  })
  it('retries an open that timed out rather than retiring the archive', async () => {
    // The budget is a guess about a busy machine, so memoizing the rejection
    // would cost the whole visit: every later landing regenerates ground that
    // is already on disk.
    const db = database()
    let opens = 0
    const factory = {
      open: (...args: unknown[]) => {
        opens += 1
        return opens === 1
          ? {}
          : (db.factory.open as unknown as (...a: unknown[]) => unknown)(
              ...args,
            )
      },
    } as unknown as IDBFactory
    const store = new IndexedDbHeightfieldStore({ factory, timeoutMs: 2 })
    await expect(store.read('a')).rejects.toThrow('open failed')
    await store.write(record('a'))
    expect(await store.read('a')).toEqual(record('a'))
    expect(opens).toBe(2)
  })
  it('refuses unavailable and blocked storage within a bounded wait', async () => {
    await expect(
      new IndexedDbHeightfieldStore({ factory: null }).read('a'),
    ).rejects.toThrow('unavailable')
    const factory = { open: () => ({}) } as unknown as IDBFactory
    await expect(
      new IndexedDbHeightfieldStore({ factory, timeoutMs: 2 }).read('a'),
    ).rejects.toThrow('open failed')
  })
})

it('admits only eight transactions while misses stay readonly', async () => {
  const db = database()
  const store = new IndexedDbHeightfieldStore({ factory: db.factory })
  db.hold()
  const reads = Array.from({ length: 40 }, (_, i) => store.read(`missing-${i}`))
  await vi.waitFor(() => expect(db.pending()).toBe(8), { interval: 1 })
  expect(db.peak()).toBe(8)
  expect(db.modes.every((mode) => mode === 'readonly')).toBe(true)
  db.release()
  expect(await Promise.all(reads)).toEqual(Array(40).fill(null))
  expect(db.peak()).toBe(8)
})

it('releases admission slots when storage transactions abort', async () => {
  const db = database()
  const store = new IndexedDbHeightfieldStore({ factory: db.factory })
  db.quota()
  const reads = await Promise.allSettled(
    Array.from({ length: 40 }, (_, i) => store.read(`aborted-${i}`)),
  )
  expect(reads.every((read) => read.status === 'rejected')).toBe(true)
  expect(db.peak()).toBeLessThanOrEqual(8)
})
