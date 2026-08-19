import { describe, expect, it } from 'vitest'
import {
  AU,
  auToMeters,
  formatDistance,
  LIGHT_YEAR,
  metersToAu,
  metersToFeet,
  metersToLightYears,
  metersToParsecs,
  PARSEC,
  parsecsToMeters,
} from './units.ts'

describe('units', () => {
  it('round-trips presentation conversions', () => {
    expect(auToMeters(metersToAu(1.234e12))).toBeCloseTo(1.234e12, 3)
    expect(parsecsToMeters(metersToParsecs(4.2 * LIGHT_YEAR))).toBeCloseTo(4.2 * LIGHT_YEAR, 3)
  })

  it('matches published constant relationships', () => {
    // 1 pc is 648000/pi AU by definition; check we transcribed both correctly.
    expect(PARSEC / AU).toBeCloseTo(648_000 / Math.PI, 6)
    // Proxima Centauri: 1.301 pc is 4.244 ly.
    expect(metersToLightYears(1.301 * PARSEC)).toBeCloseTo(4.244, 2)
  })

  it('formats across the whole range the game spans', () => {
    expect(formatDistance(0.0254)).toBe('1.000 in')
    expect(formatDistance(1.5)).toBe('1.500 m')
    expect(formatDistance(2e5)).toBe('200.000 km')
    expect(formatDistance(AU)).toBe('1.000 AU')
    expect(formatDistance(4.244 * LIGHT_YEAR)).toBe('4.244 ly')
    expect(formatDistance(8000 * PARSEC)).toBe('8.000 kpc')
    expect(formatDistance(0.5 * PARSEC)).toBe('1.631 ly')
    expect(metersToFeet(0.3048)).toBeCloseTo(1, 12)
  })
})
