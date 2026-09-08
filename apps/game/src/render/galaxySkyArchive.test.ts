import { describe, expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV } from '@inertialref/spatial'
import { createGalaxyField, SUN_POSITION } from '@inertialref/universe'
import {
  GALAXY_SKY_ARCHIVE_VERSION,
  galaxySkyArchiveKey,
  galaxySkyQuery,
  validateGalaxySkyArchive,
  type GalaxySkyArchiveRecord,
} from './galaxySkyArchive.ts'

const field = createGalaxyField(rootSeed('archive'))
const resolved = {
  origin: SUN_POSITION,
  apparentMagnitudeLimit: 8,
  levelMask: 511,
}
const query = galaxySkyQuery(field, SUN_POSITION, 16, 'galaxy-tsl@6', resolved)

function record(): GalaxySkyArchiveRecord {
  return {
    ...query,
    version: GALAXY_SKY_ARCHIVE_VERSION,
    faces: Array.from({ length: 6 }, () => {
      const face = new Uint16Array(16 * 16 * 4)
      for (let i = 0; i < face.length; i += 4) {
        face[i] = 0x3800
        face[i + 1] = 0x3400
        face[i + 2] = 0x3000
        face[i + 3] = 0x3c00
      }
      return face
    }),
  }
}

describe('physical sky archive', () => {
  it('accepts a structured clone without requiring the same field instance', () => {
    const copied = structuredClone(record())
    const recreated = galaxySkyQuery(
      createGalaxyField(rootSeed('archive')),
      SUN_POSITION,
      16,
      'galaxy-tsl@6',
      structuredClone(resolved),
    )
    expect(validateGalaxySkyArchive(copied, recreated)).toBe(copied)
    expect(galaxySkyArchiveKey(recreated)).toBe(galaxySkyArchiveKey(query))
  })

  it('checks actual observer distance independently of the region key', () => {
    const near = {
      ...query,
      origin: UV.translate(query.origin, { x: 0.149 * PARSEC, y: 0, z: 0 }),
    }
    const far = {
      ...query,
      origin: UV.translate(query.origin, { x: 0.151 * PARSEC, y: 0, z: 0 }),
    }
    const archived = record()
    expect(validateGalaxySkyArchive(archived, near)).toBe(archived)
    expect(validateGalaxySkyArchive(archived, far)).toBeNull()
  })

  it('rejects changed physics, quality, backend, and resolved ownership', () => {
    const archived = record()
    const alternatives = [
      { ...query, kernelVersion: 'galaxy-tsl@7' },
      { ...query, faceSize: 32 },
      { ...query, backend: 'webgl' },
      { ...query, field: { ...query.field, seed: '1'.repeat(32) } },
      {
        ...query,
        field: {
          ...query.field,
          versions: {
            'galaxy-field': query.field.versions['galaxy-field']! + 1,
          },
        },
      },
      { ...query, field: { ...query.field, normalization: 0.2 } },
      { ...query, field: { ...query.field, dustScale: 0 } },
      { ...query, field: { ...query.field, dustNormalization: 0 } },
      { ...query, resolved: undefined },
      { ...query, resolved: { ...resolved, apparentMagnitudeLimit: 7 } },
      { ...query, resolved: { ...resolved, levelMask: 31 } },
      {
        ...query,
        resolved: {
          ...resolved,
          origin: UV.translate(resolved.origin, { x: PARSEC, y: 0, z: 0 }),
        },
      },
    ]
    for (const alternative of alternatives)
      expect(validateGalaxySkyArchive(archived, alternative)).toBeNull()
  })

  it('rejects corrupt records and nonphysical half-float pixels', () => {
    const archived = record()
    const malformed: unknown[] = [
      null,
      {},
      { ...archived, version: 0 },
      { ...archived, origin: { ...query.origin, ox: NaN } },
      { ...archived, origin: { ...query.origin, ox: '0' } },
      { ...archived, faceSize: 2048 },
      { ...archived, faces: archived.faces.slice(0, 5) },
      { ...archived, faces: [...archived.faces, archived.faces[0]] },
      {
        ...archived,
        faces: archived.faces.map((face) => new Float32Array(face)),
      },
      { ...archived, faces: archived.faces.map((face) => face.subarray(1)) },
    ]
    for (const value of malformed)
      expect(validateGalaxySkyArchive(value, query)).toBeNull()
    for (const bits of [0x7c00, 0x7e00, 0xbc00]) {
      const invalid = record()
      invalid.faces[5]![invalid.faces[5]!.length - 2] = bits
      expect(validateGalaxySkyArchive(invalid, query)).toBeNull()
    }
    const invalidAlpha = record()
    invalidAlpha.faces[0]![3] = 0
    expect(validateGalaxySkyArchive(invalidAlpha, query)).toBeNull()
  })

  it('owns metadata snapshots while allowing a zero-level selection', () => {
    const origin = { ...SUN_POSITION }
    const selected = { ...resolved, origin, levelMask: 0 }
    const snapshot = galaxySkyQuery(field, origin, 16, 'galaxy-tsl@6', selected)
    origin.ox += 1
    selected.apparentMagnitudeLimit = 6
    expect(UV.equals(snapshot.origin, SUN_POSITION)).toBe(true)
    expect(UV.equals(snapshot.resolved!.origin, SUN_POSITION)).toBe(true)
    expect(snapshot.resolved!.apparentMagnitudeLimit).toBe(8)
    expect(
      validateGalaxySkyArchive({ ...record(), ...snapshot }, snapshot),
    ).not.toBeNull()
  })
})

it('spends one displacement budget on the eye and its resolved envelope together', () => {
  const archived = record()
  const shifted = {
    ...query,
    origin: UV.translate(query.origin, { x: 0.07 * PARSEC, y: 0, z: 0 }),
    resolved: {
      ...resolved,
      origin: UV.translate(resolved.origin, { x: 0, y: 0.07 * PARSEC, z: 0 }),
    },
  }
  expect(validateGalaxySkyArchive(archived, shifted) === archived).toBe(true)
  expect(
    validateGalaxySkyArchive(archived, {
      ...shifted,
      resolved: {
        ...shifted.resolved,
        origin: UV.translate(resolved.origin, { x: 0, y: 0.09 * PARSEC, z: 0 }),
      },
    }),
  ).toBeNull()
})
