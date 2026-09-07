import { expect, it } from 'vitest'
import fc from 'fast-check'
import { rootSeed } from '@inertialref/procedural'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { createGalaxyField } from './field.ts'
import { integrateGalaxyRay } from './integral.ts'
import { galaxyVMagnitude, galaxyDisplayRgb } from './photometry.ts'

it('holds the polar stellar sky within 0.3 V magnitude of the GAMBONS astrophysical sky', () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  // A broad polar average removes the shot noise of individually bright catalogue stars.
  let total = 0
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 12; j++)
      for (const sign of [-1, 1]) {
        const y =
          sign *
          (Math.sin(Math.PI / 3) +
            ((i + 0.5) / 4) * (1 - Math.sin(Math.PI / 3)))
        const a = ((j + 0.5) / 12) * 2 * Math.PI,
          r = Math.sqrt(1 - y * y)
        total +=
          integrateGalaxyRay(
            field,
            SUN_POSITION,
            { x: r * Math.cos(a), y, z: -r * Math.sin(a) },
            { sampling: 'settled' },
          ).radianceNanowatts / 96
      }
  expect(
    Math.abs(galaxyVMagnitude(total) - galaxyVMagnitude(41.8620565)),
  ).toBeLessThan(0.3)
})

it('keeps photometric power independent of illustrative chromaticity', () => {
  fc.assert(
    fc.property(
      fc.tuple(
        ...Array.from({ length: 3 }, () =>
          fc.double({ min: 1e-5, max: 1e5, noNaN: true }),
        ),
      ),
      (rgb) => {
        const c = galaxyDisplayRgb(rgb)
        expect(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toBeCloseTo(
          rgb[1]!,
          8,
        )
        const bright = galaxyDisplayRgb(rgb.map((v) => v * 4))
        expect(bright).toEqual(c.map((v) => v * 4))
      },
    ),
  )
  expect(galaxyDisplayRgb([0, 0, 0])).toEqual([0, 0, 0])
  expect(galaxyVMagnitude(0)).toBe(Infinity)
  expect(() => galaxyVMagnitude(-1)).toThrow()
  expect(galaxyVMagnitude(75)).toBeCloseTo(23.20194, 4)
})
