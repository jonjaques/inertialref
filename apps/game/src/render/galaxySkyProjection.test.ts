import { expect, it } from 'vitest'
import fc from 'fast-check'
import { rootSeed } from '@inertialref/procedural'
import { vec3 } from '@inertialref/spatial'
import {
  createGalaxyField,
  integrateGalaxyRay,
  SUN_POSITION,
} from '@inertialref/universe'
import { GalaxySkyCache } from './galaxySkyCache.ts'
import { galaxyCubePixelAngle } from './galaxySkyProjection.ts'

it('bounds one cube texel angular width across the projected face', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 8, max: 2048 }),
      fc.integer({ min: 0, max: 10000 }),
      fc.integer({ min: -10000, max: 10000 }),
      (size, along, across) => {
        const step = 2 / size,
          s = -1 + (along / 10000) * (2 - step),
          t = across / 10000
        // atan2(|a × b|, a · b) measures adjacent projected rays without
        // losing tiny angles to acos cancellation.
        const angle = Math.atan2(
          step * Math.hypot(1, t),
          1 + s * (s + step) + t * t,
        )
        expect(angle).toBeLessThanOrEqual(galaxyCubePixelAngle(size))
      },
    ),
  )
})

it('filters the Solar dust column to the cube texel footprint before interpolation', () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const size = 512
  const cache = new GalaxySkyCache(field, { faceSize: size })
  try {
    const longitude = (1.37 * Math.PI) / 180,
      latitude = (2.5 * Math.PI) / 180
    const direction = vec3(
      Math.cos(longitude) * Math.cos(latitude),
      Math.sin(latitude),
      Math.sin(longitude) * Math.cos(latitude),
    )
    const options = {
      sampling: 'settled' as const,
      distanceParsecs: 100000,
      pixelAngle: cache.pixelAngle,
      resolved: {
        origin: SUN_POSITION,
        apparentMagnitudeLimit: 8,
        levelMask: 511,
      },
    }
    const sample = (d: typeof direction) =>
      integrateGalaxyRay(field, SUN_POSITION, d, options).rgbNanowatts
    const exact = sample(direction)
    // Native +X cube face: right is -Z and down is -Y. The fractional
    // coordinate is relative to texel centers, as in hardware bilinear fetch.
    const x = ((1 - direction.z / direction.x) * size) / 2 - 0.5,
      y = ((1 - direction.y / direction.x) * size) / 2 - 0.5
    const left = Math.floor(x),
      top = Math.floor(y)
    const interpolated = [0, 0, 0]
    for (let row = 0; row < 2; row++)
      for (let column = 0; column < 2; column++) {
        const rgb = sample(
          vec3(
            1,
            1 - (2 * (top + row + 0.5)) / size,
            1 - (2 * (left + column + 0.5)) / size,
          ),
        )
        const weight =
          (column ? x - left : 1 - (x - left)) * (row ? y - top : 1 - (y - top))
        for (let channel = 0; channel < 3; channel++)
          interpolated[channel]! += rgb[channel]! * weight
      }
    for (let channel = 0; channel < 3; channel++) {
      expect(exact[channel]).toBeGreaterThan(0)
      expect(
        Math.abs(interpolated[channel]! / exact[channel]! - 1),
      ).toBeLessThan(0.01)
    }
  } finally {
    cache.dispose()
  }
})
