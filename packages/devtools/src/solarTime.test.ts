import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@inertialref/spatial'
import { TEST_CATALOG } from '@inertialref/universe'
import { openSession } from './session.ts'
import {
  type Geodetic,
  SUN_TIME_TOLERANCE,
  solveSun,
  solveSunTime,
  sunAt,
  sunOver,
} from './solarTime.ts'

/*
 * The solver against a body nothing but arithmetic: a sphere turning
 * uniformly about +Y under a sun that goes round it once a year at an
 * obliquity, as `frames.ts` turns every body. For any place, tilt and target
 * the sun reaches, the instant found is the target's to 10⁻⁴°, has the trend
 * asked for, and is the first: a brute walk at a few seconds a step finds no
 * earlier crossing with that trend.
 */

const DAY = 86_400

function synthetic(
  spin: number,
  year: number,
  obliquity: number,
  phase: number,
): (time: number) => Vec3 {
  return (time) => {
    const longitude = (2 * Math.PI * time) / year + phase
    // The sun in the body's inertial axes, pole +Y, tilted by the obliquity.
    const x = Math.cos(longitude)
    const y = Math.sin(longitude) * Math.sin(obliquity)
    const z = Math.sin(longitude) * Math.cos(obliquity)
    // Into body-fixed axes: the body has turned 2πt/P about +Y.
    const turn = (-2 * Math.PI * time) / spin
    const c = Math.cos(turn)
    const s = Math.sin(turn)
    return { x: c * x + s * z, y, z: -s * x + c * z }
  }
}

const solarDay = (spin: number, year: number): number =>
  Math.abs(1 / (1 / spin - 1 / year))

const place = fc.record({
  latitude: fc.double({ min: -1.3, max: 1.3, noNaN: true }),
  longitude: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
})
const body = fc.record({
  spin: fc.double({ min: 0.4 * DAY, max: 3 * DAY, noNaN: true }),
  year: fc.double({ min: 60 * DAY, max: 800 * DAY, noNaN: true }),
  obliquity: fc.double({ min: 0, max: 0.6, noNaN: true }),
  phase: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
})

describe('the sun over a place', () => {
  it('stands straight up over the subsolar point and on the horizon a quarter turn away', () => {
    const sun = { x: 1, y: 0, z: 0 }
    expect(sunOver(sun, { latitude: 0, longitude: 0 }).elevation).toBeCloseTo(
      90,
      10,
    )
    const east = sunOver(sun, { latitude: 0, longitude: -Math.PI / 2 })
    expect(east.elevation).toBeCloseTo(0, 10)
    // Longitude −90° stands west of the subsolar point, so its sun is east.
    expect(east.azimuth).toBeCloseTo(90, 10)
    const north = sunOver(sun, { latitude: -Math.PI / 4, longitude: 0 })
    expect(north.azimuth).toBeCloseTo(0, 10)
    expect(north.elevation).toBeCloseTo(45, 10)
  })
})

describe('the solved instant', () => {
  it('is the target’s, has the trend asked for, and is the first after `after`', () => {
    fc.assert(
      fc.property(
        body,
        place,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        ({ spin, year, obliquity, phase }, at, pick, after) => {
          const sun = synthetic(spin, year, obliquity, phase)
          const day = solarDay(spin, year)
          const elevation = (time: number) => sunOver(sun(time), at).elevation
          // A target the sun reaches, with the trend it reaches it at: its
          // elevation at an instant of the first two days, rising or falling
          // as the sun is there. So a crossing exists at or after `after`,
          // and a solver answering null fails rather than passes.
          const sampled = after + pick * 2 * day
          const target = elevation(sampled)
          const slope = elevation(sampled + 1) - elevation(sampled - 1)
          // At a peak or a trough the sun is neither rising nor falling, and
          // a target there is reached only at that instant: no trend names it.
          fc.pre(Math.abs(slope) > 1e-9)
          const trend = slope > 0 ? ('rising' as const) : ('falling' as const)
          const time = solveSunTime(
            sun,
            at,
            { elevation: target, trend, after },
            day,
          )
          expect(
            time,
            `${trend} through ${target}° after ${after}`,
          ).not.toBeNull()
          if (time === null) return
          expect(time).toBeGreaterThanOrEqual(after)
          expect(Math.abs(elevation(time) - target)).toBeLessThan(1e-4)
          // The trend holds on at least one side of the instant: a regular
          // crossing holds it on both, and a target equal to a day's peak or
          // trough is reached one way and left the other, so it holds on
          // one. A crossing of the wrong trend holds it on neither.
          const before = elevation(time - 1) - elevation(time)
          const next = elevation(time + 1) - elevation(time)
          const tol = 1e-9
          if (trend === 'rising')
            expect(before <= tol || next >= -tol).toBe(true)
          else expect(before >= -tol || next <= tol).toBe(true)
          // No earlier crossing with that trend, by a walk of 30 s steps.
          for (let u = after; u + 30 < time - SUN_TIME_TOLERANCE; u += 30) {
            const a = elevation(u) - target
            const b = elevation(u + 30) - target
            const crossed = trend === 'rising' ? a < 0 && b > 0 : a > 0 && b < 0
            expect(crossed, `crossed at ${u}`).toBe(false)
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('finds a crossing a few minutes under the day’s highest sun, between two samples', () => {
    // Fifteen-minute samples straddle the peak; the rise and fall to within
    // 0.01° of it both happen between two of them.
    const spin = DAY
    const sun = synthetic(spin, 1e12, 0, 0)
    const at: Geodetic = { latitude: 0.3, longitude: 0 }
    const day = solarDay(spin, 1e12)
    const peak = solveSunTime(
      sun,
      at,
      { elevation: 'noon', trend: 'rising', after: 1000 },
      day,
    )!
    const high = sunOver(sun(peak), at).elevation
    for (const trend of ['rising', 'falling'] as const) {
      const time = solveSunTime(
        sun,
        at,
        { elevation: high - 0.01, trend, after: 1000 },
        day,
      )!
      expect(Math.abs(time - peak)).toBeLessThan(900)
      expect(time < peak).toBe(trend === 'rising')
    }
  })

  it('answers noon with the day’s highest sun, and null for a sun that never gets there', () => {
    fc.assert(
      fc.property(body, place, ({ spin, year, obliquity, phase }, at) => {
        const sun = synthetic(spin, year, obliquity, phase)
        const day = solarDay(spin, year)
        const noon = solveSunTime(
          sun,
          at,
          { elevation: 'noon', trend: 'rising', after: 0 },
          day,
        )!
        expect(noon).toBeGreaterThanOrEqual(0)
        expect(noon).toBeLessThan(day * 1.01)
        const high = sunOver(sun(noon), at).elevation
        for (const offset of [-600, -60, 60, 600])
          expect(sunOver(sun(noon + offset), at).elevation).toBeLessThan(high)
      }),
      { numRuns: 60 },
    )
    // On the equator of an upright body the sun never stands higher than
    // 90° minus nothing, and never lower than −90°: ask for 91.
    const sun = synthetic(DAY, 365 * DAY, 0, 0)
    expect(
      solveSunTime(
        sun,
        { latitude: 0, longitude: 0 },
        { elevation: 91, trend: 'rising', after: 0 },
        DAY,
      ),
    ).toBeNull()
  })
})

describe('the solver over a real body', () => {
  it('solves Earth’s sun to its target and reads it back through the frame graph', () => {
    const session = openSession({ catalog: TEST_CATALOG, workers: null })
    try {
      const hash = session.world.stateHash()
      const at: Geodetic = {
        latitude: (-5 * Math.PI) / 180,
        longitude: (-60 * Math.PI) / 180,
      }
      const solved = solveSun(session.world, 's:SOL/b:2', at, {
        elevation: 50,
        trend: 'falling',
        after: 0,
      })!
      expect(solved.elevation).toBeCloseTo(50, 4)
      expect(solved.time).toBeGreaterThan(0)
      // Earth's solar day is a day: the first afternoon at 50° is within it.
      expect(solved.time).toBeLessThan(DAY)
      const read = sunAt(session.world, 's:SOL/b:2', at, solved.time)
      expect(read.elevation).toBeCloseTo(50, 4)
      expect(read.azimuth).toBeCloseTo(solved.azimuth, 6)
      const later = sunAt(session.world, 's:SOL/b:2', at, solved.time + 60)
      expect(later.elevation).toBeLessThan(read.elevation)
      // An afternoon sun stands in the west half of the sky.
      expect(read.azimuth).toBeGreaterThan(180)
      // Rule 37: asking where the sun stands writes nothing.
      expect(session.world.stateHash()).toBe(hash)
    } finally {
      session.dispose()
    }
  })

  it('refuses an address that is not a body', () => {
    const session = openSession({ catalog: TEST_CATALOG, workers: null })
    try {
      expect(() =>
        sunAt(session.world, 's:SOL', { latitude: 0, longitude: 0 }, 0),
      ).toThrow(/not a body/)
    } finally {
      session.dispose()
    }
  })
})
