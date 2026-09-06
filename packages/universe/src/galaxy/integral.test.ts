import fc from 'fast-check'
import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, vec3 } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import {
  createGalaxyField,
  type GalaxyField,
  type GalaxyPopulation,
} from './field.ts'
import { GALAXY_RADIANCE_FACTOR, integrateGalaxyRay } from './integral.ts'
const field = createGalaxyField(rootSeed('inertialref'))
it('integrates a homogeneous emitter with the analytic path length and 4π conversion', () => {
  const homogeneous: GalaxyField = {
    ...field,
    sample: () => ({
      populations: {
        thinDisk: 2,
        thickDisk: 0,
        youngArms: 0,
        barBulge: 0,
        halo: 0,
      },
      totalPerCubicParsec: 2,
      emissionSolarPerCubicParsec: 3,
      emissionRgb: { r: 1, g: 1, b: 1 },
      extinctionPerParsec: { r: 0, g: 0, b: 0 },
      dustArmStrength: 0,
      dustModulation: 1,
      warpParsecs: 0,
      armStrength: 0,
    }),
  }
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 500, noNaN: true }),
      (distanceParsecs) => {
        const result = integrateGalaxyRay(
          homogeneous,
          UV.fromMeters(0, 0, 0),
          vec3(1, 2, 3),
          { distanceParsecs },
        )
        expect(result.starsPerSquareParsec).toBeCloseTo(2 * distanceParsecs, 8)
        expect(result.radianceNanowatts).toBeCloseTo(
          3 * distanceParsecs * GALAXY_RADIANCE_FACTOR,
          6,
        )
      },
    ),
  )
})
it('returns no light for a ray missing the bounded volume', () => {
  expect(
    integrateGalaxyRay(
      field,
      UV.fromMeters(0, 30000 * PARSEC, 0),
      vec3(1, 0, 0),
    ).samples,
  ).toBe(0)
})
it.each([vec3(1, 0, 0), vec3(0, 1, 0), vec3(1, 0, -1)])(
  'converges on nonzero interior rays %o',
  (direction) => {
    const a = integrateGalaxyRay(field, SUN_POSITION, direction, {
      maxStepParsecs: 100,
    })
    const b = integrateGalaxyRay(field, SUN_POSITION, direction, {
      maxStepParsecs: 25,
    })
    expect(a.radianceNanowatts).toBeGreaterThan(0)
    expect(Number.isFinite(a.radianceNanowatts)).toBe(true)
    expect(
      Math.abs(a.radianceNanowatts / b.radianceNanowatts - 1),
    ).toBeLessThan(0.01)
    expect(a.rgbNanowatts.reduce((x, y) => x + y, 0)).toBeCloseTo(
      a.radianceNanowatts,
      8,
    )
  },
)
it('rejects parameters that cannot describe a finite integral', () => {
  expect(() => integrateGalaxyRay(field, SUN_POSITION, vec3(0, 0, 0))).toThrow()
  expect(() =>
    integrateGalaxyRay(field, SUN_POSITION, vec3(1, 0, 0), {
      maxStepParsecs: 0,
    }),
  ).toThrow()
  expect(() =>
    integrateGalaxyRay(field, SUN_POSITION, vec3(1, 0, 0), {
      distanceParsecs: Infinity,
    }),
  ).toThrow()
})
it('adds the diagnostic population rays back to the complete radiance', () => {
  const origin = UV.fromMeters(-3000 * PARSEC, 12000 * PARSEC, -1000 * PARSEC),
    direction = vec3(0, -1, 0)
  const total = integrateGalaxyRay(field, origin, direction)
  let sum = 0
  for (const population of [
    'thinDisk',
    'thickDisk',
    'youngArms',
    'barBulge',
    'halo',
  ] as const)
    sum += integrateGalaxyRay(field, origin, direction, {
      population,
    }).radianceNanowatts
  expect(sum).toBeCloseTo(total.radianceNanowatts, 8)
})

it.each(['youngArm', 'constructor', '__proto__', null])(
  'rejects an unknown runtime population %s even when the ray misses the field',
  (population) => {
    expect(() =>
      integrateGalaxyRay(
        field,
        UV.fromMeters(0, 30000 * PARSEC, 0),
        vec3(1, 0, 0),
        { population: population as unknown as GalaxyPopulation },
      ),
    ).toThrow('Unknown galaxy population')
  },
)

it('resolves the observer neighborhood while keeping the reference quadrature explicit', () => {
  const options = { distanceParsecs: 100 }
  const reference = integrateGalaxyRay(
    field,
    SUN_POSITION,
    vec3(1, 0, 0),
    options,
  )
  const observer = integrateGalaxyRay(field, SUN_POSITION, vec3(1, 0, 0), {
    ...options,
    sampling: 'observer',
  })
  expect(observer.samples).toBeGreaterThan(reference.samples)
  expect(
    Math.abs(observer.radianceNanowatts / reference.radianceNanowatts - 1),
  ).toBeLessThan(0.01)
})

it.each([
  [-8178, 20.8, 0, 1, 0, 0],
  [-8178, 20.8, 0, -1, 0, 0],
  [-8178, 20.8, 0, 0, 1, 0],
  [-8178, 20.8, 0, 0, -1, 0],
  [-8178, 20.8, 0, 1, 0, -1],
  [-7900, 1000, 0, 1, -0.1, 0.1],
  [-24000, 600, 3000, 0.5, -0.05, -1],
  [3000, -20, 1000, -1, 0.01, 0.2],
  [0, 30000, 0, 0.2, -1, 0.1],
])(
  'converges from observer (%s, %s, %s) within the live iteration budget',
  (x, y, z, dx, dy, dz) => {
    const origin = UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC)
    const direction = vec3(dx, dy, dz)
    const live = integrateGalaxyRay(field, origin, direction, {
      distanceParsecs: 100000,
      sampling: 'observer',
    })
    const fine = integrateGalaxyRay(field, origin, direction, {
      distanceParsecs: 100000,
      sampling: 'observer',
      maxStepParsecs: 10,
    })
    expect(live.samples).toBeLessThan(16384)
    expect(live.radianceNanowatts).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++)
      expect(
        Math.abs(live.rgbNanowatts[i]! / fine.rgbNanowatts[i]! - 1),
      ).toBeLessThan(0.01)
  },
)

it('integrates a homogeneous absorbing emitter within each interval analytically', () => {
  const absorbing: GalaxyField = {
    ...field,
    sample: (position) => ({
      ...field.sample(position),
      totalPerCubicParsec: 2,
      emissionSolarPerCubicParsec: 3,
      emissionRgb: { r: 1, g: 1, b: 1 },
      extinctionPerParsec: { r: 0.01, g: 0.02, b: 0.03 },
    }),
  }
  const result = integrateGalaxyRay(
    absorbing,
    UV.fromMeters(0, 0, 0),
    vec3(1, 0, 0),
    { distanceParsecs: 100 },
  )
  for (const [i, k] of [0.01, 0.02, 0.03].entries())
    expect(result.rgbNanowatts[i]).toBeCloseTo(
      ((1 - Math.exp(-k * 100)) / k) * GALAXY_RADIANCE_FACTOR,
      6,
    )
  expect(result.starsPerSquareParsec).toBeCloseTo(200, 10)
})
