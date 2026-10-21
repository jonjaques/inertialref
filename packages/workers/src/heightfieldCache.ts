import {
  COVER_CHANNELS,
  HEIGHTFIELD_BORDER,
  TERRAIN_ALGORITHM,
  type HeightfieldRequest,
  type SurfaceParameters,
} from '@inertialref/universe'
import type { JobHandle, JobLane } from './pool.ts'
import {
  type ArchivedSource,
  encodeSurface,
  type HeightfieldResponse,
  type HeightfieldSource,
} from './tasks.ts'

/*
 * The heightfield archive: regenerable tiles kept across reloads and test
 * processes, behind a host store (ADR-0045).
 *
 * One `HeightfieldArchive` per store owns everything the store's users share
 * — the clear epoch, the writes in flight, the counters — and hands out a
 * wrapper per source. A tile's identity is the canonical terrain version, the
 * namespace its source declares, and every input: nothing else, and nothing
 * the archive has to be told to bump.
 */

/**
 * What a source's tiles are kept under: the canonical terrain version, which
 * every producer's ground follows, and the source's own namespace. CI keys
 * its cache of the disk archive on the pool's (`scripts/terrainArchive.mjs`).
 */
export const heightfieldArchiveVersion = (namespace: string): string =>
  `${TERRAIN_ALGORITHM.version}:${namespace}`

export interface HeightfieldCacheRecord {
  readonly key: string
  readonly field: HeightfieldResponse
  readonly checksum: number
  readonly bytes: number
}
export interface HeightfieldStoreStats {
  readonly entries: number
  readonly bytes: number
  readonly maxEntries: number
  readonly maxBytes: number
}
/** Host storage for regenerable tiles, separate from the save store. */
export interface HeightfieldStore {
  read(key: string): Promise<unknown>
  /** False means the tile exceeds the host quota and is deliberately not stored. */
  write(record: HeightfieldCacheRecord): Promise<void | boolean>
  remove(key: string): Promise<void>
  clear(): Promise<void>
  stats(): Promise<HeightfieldStoreStats>
  /** Release the host's handle; a store that holds none has nothing to do. */
  close?(): void
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  // `JSON.stringify` writes `null` for NaN and for either infinity, so three
  // distinct numbers and an absent value would share one key — which is the
  // one failure this key is built to make impossible. Spell them instead.
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(',')}}`
}

const surfaceKeys = new WeakMap<SurfaceParameters, string>()

/** Every field travels into the key; adding a surface/request member cannot silently omit it. */
export function heightfieldCacheKey(
  surface: SurfaceParameters,
  request: HeightfieldRequest,
  namespace: string,
): string {
  let encoded = surfaceKeys.get(surface)
  if (encoded === undefined) {
    encoded = stable(encodeSurface(surface))
    surfaceKeys.set(surface, encoded)
  }
  return `${JSON.stringify(heightfieldArchiveVersion(namespace))}:${encoded}:${stable(request)}`
}

function checksum(field: HeightfieldResponse): number {
  let hash = 2166136261
  for (const array of [field.elevations, field.cover, field.water]) {
    const bytes = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength,
    )
    // An indexed walk rather than `for…of`: this runs over every byte of
    // every tile on both the write and the read path, and the iterator
    // protocol is the dominant term at a hundred thousand bytes a tile.
    for (let i = 0; i < bytes.length; i++)
      hash = Math.imul(hash ^ bytes[i]!, 16777619)
  }
  return hash >>> 0
}

/** The portable estimate both the record and its validation must agree on. */
function recordBytes(key: string, field: HeightfieldResponse): number {
  return (
    field.elevations.byteLength +
    field.cover.byteLength +
    field.water.byteLength +
    key.length * 2 +
    128
  )
}

export function heightfieldCacheRecord(
  key: string,
  field: HeightfieldResponse,
): HeightfieldCacheRecord {
  return {
    key,
    field,
    checksum: checksum(field),
    bytes: recordBytes(key, field),
  }
}

export function validateHeightfieldCacheRecord(
  value: unknown,
  key: string,
  request: HeightfieldRequest,
): HeightfieldCacheRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Partial<HeightfieldCacheRecord>
  const field = row.field
  if (row.key !== key || typeof field !== 'object' || field === null)
    return null
  const resolution = request.resolution
  const border = request.border ?? HEIGHTFIELD_BORDER
  if (
    field.resolution !== resolution ||
    field.border !== border ||
    stable(field.region) !== stable(request.region)
  )
    return null
  const count = resolution * resolution
  const stride = resolution + 2 * border
  if (
    !(field.elevations instanceof Float32Array) ||
    field.elevations.length !== stride * stride ||
    !(field.cover instanceof Uint8Array) ||
    field.cover.length !== count * COVER_CHANNELS ||
    !(field.water instanceof Float32Array) ||
    field.water.length !== count
  )
    return null
  if (
    !Number.isFinite(field.minElevation) ||
    !Number.isFinite(field.maxElevation) ||
    field.minElevation > field.maxElevation
  )
    return null
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < field.elevations.length; i++) {
    const elevation = field.elevations[i]!
    if (!Number.isFinite(elevation)) return null
    const x = i % stride
    const y = Math.floor(i / stride)
    if (
      x >= border &&
      x < border + resolution &&
      y >= border &&
      y < border + resolution
    ) {
      min = Math.min(min, elevation)
      max = Math.max(max, elevation)
    }
  }
  // CPU extrema are recorded before the float32 store. Permit that rounding only.
  const tolerance = Math.max(1, Math.abs(min), Math.abs(max)) * 2 ** -22
  if (
    Math.abs(min - field.minElevation) > tolerance ||
    Math.abs(max - field.maxElevation) > tolerance
  )
    return null
  for (const water of field.water)
    if (!Number.isFinite(water) && !Number.isNaN(water)) return null
  if (row.checksum !== checksum(field)) return null
  return row.bytes === recordBytes(key, field)
    ? (row as HeightfieldCacheRecord)
    : null
}

export interface HeightfieldCacheStats {
  readonly hits: number
  readonly misses: number
  readonly invalid: number
  readonly writes: number
  readonly readErrors: number
  readonly writeErrors: number
  readonly canceled: number
  readonly pendingWrites: number
}

/** What every wrapper over one store shares; the archive owns it. */
interface ArchiveState {
  readonly store: HeightfieldStore
  readonly writes: Set<Promise<void>>
  readonly counts: {
    hits: number
    misses: number
    invalid: number
    writes: number
    readErrors: number
    writeErrors: number
    canceled: number
  }
  /** Bumped by `clear` and `close`: a lookup from an older epoch writes nothing. */
  epoch: number
  closed: boolean
}

/**
 * One store, and everything its users share.
 *
 * The CPU and GPU producers write to the same store under different
 * namespaces, so a clear has to retire both producers' lookups in flight, and
 * the counters describe the store, not one producer. That state lives here
 * and nowhere else: a wrapper made by `wrap` holds the archive's, so clearing
 * through the archive is the only clear there is.
 */
export class HeightfieldArchive {
  readonly #state: ArchiveState

  constructor(store: HeightfieldStore) {
    this.#state = {
      store,
      writes: new Set(),
      counts: {
        hits: 0,
        misses: 0,
        invalid: 0,
        writes: 0,
        readErrors: 0,
        writeErrors: 0,
        canceled: 0,
      },
      epoch: 0,
      closed: false,
    }
  }

  /** The source, answering from the archive first, under its own namespace. */
  wrap(source: ArchivedSource): HeightfieldSource {
    return new ArchivedHeightfieldSource(source, this.#state)
  }

  stats(): HeightfieldCacheStats {
    return { ...this.#state.counts, pendingWrites: this.#state.writes.size }
  }

  /**
   * The host's retained entries and bytes. Refused after `close`, as `clear`
   * is: a disk store reopens its handle for any call.
   */
  storage(): Promise<HeightfieldStoreStats> {
    if (this.#state.closed)
      return Promise.reject(new Error('the heightfield archive is closed'))
    return this.#state.store.stats()
  }

  /** Wait for every write in flight. */
  async flush(): Promise<void> {
    await Promise.all(this.#state.writes)
  }

  /** In-flight lookups cannot repopulate a cache the caller just cleared. */
  async clear(): Promise<void> {
    if (this.#state.closed) throw new Error('the heightfield archive is closed')
    this.#state.epoch++
    await this.flush()
    await this.#state.store.clear()
  }

  /**
   * Finish the writes in flight, then release the store. After this a
   * wrapper passes straight through to its source: a write landing after the
   * close would reopen a handle nothing is waiting on.
   */
  async close(): Promise<void> {
    if (this.#state.closed) return
    this.#state.closed = true
    this.#state.epoch++
    await this.flush()
    this.#state.store.close?.()
  }
}

/** A storage failure costs generation, never a missing tile or a changed world. */
class ArchivedHeightfieldSource implements HeightfieldSource {
  readonly #source: ArchivedSource
  readonly #state: ArchiveState
  #nextId = 1
  constructor(source: ArchivedSource, state: ArchiveState) {
    this.#source = source
    this.#state = state
  }
  get kind(): string {
    return this.#source.kind
  }
  get available(): boolean {
    return this.#source.available
  }
  get maxLevel(): number | undefined {
    return this.#source.maxLevel
  }
  supports(request: HeightfieldRequest): boolean {
    return this.#source.supports?.(request) ?? true
  }
  submit(
    surface: SurfaceParameters,
    request: HeightfieldRequest,
    lane?: JobLane,
  ): JobHandle<HeightfieldResponse> {
    const state = this.#state
    if (state.closed) return this.#source.submit(surface, request, lane)
    const counts = state.counts
    const store = state.store
    const id = this.#nextId++
    const key = heightfieldCacheKey(surface, request, this.#source.archive)
    const epoch = state.epoch
    let active: JobHandle<HeightfieldResponse> | null = null
    let settled = false
    let canceled = false
    let reject!: (cause: unknown) => void
    const result = new Promise<HeightfieldResponse>((resolve, fail) => {
      reject = fail
      void (async () => {
        let value: unknown = null
        try {
          value = await store.read(key)
        } catch {
          counts.readErrors++
        }
        if (canceled) return
        const record = validateHeightfieldCacheRecord(value, key, request)
        if (record !== null) {
          counts.hits++
          settled = true
          resolve(record.field)
          return
        }
        if (value !== null && value !== undefined) {
          counts.invalid++
          // A lookup that outlives `close` leaves the row to the next run:
          // removing it would reopen the store.
          if (!state.closed) {
            try {
              await store.remove(key)
            } catch {
              counts.writeErrors++
            }
          }
          if (canceled) return
        }
        counts.misses++
        active = this.#source.submit(surface, request, lane)
        const field = await active.result
        if (canceled) return
        if (epoch === state.epoch) {
          const row = heightfieldCacheRecord(key, field)
          if (validateHeightfieldCacheRecord(row, key, request) !== null) {
            const write = Promise.resolve()
              .then(() => store.write(row))
              .then(
                (stored) => {
                  if (stored !== false) counts.writes++
                },
                () => {
                  counts.writeErrors++
                },
              )
            state.writes.add(write)
            void write.then(() => state.writes.delete(write))
          }
        }
        settled = true
        resolve(field)
      })().catch((cause: unknown) => {
        if (!canceled) {
          settled = true
          fail(cause)
        }
      })
    })
    return {
      id,
      result,
      cancel: () => {
        if (settled || canceled) return
        canceled = true
        counts.canceled++
        reject(new Error('canceled'))
        active?.cancel()
      },
    }
  }
}
