import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { EntityInspection } from '@inertialref/devtools'
import {
  arcPath,
  CLIMB_FULL_SCALE,
  climbGauge,
  formatClimb,
  formatDegrees,
  formatHeading,
  formatSpeed,
  formatThrottle,
  nextSpeedMode,
  orbitLine,
  SPEED_MODES,
  speedReading,
  SURFACE_BELOW_METRES,
} from './navCluster.ts'

/** Only the fields the cluster reads; the rest is what a fixture is for. */
const player = (overrides: Partial<EntityInspection> = {}): EntityInspection =>
  ({
    localSpeed: 7_600,
    surfaceSpeed: 7_200,
    altitude: 400_000,
    landed: false,
    orbit: null,
    ...overrides,
  }) as EntityInspection

describe('the speed readout', () => {
  it('reads the orbit in orbit and the ground near it, left to itself', () => {
    expect(speedReading(player(), 'auto')).toEqual({
      mode: 'orbit',
      value: 7_600,
    })
    expect(
      speedReading(player({ altitude: SURFACE_BELOW_METRES - 1 }), 'auto'),
    ).toEqual({ mode: 'surface', value: 7_200 })
    expect(
      speedReading(player({ landed: true, altitude: 0 }), 'auto').mode,
    ).toBe('surface')
  })

  it('reads the figure it is told to, and says so', () => {
    expect(speedReading(player(), 'surface').mode).toBe('surface')
    expect(speedReading(player(), 'orbit').mode).toBe('orbit')
  })

  it('falls back to the orbit with no ground to measure against', () => {
    expect(
      speedReading(player({ surfaceSpeed: null, altitude: 100 }), 'auto'),
    ).toEqual({ mode: 'orbit', value: 7_600 })
    expect(speedReading(player({ surfaceSpeed: null }), 'surface').value).toBe(
      null,
    )
  })

  it('cycles through every mode and back', () => {
    let mode = SPEED_MODES[0] ?? 'auto'
    const seen = new Set([mode])
    for (let i = 0; i < SPEED_MODES.length; i += 1) {
      mode = nextSpeedMode(mode)
      seen.add(mode)
    }
    expect(mode).toBe(SPEED_MODES[0])
    expect(seen.size).toBe(SPEED_MODES.length)
  })
})

describe('the figures', () => {
  it('writes a speed in the unit its magnitude asks for', () => {
    expect(formatSpeed(252.04)).toBe('252.0 m/s')
    expect(formatSpeed(7_612.3)).toBe('7.61 km/s')
    expect(formatSpeed(null)).toBe('—')
    expect(formatSpeed(Number.NaN)).toBe('—')
  })

  it('signs a rate of climb', () => {
    expect(formatClimb(12.34)).toBe('+12.3 m/s')
    expect(formatClimb(-1_500)).toBe('−1.50 km/s')
    expect(formatClimb(0)).toBe('0.0 m/s')
  })

  it('pads a heading to three figures and keeps it on the compass', () => {
    expect(formatHeading(0)).toBe('000°')
    expect(formatHeading(Math.PI / 6)).toBe('030°')
    expect(formatHeading(-Math.PI / 2)).toBe('270°')
    expect(formatHeading(Math.PI * 2)).toBe('000°')
  })

  it('signs a pitch and a bank', () => {
    expect(formatDegrees(0.3)).toBe('+17°')
    expect(formatDegrees(-0.3)).toBe('−17°')
    expect(formatDegrees(0)).toBe('0°')
  })

  it('writes a throttle as a percentage', () => {
    expect(formatThrottle(0)).toBe('0%')
    expect(formatThrottle(0.5)).toBe('50%')
    expect(formatThrottle(1)).toBe('100%')
  })

  it('names an escape and prints a ground track below zero', () => {
    expect(orbitLine(null)).toEqual({
      apoapsis: '—',
      periapsis: '—',
      period: '—',
    })
    const escape = orbitLine({
      periapsis: 200_000,
      apoapsis: null,
      eccentricity: 1.3,
      period: null,
    })
    expect(escape.apoapsis).toBe('escape')
    expect(escape.period).toBe('—')
    const track = orbitLine({
      periapsis: -212_000,
      apoapsis: 410_000,
      eccentricity: 0.05,
      period: 5_500,
    })
    // The reading's own minus, which is the typographic one.
    expect(track.periapsis).toMatch(/^[-−]212/)
    expect(track.apoapsis).toMatch(/^410/)
  })
})

describe('the climb gauge', () => {
  it('is odd, monotone, and pinned at full scale (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: CLIMB_FULL_SCALE * 3, noNaN: true }),
        (v) => {
          const up = climbGauge(v)
          expect(climbGauge(-v)).toBeCloseTo(-up, 12)
          expect(up).toBeGreaterThanOrEqual(0)
          expect(up).toBeLessThanOrEqual(1)
          if (v >= CLIMB_FULL_SCALE) expect(up).toBeCloseTo(1, 12)
          expect(climbGauge(v + 1)).toBeGreaterThanOrEqual(up)
        },
      ),
    )
    expect(climbGauge(0)).toBe(0)
    expect(climbGauge(null)).toBe(0)
  })

  it('spends its travel on the small numbers a landing is read in', () => {
    // A tenth of the needle for one meter a second; over half for a hundred.
    expect(climbGauge(1)).toBeCloseTo(0.1, 1)
    expect(climbGauge(100)).toBeGreaterThan(0.6)
  })
})

describe('the arc', () => {
  it('is empty for no span and flags the large arc past a half turn', () => {
    expect(arcPath(50, 50, 40, 0, 0)).toBe('')
    expect(arcPath(50, 50, 40, 0, Math.PI / 2)).toMatch(/A40 40 0 0 1 /)
    expect(arcPath(50, 50, 40, 0, Math.PI * 1.5)).toMatch(/A40 40 0 1 1 /)
    expect(arcPath(50, 50, 40, 0, -Math.PI / 2)).toMatch(/A40 40 0 0 0 /)
  })

  it('starts at twelve o’clock and runs clockwise', () => {
    expect(arcPath(50, 50, 40, 0, Math.PI / 2)).toBe(
      'M50.00 10.00A40 40 0 0 1 90.00 50.00',
    )
  })
})
