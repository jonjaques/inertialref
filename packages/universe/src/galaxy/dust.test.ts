import fc from 'fast-check'
import { expect, it } from 'vitest'
import { deriveSeed, rootSeed } from '@inertialref/procedural'
import { PARSEC } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import { createGalaxyField } from './field.ts'
import { GALAXY_ARMS, armRadius, armStrength } from './arms.ts'
import { GALAXY_DUST, galaxyDustModulation, galaxyDustProfile } from './dust.ts'

const seed = rootSeed('inertialref')
const field = createGalaxyField(seed)
const coordinate = fc.double({ min: -30000, max: 30000, noNaN: true })
const position = fc
  .tuple(coordinate, coordinate, coordinate)
  .map(([x, y, z]) => UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC))

it('normalizes the untextured solar warped midplane to one V magnitude per kpc', () => {
  const coefficient =
    galaxyDustProfile(8178, 0, 0, 1).density * field.dustNormalization
  const magnitudesPerKpc = (coefficient * 1000 * 2.5) / Math.LN10
  expect(magnitudesPerKpc).toBeCloseTo(1, 14)
  expect(GALAXY_DUST.thinFraction + GALAXY_DUST.thickFraction).toBe(1)
  expect(Object.isFrozen(GALAXY_DUST)).toBe(true)
  expect(Object.isFrozen(GALAXY_DUST.octaves[0])).toBe(true)
})

it('keeps extinction nonnegative and reddens transmitted light at every sampled point', () => {
  fc.assert(
    fc.property(position, (p) => {
      const { extinctionPerParsec: k, dustModulation } = field.sample(p)
      for (const coefficient of Object.values(k)) {
        expect(Number.isFinite(coefficient)).toBe(true)
        expect(coefficient).toBeGreaterThanOrEqual(0)
      }
      expect(k.b).toBeGreaterThanOrEqual(k.g)
      expect(k.g).toBeGreaterThanOrEqual(k.r)
      expect(dustModulation).toBeGreaterThan(0)
      expect(Number.isFinite(dustModulation)).toBe(true)
    }),
  )
})

it('changes only extinction when the declared dust scale changes', () => {
  const clear = createGalaxyField(seed, { dustScale: 0 })
  const dense = createGalaxyField(seed, { dustScale: 2 })
  fc.assert(
    fc.property(position, (p) => {
      const a = clear.sample(p),
        b = field.sample(p),
        c = dense.sample(p)
      expect(a.extinctionPerParsec).toEqual({ r: 0, g: 0, b: 0 })
      expect(c.extinctionPerParsec.r).toBe(2 * b.extinctionPerParsec.r)
      expect(c.extinctionPerParsec.g).toBe(2 * b.extinctionPerParsec.g)
      expect(c.extinctionPerParsec.b).toBe(2 * b.extinctionPerParsec.b)
      expect(a.populations).toEqual(b.populations)
      expect(b.populations).toEqual(c.populations)
      expect(a.emissionRgb).toEqual(b.emissionRgb)
      expect(b.emissionRgb).toEqual(c.emissionRgb)
    }),
  )
})

it('derives dust texture from its own stateless seed label', () => {
  const dustSeed = deriveSeed(seed, 'galaxy-field:dust')
  const otherSeed = deriveSeed(rootSeed('another'), 'galaxy-field:dust')
  const points = [
    [-8178.2, 20.8, 12.3],
    [8000.1, 9.7, 45.8],
    [3.2, -7.9, 2.1],
  ] as const
  const expected = points.map(([x, y, z]) =>
    galaxyDustModulation(dustSeed, x, y, z),
  )
  expect(
    [...points]
      .reverse()
      .map(([x, y, z]) => galaxyDustModulation(dustSeed, x, y, z))
      .reverse(),
  ).toEqual(expected)
  expect(
    points.map(([x, y, z]) => galaxyDustModulation(otherSeed, x, y, z)),
  ).not.toEqual(expected)
  for (const [i, [x, y, z]] of points.entries())
    expect(
      field.sample(UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC))
        .dustModulation,
    ).toBeCloseTo(expected[i]!, 8)
})

it('places a narrower dust lane inward of the stellar ridge', () => {
  const arm = GALAXY_ARMS.find((a) => a.id === 'scutum-centaurus')!
  const beta = (arm.kinkDegrees * Math.PI) / 180
  const radius = armRadius(arm, beta)
  const profile = (r: number) => galaxyDustProfile(r, beta, 0, 1).arms
  expect(profile(radius - 200)).toBeGreaterThan(profile(radius))
  expect(profile(radius - 200)).toBeGreaterThan(profile(radius - 400))
  const dustFalloff = profile(radius + 300) / profile(radius - 200)
  const stellarFalloff =
    armStrength(radius + 500, beta) / armStrength(radius, beta)
  expect(dustFalloff).toBeLessThan(stellarFalloff)
  fc.assert(
    fc.property(coordinate, coordinate, (r, angle) => {
      expect(armStrength(Math.abs(r), angle)).toBe(
        armStrength(Math.abs(r), angle, {
          radiusOffsetParsecs: 0,
          widthScale: 1,
        }),
      )
    }),
  )
})

it.each([-1, 8.001, Infinity, -Infinity, NaN])(
  'rejects invalid dust scale %s',
  (dustScale) => {
    expect(() => createGalaxyField(seed, { dustScale })).toThrow(
      'Galaxy dust scale',
    )
  },
)
