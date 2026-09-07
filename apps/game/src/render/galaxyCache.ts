import { invariant, PARSEC } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import type { GalaxyField } from '@inertialref/universe'

/** A ceiling on reuse, in parsecs, including the observer's local dust. */
export const GALAXY_CACHE_RADIUS_PARSECS = 0.15
export const GALAXY_CACHE_FACE_SIZE = 128
export const GALAXY_CACHE_TILE_SIZE = 16
/** Two completed locations and one incomplete replacement, all owned by one renderer. */
export const GALAXY_CACHE_SLOTS = 3

export interface GalaxyCacheOptions {
  readonly faceSize?: number
  readonly tileSize?: number
}

export interface GalaxyCacheEntry {
  readonly slot: number
  readonly generation: number
  readonly position: UniverseVector
  readonly field: GalaxyField
}

export interface GalaxyCacheTile extends GalaxyCacheEntry {
  readonly ordinal: number
  readonly face: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Publication and cancellation are independent of GPU completion. The queue
 * orders a submitted tile before a later sample, but only all six faces may
 * become visible. A generation prevents canceled work from publishing a slot
 * that already belongs to another location or field.
 */
export class GalaxyCacheSchedule {
  readonly faceSize: number
  readonly tileSize: number
  readonly totalTiles: number
  #generation = 0
  #completed: GalaxyCacheEntry[] = []
  #pending: GalaxyCacheEntry | null = null
  #selected: GalaxyCacheEntry | null = null
  #field: GalaxyField | null = null
  #tile = 0
  #tiles = 0
  #published = 0
  #cancellations = 0
  #disposed = false

  constructor(options: GalaxyCacheOptions = {}) {
    this.faceSize = options.faceSize ?? GALAXY_CACHE_FACE_SIZE
    this.tileSize = options.tileSize ?? GALAXY_CACHE_TILE_SIZE
    invariant(
      Number.isInteger(this.faceSize) &&
        this.faceSize >= 16 &&
        this.faceSize <= 1024 &&
        Number.isInteger(Math.log2(this.faceSize)),
      'Galaxy cube faces must be powers of two from 16 through 1024',
    )
    invariant(
      Number.isInteger(this.tileSize) &&
        this.tileSize >= 8 &&
        this.tileSize <= 64 &&
        Number.isInteger(Math.log2(this.tileSize)),
      'Galaxy cache tiles must be powers of two from 8 through 64',
    )
    this.totalTiles = 6 * Math.ceil(this.faceSize / this.tileSize) ** 2
  }

  configure(position: UniverseVector | null, field: GalaxyField): void {
    if (this.#disposed) return
    if (field !== this.#field) {
      this.#cancel()
      this.#completed = []
      this.#selected = null
      this.#field = field
    }
    if (position === null) {
      this.#cancel()
      this.#selected = null
      return
    }
    const valid = (entry: GalaxyCacheEntry) =>
      UV.distance(position, entry.position) <=
      GALAXY_CACHE_RADIUS_PARSECS * PARSEC
    const selected = this.#completed.find(valid) ?? null
    this.#selected = selected
    if (selected !== null) {
      this.#cancel()
      if (this.#completed.at(-1) !== selected)
        this.#completed = [
          ...this.#completed.filter((entry) => entry !== selected),
          selected,
        ]
      return
    }
    if (this.#pending !== null && valid(this.#pending)) return
    this.#cancel()
    const occupied = new Set(this.#completed.map((entry) => entry.slot))
    let slot = 0
    while (occupied.has(slot)) slot++
    this.#pending = {
      slot,
      generation: ++this.#generation,
      position: { ...position },
      field,
    }
    this.#tile = 0
  }

  get selected(): GalaxyCacheEntry | null {
    return this.#selected
  }

  get report() {
    return {
      faceSize: this.faceSize,
      tileSize: this.tileSize,
      totalTiles: this.totalTiles,
      completedTiles: this.#pending === null ? 0 : this.#tile,
      tiles: this.#tiles,
      published: this.#published,
      cancellations: this.#cancellations,
      pending: this.#pending !== null,
      ready: this.#selected !== null,
      retained: this.#completed.length,
    }
  }

  next(): GalaxyCacheTile | null {
    if (this.#pending === null || this.#disposed) return null
    const across = Math.ceil(this.faceSize / this.tileSize)
    const inFace = this.#tile % (across * across)
    const x = (inFace % across) * this.tileSize
    const y = Math.floor(inFace / across) * this.tileSize
    return {
      ...this.#pending,
      ordinal: this.#tile,
      face: Math.floor(this.#tile / (across * across)),
      x,
      y,
      width: Math.min(this.tileSize, this.faceSize - x),
      height: Math.min(this.tileSize, this.faceSize - y),
    }
  }

  complete(tile: GalaxyCacheTile): boolean {
    if (
      this.#disposed ||
      this.#pending === null ||
      tile.generation !== this.#pending.generation ||
      tile.ordinal !== this.#tile
    )
      return false
    this.#tiles++
    this.#tile++
    if (this.#tile === this.totalTiles) {
      this.#selected = this.#pending
      this.#completed.push(this.#pending)
      this.#completed = this.#completed.slice(-(GALAXY_CACHE_SLOTS - 1))
      this.#pending = null
      this.#published++
    }
    return true
  }

  #cancel(): void {
    if (this.#pending !== null) this.#cancellations++
    this.#pending = null
    this.#tile = 0
  }

  dispose(): void {
    this.#cancel()
    this.#completed = []
    this.#selected = null
    this.#disposed = true
  }
}
