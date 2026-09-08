import { expect, it } from 'vitest'
import fc from 'fast-check'
import { PARSEC } from '@inertialref/shared'
import {
  enhancedStarVisibility,
  STAR_VISIBILITY,
  stellarVisualIlluminance,
  stellarVisualMagnitude,
} from './starVisibility.ts'

it('leaves no sprite floor for dark sources or stars beyond the magnitude limit', () => {
  expect(enhancedStarVisibility(Infinity)).toBe(0)
  expect(enhancedStarVisibility(STAR_VISIBILITY.faintMagnitude)).toBe(0)
  expect(enhancedStarVisibility(18)).toBe(0)
})

it('preserves the observed bright-star hierarchy independently of other selected stars', () => {
  const sirius = enhancedStarVisibility(-1.46)
  const vega = enhancedStarVisibility(0.03)
  const polaris = enhancedStarVisibility(1.98)
  const faint = enhancedStarVisibility(7.9)
  expect(sirius).toBeGreaterThan(vega)
  expect(vega).toBeGreaterThan(polaris)
  expect(polaris).toBeGreaterThan(faint)
  expect(faint).toBeGreaterThan(0)
})

it('fades continuously and monotonically through the complete admitted magnitude range', () => {
  fc.assert(
    fc.property(
      fc.double({ min: -5, max: 20, noNaN: true }),
      fc.double({ min: 0, max: 10, noNaN: true }),
      (magnitude, extinction) => {
        const unattenuated = enhancedStarVisibility(magnitude)
        const attenuated = enhancedStarVisibility(magnitude + extinction)
        expect(attenuated).toBeLessThanOrEqual(unattenuated)
        expect(attenuated).toBeGreaterThanOrEqual(0)
        expect(unattenuated).toBeLessThanOrEqual(1)
      },
    ),
  )
  expect(
    enhancedStarVisibility(STAR_VISIBILITY.faintMagnitude - 1e-6),
  ).toBeLessThan(1e-6)
})

it('calibrates solar V light at ten parsecs and fades distant luminous stars', () => {
  expect(
    stellarVisualMagnitude(stellarVisualIlluminance(1, 10 * PARSEC)),
  ).toBeCloseTo(4.81, 12)
  const far = stellarVisualMagnitude(
    stellarVisualIlluminance(10_000, 30_000 * PARSEC),
  )
  expect(far).toBeGreaterThan(STAR_VISIBILITY.faintMagnitude)
  expect(enhancedStarVisibility(far)).toBe(0)
})
