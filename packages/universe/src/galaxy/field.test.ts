import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { GENERATION_VERSIONS } from '../system.ts'
import { createGalaxyField, GALAXY_FIELD_VERSIONS } from './field.ts'
import { integrateGalaxyCount } from './integral.ts'

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
describe('the preview stellar field', () => {
  it('normalizes the total solar density without activating a generator', () => {
    expect(field.sample(SUN_POSITION).totalPerCubicParsec).toBeCloseTo(0.1, 14)
    expect(GALAXY_FIELD_VERSIONS).toEqual({ 'galaxy-field': 1 })
    expect(GENERATION_VERSIONS).not.toHaveProperty('galaxy-field')
  })
  it('has finite nonnegative populations at every sampled position', () => {
    fc.assert(
      fc.property(position, (p) => {
        const s = field.sample(p)
        for (const value of Object.values(s.populations)) {
          expect(Number.isFinite(value)).toBe(true)
          expect(value).toBeGreaterThanOrEqual(0)
        }
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
  it('integrates to the reference count and converges with a finer quadrature', () => {
    const coarse = integrateGalaxyCount(field, {
      radialSteps: 120,
      azimuthSteps: 96,
    })
    const fine = integrateGalaxyCount(field, {
      radialSteps: 240,
      azimuthSteps: 192,
    })
    expect(fine.totalStars).toBeGreaterThan(1e11)
    expect(fine.totalStars).toBeLessThan(4e11)
    expect(Math.abs(coarse.totalStars / fine.totalStars - 1)).toBeLessThan(0.01)
  })
})
