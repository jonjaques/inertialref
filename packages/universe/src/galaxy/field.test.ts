import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { GENERATION_VERSIONS } from '../system.ts'
import { createGalaxyField, GALAXY_FIELD_VERSIONS } from './field.ts'

const field = createGalaxyField(rootSeed('inertialref'))
const position = fc
  .tuple(
    ...Array.from({ length: 3 }, () =>
      fc.double({ min: -50000, max: 50000, noNaN: true }),
    ),
  )
  .map(([x = 0, y = 0, z = 0]) =>
    UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC),
  )
describe('the stellar field', () => {
  it('normalizes the total solar density and versions the active population field', () => {
    expect(field.sample(SUN_POSITION).totalPerCubicParsec).toBeCloseTo(0.1, 14)
    expect(GALAXY_FIELD_VERSIONS).toEqual({ 'galaxy-field': 4 })
    expect(GENERATION_VERSIONS['galaxy-field']).toBe(4)
    expect(GENERATION_VERSIONS['galaxy']).toBe(4)
  })
  it('has finite nonnegative populations at every sampled position', () => {
    fc.assert(
      fc.property(position, (p) => {
        const s = field.sample(p)
        for (const value of Object.values(s.populations)) {
          expect(Number.isFinite(value)).toBe(true)
          expect(value).toBeGreaterThanOrEqual(0)
        }
        for (const value of [
          s.emissionSolarPerCubicParsec,
          ...Object.values(s.emissionRgb),
        ]) {
          expect(Number.isFinite(value)).toBe(true)
          expect(value).toBeGreaterThanOrEqual(0)
        }
        expect(s.emissionRgb.g).toBeCloseTo(s.emissionSolarPerCubicParsec, 12)
        expect(s.totalPerCubicParsec).toBe(
          Object.values(s.populations).reduce((a, b) => a + b, 0),
        )
      }),
    )
  })
  it('is repeatable in any order and carries its seed without sharing a stream', () => {
    fc.assert(
      fc.property(fc.array(position, { maxLength: 15 }), (points) => {
        const expected = points.map((p) => field.sample(p))
        expect(
          [...points]
            .reverse()
            .map((p) => field.sample(p))
            .reverse(),
        ).toEqual(expected)
        expect(
          points.map((p) =>
            createGalaxyField(rootSeed('inertialref')).sample(p),
          ),
        ).toEqual(expected)
      }),
      { numRuns: 25 },
    )
    const p = UV.fromMeters(-7000 * PARSEC, 0, 3000 * PARSEC)
    expect(createGalaxyField(rootSeed('another')).sample(p)).not.toEqual(
      field.sample(p),
    )
  })
})
