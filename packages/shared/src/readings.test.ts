import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  arcs,
  density,
  exponential,
  formatDistance,
  formatDuration,
  formatReading,
  group,
  kilometers,
  period,
  pressurized,
  round,
  significant,
  superscript,
} from './readings.ts'
import {
  AU,
  EARTH_MASS,
  EARTH_RADIUS,
  LIGHT_YEAR,
  PARSEC,
  SECONDS_PER_DAY,
} from './units.ts'

/** Mars's sidereal year, 686.98 days. */
const MARS_YEAR = 686.98 * SECONDS_PER_DAY

const finite = fc.double({ noNaN: true, noDefaultInfinity: true })
const nonFinite = fc.constantFrom(Number.NaN, Infinity, -Infinity)

/** The index of a unit in its ladder, smallest first; `million km` before `km`. */
const rung = (ladder: readonly string[], text: string): number =>
  ladder.findLastIndex((unit) => text.endsWith(` ${unit}`))

describe('the reading vocabulary', () => {
  it('groups digits without changing one of them', () => {
    fc.assert(
      fc.property(finite, fc.integer({ min: 0, max: 6 }), (value, digits) => {
        const fixed = value.toFixed(digits)
        // `toFixed` falls back to exponent notation at 1e21, which is not a
        // digit string and is never handed to `group`.
        fc.pre(!fixed.includes('e'))
        expect(group(fixed).replaceAll(',', '').replace('−', '-')).toBe(fixed)
      }),
    )
  })

  it('never prints an exponent the way a programmer types one', () => {
    // A hyphen in either place is the sign `toExponential` wrote, which
    // `group` replaces with U+2212 everywhere else.
    fc.assert(
      fc.property(finite, (value) => {
        expect(exponential(value)).not.toMatch(/[e+-]/)
        expect(significant(value)).not.toMatch(/[e+-]/)
      }),
    )
  })

  it('never chooses a smaller unit for a larger magnitude', () => {
    const distance = ['m', 'km', 'million km']
    const time = ['s', 'min', 'h', 'd', 'yr']
    const magnitude = fc.double({ min: 0, max: 1e30, noNaN: true })
    fc.assert(
      fc.property(magnitude, magnitude, (a, b) => {
        const [small, large] = a <= b ? [a, b] : [b, a]
        expect(
          rung(distance, kilometers(large)),
          `${small} m → ${kilometers(small)}, ${large} m → ${kilometers(large)}`,
        ).toBeGreaterThanOrEqual(rung(distance, kilometers(small)))
        expect(
          rung(time, period(large)),
          `${small} s → ${period(small)}, ${large} s → ${period(large)}`,
        ).toBeGreaterThanOrEqual(rung(time, period(small)))
      }),
    )
  })

  it('prints the em dash alone for a reading that is not finite', () => {
    /*
     * A unit after the dash claims a quantity that has no value, and the
     * guard inside `round` and `significant` cannot stop it: the unit is
     * appended after they return. Every instrument formatter is in this list,
     * so a new one that appends its unit to a dash fails it.
     *
     * `formatDistance` and `formatDuration` are not instrument readings.
     * They are log and debug formatters that print the number as it is, and
     * `tour/brief.ts` splits `formatDuration`'s output into a quantity and a
     * unit, which a bare dash does not have.
     */
    const formatters: Record<string, (value: number) => string> = {
      formatReading,
      round: (value) => round(value, 2),
      significant,
      exponential,
      kilometers,
      period,
      pressurized,
      arcs,
      'density of mass': (value) => density(value, EARTH_RADIUS),
      'density of radius': (value) => density(EARTH_MASS, value),
    }
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(formatters)),
        nonFinite,
        (name, value) => {
          expect(formatters[name]?.(value), `${name}(${value})`).toBe('—')
        },
      ),
    )
  })
})

describe('the goldens', () => {
  it('reads Earth, Mars and the Sun the way an almanac does', () => {
    expect(kilometers(EARTH_RADIUS)).toBe('6,371 km')
    expect(period(MARS_YEAR)).toBe('686.98 d')
    expect(formatDuration(MARS_YEAR)).toBe('1.88 yr')
    expect(arcs(9.3e-3)).toBe('0.533°')
  })

  it('steps down to arcminutes and arcseconds below a twentieth of a degree', () => {
    const arcminute = Math.PI / (180 * 60)
    expect(arcs(2 * arcminute)).toBe('2.00′')
    expect(arcs(arcminute / 2)).toBe('30.0″')
  })

  it('typesets the exponent and the minus', () => {
    expect(exponential(1.989e30)).toBe('1.989×10³⁰')
    expect(exponential(-2.5e-7)).toBe('−2.500×10⁻⁷')
    expect(significant(-1234.5)).toBe('−1,235')
    expect(round(-1234.5678, 2)).toBe('−1,234.57')
    expect(superscript('−12')).toBe('⁻¹²')
    expect(pressurized(101_325)).toBe('1.01 bar')
    expect(density(EARTH_MASS, EARTH_RADIUS)).toBe('5.513 g/cm³')
  })

  it('formats a distance across the whole range the game spans', () => {
    expect(formatDistance(0.0254)).toBe('1.000 in')
    expect(formatDistance(1.5)).toBe('1.500 m')
    expect(formatDistance(2e5)).toBe('200.000 km')
    expect(formatDistance(AU)).toBe('1.000 AU')
    expect(formatDistance(4.244 * LIGHT_YEAR)).toBe('4.244 ly')
    expect(formatDistance(8000 * PARSEC)).toBe('8.000 kpc')
    expect(formatDistance(0.5 * PARSEC)).toBe('1.631 ly')
  })

  it('reads a distance on a panel to the digit that stops moving', () => {
    expect(formatReading(20_779_659)).toBe('20,780 km')
    expect(formatReading(123_456_789)).toBe('123,457 km')
    expect(formatReading(-12.34)).toBe('−12.3 m')
  })
})
