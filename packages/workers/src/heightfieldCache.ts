import {
  COVER_CHANNELS,
  HEIGHTFIELD_BORDER,
  TERRAIN_ALGORITHM,
  type HeightfieldRequest,
  type SurfaceParameters,
} from '@inertialref/universe'
import type { JobHandle } from './pool.ts'
import {
  encodeSurface,
  generateHeightfieldTask,
  type HeightfieldResponse,
  type HeightfieldSource,
} from './tasks.ts'

/** Bump when drawn-field arithmetic changes without a canonical terrain bump. */
export const HEIGHTFIELD_CACHE_REVISION = 1
export const HEIGHTFIELD_CACHE_VERSION = `${HEIGHTFIELD_CACHE_REVISION}:${TERRAIN_ALGORITHM.version}:${generateHeightfieldTask.version}`

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
  write(record: HeightfieldCacheRecord): Promise<void>
  remove(key: string): Promise<void>
  clear(): Promise<void>
  stats(): Promise<HeightfieldStoreStats>
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(',')}}`
}

/** Every field travels into the key; adding a surface/request member cannot silently omit it. */
export function heightfieldCacheKey(
  surface: SurfaceParameters,
  request: HeightfieldRequest,
  producer: string,
  version = HEIGHTFIELD_CACHE_VERSION,
): string {
  return stable({ version, producer, surface: encodeSurface(surface), request })
}

function checksum(field: HeightfieldResponse): number {
  let hash = 2166136261
  for (const array of [field.elevations, field.cover, field.water]) {
    const bytes = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength,
    )
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619)
  }
  return hash >>> 0
}
export function heightfieldCacheRecord(
  key: string,
  field: HeightfieldResponse,
): HeightfieldCacheRecord {
  return {
    key,
    field,
    checksum: checksum(field),
    bytes:
      field.elevations.byteLength +
      field.cover.byteLength +
      field.water.byteLength +
      key.length * 2 +
      128,
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
  const expected = heightfieldCacheRecord(key, field)
  return row.bytes === expected.bytes ? (row as HeightfieldCacheRecord) : null
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

interface CacheState {
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
  generation: number
}
const states = new WeakMap<HeightfieldStore, CacheState>()
/** A storage failure costs generation, never a missing tile or a changed world. */
export class CachedHeightfieldSource implements HeightfieldSource {
  readonly #source: HeightfieldSource
  readonly #store: HeightfieldStore
  readonly #producer: string
  readonly #state: CacheState
  readonly #writes: Set<Promise<void>>
  readonly #counts: CacheState['counts']
  #nextId = 1
  constructor(
    source: HeightfieldSource,
    store: HeightfieldStore,
    producer: string,
  ) {
    this.#source = source
    this.#store = store
    this.#producer = producer
    let state = states.get(store)
    if (state === undefined) {
      state = {
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
        generation: 0,
      }
      states.set(store, state)
    }
    this.#state = state
    this.#writes = state.writes
    this.#counts = state.counts
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
  stats(): HeightfieldCacheStats {
    return { ...this.#counts, pendingWrites: this.#writes.size }
  }
  async flush(): Promise<void> {
    await Promise.all(this.#writes)
  }
  /** In-flight lookups cannot repopulate a cache the caller just cleared. */
  async clear(): Promise<void> {
    this.#state.generation++
    await this.flush()
    await this.#store.clear()
  }
  submit(
    surface: SurfaceParameters,
    request: HeightfieldRequest,
  ): JobHandle<HeightfieldResponse> {
    const id = this.#nextId++
    const key = heightfieldCacheKey(surface, request, this.#producer)
    const generation = this.#state.generation
    let active: JobHandle<HeightfieldResponse> | null = null
    let settled = false
    let canceled = false
    let reject!: (cause: unknown) => void
    const result = new Promise<HeightfieldResponse>((resolve, fail) => {
      reject = fail
      void (async () => {
        let value: unknown = null
        try {
          value = await this.#store.read(key)
        } catch {
          this.#counts.readErrors++
        }
        if (canceled) return
        const record = validateHeightfieldCacheRecord(value, key, request)
        if (record !== null) {
          this.#counts.hits++
          settled = true
          resolve(record.field)
          return
        }
        if (value !== null && value !== undefined) {
          this.#counts.invalid++
          try {
            await this.#store.remove(key)
          } catch {
            this.#counts.writeErrors++
          }
          if (canceled) return
        }
        this.#counts.misses++
        active = this.#source.submit(surface, request)
        const field = await active.result
        if (canceled) return
        if (generation === this.#state.generation) {
          const row = heightfieldCacheRecord(key, field)
          if (validateHeightfieldCacheRecord(row, key, request) !== null) {
            const write = this.#store.write(row).then(
              () => {
                this.#counts.writes++
              },
              () => {
                this.#counts.writeErrors++
              },
            )
            this.#writes.add(write)
            void write.then(() => this.#writes.delete(write))
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
        this.#counts.canceled++
        reject(new Error('canceled'))
        active?.cancel()
      },
    }
  }
}
