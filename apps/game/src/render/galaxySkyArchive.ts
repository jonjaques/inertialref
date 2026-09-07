import { invariant, PARSEC } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  LUMINOSITY_BANDS,
  type GalaxyField,
  type ResolvedPopulationSelection,
} from '@inertialref/universe'
import { GALAXY_CACHE_RADIUS_PARSECS } from './galaxyCache.ts'

export const GALAXY_SKY_ARCHIVE_VERSION = 1
export const GALAXY_SKY_ARCHIVE_ENTRIES = 2
/** Integer sectors keep the regional key stable at galactic distances. */
const REGION_SECTORS = 8192

export interface GalaxySkyFieldFingerprint {
  readonly seed: string
  readonly versions: Readonly<Record<string, number>>
  readonly normalization: number
  readonly dustScale: number
  readonly dustNormalization: number
}

export interface GalaxySkyQuery {
  readonly backend: 'webgpu'
  readonly field: GalaxySkyFieldFingerprint
  readonly kernelVersion: string
  readonly faceSize: number
  readonly origin: UniverseVector
  readonly resolved?: ResolvedPopulationSelection
}

export interface GalaxySkyArchiveRecord extends GalaxySkyQuery {
  readonly version: typeof GALAXY_SKY_ARCHIVE_VERSION
  /** Native WebGPU cube order, RGBA half-float bits. RGB is linear nW m⁻² sr⁻¹ / 1000; alpha is one. */
  readonly faces: readonly Uint16Array[]
}

/** A regenerable cache, independent of saves and of the renderer's lifetime. */
export interface GalaxySkyStore {
  read(query: GalaxySkyQuery): Promise<GalaxySkyArchiveRecord | null>
  write(record: GalaxySkyArchiveRecord): Promise<void>
}

/** Snapshot metadata before asynchronous export, readback, or storage begins. */
export function galaxySkyQuery(
  field: GalaxyField,
  origin: UniverseVector,
  faceSize: number,
  kernelVersion: string,
  resolved?: ResolvedPopulationSelection,
): GalaxySkyQuery {
  const query: GalaxySkyQuery = {
    backend: 'webgpu',
    field: {
      seed: formatSeed(field.seed),
      versions: { ...field.versions },
      normalization: field.normalization,
      dustScale: field.dustScale,
      dustNormalization: field.dustNormalization,
    },
    kernelVersion,
    faceSize,
    origin: { ...origin },
    ...(resolved === undefined
      ? {}
      : { resolved: { ...resolved, origin: { ...resolved.origin } } }),
  }
  invariant(isQuery(query), 'Invalid physical sky archive query')
  return query
}

function fieldKey(field: GalaxySkyFieldFingerprint): string {
  return JSON.stringify([
    field.seed,
    Object.entries(field.versions).sort(([a], [b]) => a.localeCompare(b)),
    field.normalization,
    field.dustScale,
    field.dustNormalization,
  ])
}

/** The actual origin and selection still require validation after a key hit. */
export function galaxySkyArchiveKey(query: GalaxySkyQuery): string {
  return JSON.stringify([
    GALAXY_SKY_ARCHIVE_VERSION,
    query.backend,
    fieldKey(query.field),
    query.kernelVersion,
    query.faceSize,
    Math.floor(query.origin.sx / REGION_SECTORS),
    Math.floor(query.origin.sy / REGION_SECTORS),
    Math.floor(query.origin.sz / REGION_SECTORS),
  ])
}

/**
 * Disk data is untrusted. A cache miss costs a bake; accepting another field,
 * source partition, or incomplete cube changes the physical sky.
 */
export function validateGalaxySkyArchive(
  value: unknown,
  query: unknown,
): GalaxySkyArchiveRecord | null {
  if (
    !isQuery(query) ||
    !isQuery(value) ||
    !object(value) ||
    value.version !== GALAXY_SKY_ARCHIVE_VERSION ||
    value.backend !== query.backend ||
    value.kernelVersion !== query.kernelVersion ||
    value.faceSize !== query.faceSize ||
    fieldKey(value.field) !== fieldKey(query.field) ||
    UV.distance(value.origin, query.origin) >
      galaxySkyReuseRadius(value, query) * PARSEC ||
    !Array.isArray(value.faces) ||
    value.faces.length !== 6
  )
    return null
  const length = value.faceSize * value.faceSize * 4
  for (const face of value.faces) {
    if (!(face instanceof Uint16Array) || face.length !== length) return null
    for (let i = 0; i < length; i += 4) {
      if (face[i + 3] !== 0x3c00) return null
      for (let channel = 0; channel < 3; channel++) {
        const bits = face[i + channel]!
        // Reject infinities, NaNs, and negative radiance. Signed zero is valid.
        if (
          (bits & 0x7c00) === 0x7c00 ||
          ((bits & 0x8000) !== 0 && (bits & 0x7fff) !== 0)
        )
          return null
      }
    }
  }
  return value as unknown as GalaxySkyArchiveRecord
}

/** The source envelope and future eye motion spend one physical reuse budget. */
export function galaxySkyReuseRadius(
  record: GalaxySkyQuery,
  query: GalaxySkyQuery,
): number {
  const a = record.resolved,
    b = query.resolved
  if (a === undefined || b === undefined)
    return a === b ? GALAXY_CACHE_RADIUS_PARSECS : -Infinity
  if (
    a.apparentMagnitudeLimit !== b.apparentMagnitudeLimit ||
    a.levelMask !== b.levelMask
  )
    return -Infinity
  return GALAXY_CACHE_RADIUS_PARSECS - UV.distance(a.origin, b.origin) / PARSEC
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPosition(value: unknown): value is UniverseVector {
  return (
    object(value) &&
    ['sx', 'sy', 'sz', 'ox', 'oy', 'oz'].every(
      (key) => typeof value[key] === 'number',
    ) &&
    UV.isValid(value as unknown as UniverseVector)
  )
}

function isQuery(value: unknown): value is GalaxySkyQuery {
  if (
    !object(value) ||
    value.backend !== 'webgpu' ||
    typeof value.kernelVersion !== 'string' ||
    value.kernelVersion.length === 0 ||
    value.kernelVersion.length > 128 ||
    typeof value.faceSize !== 'number' ||
    value.faceSize < 16 ||
    value.faceSize > 1024 ||
    !Number.isInteger(Math.log2(value.faceSize)) ||
    !isPosition(value.origin) ||
    !object(value.field)
  )
    return false
  const field = value.field
  if (
    typeof field.seed !== 'string' ||
    !/^[0-9a-f]{32}$/.test(field.seed) ||
    !object(field.versions) ||
    Object.keys(field.versions).length === 0 ||
    Object.entries(field.versions).some(
      ([name, version]) =>
        name.length === 0 ||
        typeof version !== 'number' ||
        !Number.isSafeInteger(version) ||
        version < 1,
    ) ||
    ![field.normalization, field.dustScale, field.dustNormalization].every(
      (number) =>
        typeof number === 'number' && Number.isFinite(number) && number >= 0,
    )
  )
    return false
  const resolved = value.resolved
  return (
    resolved === undefined ||
    (object(resolved) &&
      isPosition(resolved.origin) &&
      typeof resolved.apparentMagnitudeLimit === 'number' &&
      !Number.isNaN(resolved.apparentMagnitudeLimit) &&
      typeof resolved.levelMask === 'number' &&
      Number.isInteger(resolved.levelMask) &&
      resolved.levelMask >= 0 &&
      resolved.levelMask < 2 ** LUMINOSITY_BANDS.length)
  )
}
