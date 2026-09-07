import { invariant, PARSEC } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import type {
  GalaxyField,
  ResolvedPopulationSelection,
} from '@inertialref/universe'

/** A ceiling on reuse, in parsecs, including the observer's local dust. */
export const GALAXY_CACHE_RADIUS_PARSECS = 0.15
export const GALAXY_CACHE_FACE_SIZE = 128
export const GALAXY_CACHE_TILE_SIZE = 16
/** Two completed locations and one incomplete replacement, all owned by one renderer. */
export const GALAXY_CACHE_SLOTS = 3

export interface GalaxyCacheOptions {
  readonly faceSize?: number
  readonly tileSize?: number
  /** Publish this complete lower-resolution cube before refining the final tier. */
  readonly initialFaceSize?: number
  readonly refinements?: readonly number[]
  readonly tilesPerSubmission?: number
}

export interface GalaxyCacheEntry {
  readonly slot: number
  readonly faceSize: number
  readonly generation: number
  readonly position: UniverseVector
  readonly field: GalaxyField
  readonly radiusParsecs: number
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
  readonly initialFaceSize: number
  readonly totalTiles: number
  readonly tiers: readonly number[]
  #generation = 0
  #completed: GalaxyCacheEntry[] = []
  #pending: GalaxyCacheEntry | null = null
  #selected: GalaxyCacheEntry | null = null
  #field: GalaxyField | null = null
  #resolved: ResolvedPopulationSelection | undefined
  #tile = 0
  #tiles = 0
  #published = 0
  #cancellations = 0
  #disposed = false

  constructor(options: GalaxyCacheOptions = {}) {
    this.faceSize = options.faceSize ?? GALAXY_CACHE_FACE_SIZE
    this.tileSize = options.tileSize ?? GALAXY_CACHE_TILE_SIZE
    this.initialFaceSize = options.initialFaceSize ?? this.faceSize
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
    invariant(
      Number.isInteger(Math.log2(this.initialFaceSize)) &&
        this.initialFaceSize >= 16 &&
        this.initialFaceSize <= this.faceSize,
      'The initial sky cube must be a power of two within the final tier',
    )
    this.tiers = [
      ...new Set([
        this.initialFaceSize,
        ...(options.refinements ?? []),
        this.faceSize,
      ]),
    ].sort((a, b) => a - b)
    invariant(
      this.tiers.every(
        (size) =>
          Number.isInteger(Math.log2(size)) &&
          size >= this.initialFaceSize &&
          size <= this.faceSize,
      ),
      'Sky refinement tiers must be powers of two within the initial and final tiers',
    )
    this.totalTiles = this.tiers.reduce(
      (total, size) => total + this.#tileCount(size),
      0,
    )
  }

  configure(
    position: UniverseVector | null,
    field: GalaxyField,
    resolved?: ResolvedPopulationSelection,
  ): void {
    if (this.#disposed) return
    if (field !== this.#field || resolved !== this.#resolved) {
      this.#cancel()
      this.#completed = []
      this.#selected = null
      this.#field = field
      this.#resolved = resolved
    }
    if (position === null) {
      this.#cancel()
      this.#selected = null
      return
    }
    const valid = (entry: GalaxyCacheEntry) =>
      UV.distance(position, entry.position) <= entry.radiusParsecs * PARSEC
    let selected: GalaxyCacheEntry | null = null
    for (const entry of this.#completed)
      if (
        valid(entry) &&
        (selected === null || entry.faceSize > selected.faceSize)
      )
        selected = entry
    this.#selected = selected
    if (selected !== null) {
      if (selected.faceSize === this.faceSize) this.#cancel()
      if (this.#completed.at(-1) !== selected)
        this.#completed = [
          ...this.#completed.filter((entry) => entry !== selected),
          selected,
        ]
      if (selected.faceSize === this.faceSize) return
    }
    if (this.#pending !== null && valid(this.#pending)) return
    this.#cancel()
    this.#begin(
      selected?.position ?? position,
      field,
      selected === null
        ? this.initialFaceSize
        : this.#nextTier(selected.faceSize),
    )
  }

  #nextTier(faceSize: number): number {
    return this.tiers.find((size) => size > faceSize) ?? this.faceSize
  }

  #tileCount(faceSize: number): number {
    return 6 * Math.ceil(faceSize / this.tileSize) ** 2
  }

  #begin(position: UniverseVector, field: GalaxyField, faceSize: number): void {
    const occupied = new Set(this.#completed.map((entry) => entry.slot))
    let slot = 0
    while (occupied.has(slot)) slot++
    this.#pending = {
      slot,
      faceSize,
      generation: ++this.#generation,
      position: { ...position },
      field,
      radiusParsecs: GALAXY_CACHE_RADIUS_PARSECS,
    }
    this.#tile = 0
  }

  get selected(): GalaxyCacheEntry | null {
    return this.#selected
  }

  get report() {
    return {
      faceSize: this.faceSize,
      selectedFaceSize: this.#selected?.faceSize ?? null,
      initialFaceSize: this.initialFaceSize,
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
    const faceSize = this.#pending.faceSize
    const across = Math.ceil(faceSize / this.tileSize)
    const inFace = this.#tile % (across * across)
    const x = (inFace % across) * this.tileSize
    const y = Math.floor(inFace / across) * this.tileSize
    return {
      ...this.#pending,
      ordinal: this.#tile,
      face: Math.floor(this.#tile / (across * across)),
      x,
      y,
      width: Math.min(this.tileSize, faceSize - x),
      height: Math.min(this.tileSize, faceSize - y),
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
    if (this.#tile === this.#tileCount(this.#pending.faceSize)) {
      const published = this.#pending
      this.#selected = published
      this.#completed = this.#completed.filter(
        (entry) =>
          UV.distance(entry.position, published.position) >
          GALAXY_CACHE_RADIUS_PARSECS * PARSEC,
      )
      this.#completed.push(published)
      this.#completed = this.#completed.slice(-(GALAXY_CACHE_SLOTS - 1))
      this.#pending = null
      this.#published++
      if (published.faceSize < this.faceSize)
        this.#begin(
          published.position,
          published.field,
          this.#nextTier(published.faceSize),
        )
    }
    return true
  }

  /** The caller uploads all faces before publication; an old request cannot take a reused slot. */
  restore(
    request: GalaxyCacheEntry,
    position: UniverseVector,
    faceSize: number,
    radiusParsecs = GALAXY_CACHE_RADIUS_PARSECS,
  ): boolean {
    if (
      this.#disposed ||
      this.#pending?.generation !== request.generation ||
      faceSize !== this.faceSize ||
      !Number.isFinite(radiusParsecs) ||
      radiusParsecs < 0 ||
      radiusParsecs > GALAXY_CACHE_RADIUS_PARSECS ||
      UV.distance(position, request.position) > radiusParsecs * PARSEC
    )
      return false
    const entry = {
      ...request,
      position: { ...position },
      faceSize,
      radiusParsecs,
      generation: ++this.#generation,
    }
    this.#pending = null
    this.#tile = 0
    this.#completed = this.#completed.filter(
      (held) =>
        held.slot !== entry.slot &&
        UV.distance(held.position, entry.position) >
          GALAXY_CACHE_RADIUS_PARSECS * PARSEC,
    )
    this.#completed.push(entry)
    this.#completed = this.#completed.slice(-(GALAXY_CACHE_SLOTS - 1))
    this.#selected = entry
    this.#published++
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
