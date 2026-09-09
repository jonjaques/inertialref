import { expect, it } from 'vitest'
import fc from 'fast-check'
import { Quaternion, vec3 } from '@inertialref/spatial'
import { cloudShellAltitude } from './cloudShell.ts'

it('measures a tilted oblate deck at planetary radii without losing small heights', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 1e3, max: 1e8, noNaN: true }),
      fc.double({ min: 0.5, max: 1, noNaN: true }),
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
      (radius, flattening, height, angle) => {
        const orientation = Quaternion.fromAxisAngle(vec3(1, 0, 0), angle)
        const eye = Quaternion.rotate(
          orientation,
          vec3(0, (radius + height) * flattening, 0),
        )
        expect(
          Math.abs(
            cloudShellAltitude(eye, orientation, radius, flattening) - height,
          ),
        ).toBeLessThan(1e-6)
      },
    ),
  )
})
