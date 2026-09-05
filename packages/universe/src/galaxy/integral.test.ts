import fc from 'fast-check'
import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, vec3 } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { createGalaxyField, type GalaxyField } from './field.ts'
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
