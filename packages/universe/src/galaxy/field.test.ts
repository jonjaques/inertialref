import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { deriveSeed, noise3, rootSeed } from '@inertialref/procedural'
import { UV } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { GENERATION_VERSIONS } from '../system.ts'
import {
  createGalaxyField,
  GALAXY_FIELD_VERSIONS,
  GALAXY_YOUNG_HEIGHT,
  galaxyYoungHeight,
  galaxyWarp,
} from './field.ts'
import { GALAXY_ARMS, armRadius } from './arms.ts'

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
  it('shares the measured stellar height anchors and preserves the flared column', () => {
    expect(galaxyYoungHeight(0)).toBe(50)
    expect(galaxyYoungHeight(4500)).toBe(67)
    expect(galaxyYoungHeight(8178)).toBeCloseTo(90, 12)
    expect(Object.isFrozen(GALAXY_YOUNG_HEIGHT)).toBe(true)
    const textureSeed = deriveSeed(field.seed, 'galaxy-field:young-arms')
    fc.assert(
      fc.property(fc.double({ min: -1, max: 1, noNaN: true }), (beta) => {
        const radius = armRadius(GALAXY_ARMS[3]!, beta)
        const x = -radius * Math.cos(beta),
          z = -radius * Math.sin(beta)
        const y = galaxyWarp(radius, beta),
          h = galaxyYoungHeight(radius)
        const sample = field.sample(
          UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC),
        )
        const radialDensity =
          field.normalization *
          0.003 *
          Math.exp((8178 - radius) / 2600) *
          sample.armStrength
        const texture = 1 + 0.2 * noise3(textureSeed, x / 350, y / 350, z / 350)
        // Integral sech²(z/H) dz = 2H. The whole stellar column is 100 pc
        // times its radial density regardless of the local flared height.
        expect(
          ((sample.populations.youngArms / texture) * 2 * h) / radialDensity,
        ).toBeCloseTo(100, 9)
      }),
      { numRuns: 30 },
    )
  })
  it('gives the optically young population its shared stellar height rather than the maser tracer height', () => {
    const textureSeed = deriveSeed(field.seed, 'galaxy-field:young-arms')
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0.5, max: 3, noNaN: true }),
        (beta, heightMultiple) => {
          const radius = armRadius(GALAXY_ARMS[3]!, beta)
          const warp = galaxyWarp(radius, beta)
          const height =
            50 +
            17 * (radius / 4500) ** (Math.log(40 / 17) / Math.log(8178 / 4500))
          const x = -radius * Math.cos(beta),
            z = -radius * Math.sin(beta)
          const smoothDensity = (y: number) =>
            field.sample(UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC))
              .populations.youngArms /
            (1 + 0.2 * noise3(textureSeed, x / 350, y / 350, z / 350))
          expect(
            smoothDensity(warp + height * heightMultiple) / smoothDensity(warp),
          ).toBeCloseTo(1 / Math.cosh(heightMultiple) ** 2, 10)
        },
      ),
      { numRuns: 30 },
    )
  })
  it('normalizes the total solar density and versions the active population field', () => {
    expect(field.sample(SUN_POSITION).totalPerCubicParsec).toBeCloseTo(0.1, 14)
    expect(GALAXY_FIELD_VERSIONS).toEqual({ 'galaxy-field': 5 })
    expect(GENERATION_VERSIONS['galaxy-field']).toBe(5)
    expect(GENERATION_VERSIONS['galaxy']).toBe(5)
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
