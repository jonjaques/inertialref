import { describe, expect, it } from 'vitest'
import {
  AU,
  auToMeters,
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
    expect(parsecsToMeters(metersToParsecs(4.2 * LIGHT_YEAR))).toBeCloseTo(
      4.2 * LIGHT_YEAR,
      3,
    )
  })

  it('matches published constant relationships', () => {
    // 1 pc is 648000/pi AU by definition; check we transcribed both correctly.
    expect(PARSEC / AU).toBeCloseTo(648_000 / Math.PI, 6)
    // Proxima Centauri: 1.301 pc is 4.244 ly.
    expect(metersToLightYears(1.301 * PARSEC)).toBeCloseTo(4.244, 2)
  })

  it('converts to feet exactly', () => {
    expect(metersToFeet(0.3048)).toBeCloseTo(1, 12)
  })
})
