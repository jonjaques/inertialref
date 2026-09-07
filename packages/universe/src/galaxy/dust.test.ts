import fc from 'fast-check'
import { expect, it } from 'vitest'
import { deriveSeed, noise3, rootSeed } from '@inertialref/procedural'
import { PARSEC } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import { createGalaxyField } from './field.ts'
import { GALAXY_ARMS, armRadius, armStrength } from './arms.ts'
import {
  GALAXY_DUST,
  galaxyDustModulation,
  galaxyDustOctaveMean,
  galaxyDustOctaveWeight,
  galaxyDustProfile,
} from './dust.ts'

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

it('filters an unresolved octave to its lattice mean and leaves the exact field alone', () => {
  const dustSeed = deriveSeed(seed, 'galaxy-field:dust')
  const footprint = fc.double({ min: 0, max: 1000, noNaN: true })
  const unresolved = GALAXY_DUST.octaves.reduce(
    (product, octave) => product * galaxyDustOctaveMean(octave.logAmplitude),
    1,
  )
  fc.assert(
    fc.property(coordinate, coordinate, coordinate, footprint, (x, y, z, f) => {
      const exact = galaxyDustModulation(dustSeed, x, y, z)
      expect(galaxyDustModulation(dustSeed, x, y, z, 0)).toBe(exact)
      const filtered = galaxyDustModulation(dustSeed, x, y, z, f)
      expect(Number.isFinite(filtered)).toBe(true)
      expect(filtered).toBeGreaterThan(0)
      // Beyond two cells of the coarsest octave nothing is resolved, and the
      // modulation is the same constant at every point.
      if (f >= 2 * GALAXY_DUST.octaves[0]!.scaleParsecs)
        expect(filtered).toBeCloseTo(unresolved, 12)
      // Within one cell of the finest octave everything is.
      if (f <= GALAXY_DUST.octaves[3]!.scaleParsecs)
        expect(filtered).toBe(exact)
    }),
  )
  expect(galaxyDustOctaveWeight(64, 64)).toBe(1)
  expect(galaxyDustOctaveWeight(64, 96)).toBeCloseTo(0.5, 12)
  expect(galaxyDustOctaveWeight(64, 128)).toBe(0)
  expect(field.sample(UV.fromMeters(-8178 * PARSEC, 0, 0), 0)).toEqual(
    field.sample(UV.fromMeters(-8178 * PARSEC, 0, 0)),
  )
})

it('measures the noise variance the octave means are derived from', () => {
  // The variance behind `galaxyDustOctaveMean`, re-derived over a lattice of
  // points at irrational spacing, and the derived means held to the mean of
  // exp(a·n) over the same points. 0.0729 was measured over 96³ points; 24³
  // here reproduce it within the tolerance the smaller lattice allows.
  const dustSeed = deriveSeed(seed, 'galaxy-field:dust')
  const amplitudes = GALAXY_DUST.octaves.map((octave) => octave.logAmplitude)
  let count = 0,
    squares = 0
  const sums = amplitudes.map(() => 0)
  for (let i = 0; i < 24; i++)
    for (let j = 0; j < 24; j++)
      for (let k = 0; k < 24; k++) {
        const n = noise3(
          dustSeed,
          i * 0.6180339887 + 0.13,
          j * 0.7548776662 + 0.29,
          k * 0.569840291 + 0.41,
        )
        count += 1
        squares += n * n
        amplitudes.forEach((a, m) => {
          sums[m]! += Math.exp(a * n)
        })
      }
  expect(squares / count).toBeCloseTo(GALAXY_DUST.noiseVariance, 2)
  amplitudes.forEach((a, m) =>
    expect(sums[m]! / count).toBeCloseTo(galaxyDustOctaveMean(a), 3),
  )
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
