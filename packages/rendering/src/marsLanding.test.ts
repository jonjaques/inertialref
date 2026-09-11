import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec } from '@inertialref/spatial'
import {
  marsApproach,
  marsLandingDrives,
  MARS_TOUCHDOWN_SECONDS,
} from './marsLanding.ts'

describe('Mars approach', () => {
  it('descends without penetrating the deck and reaches zero velocity at touchdown', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 50, noNaN: true }), (t) => {
        const { offset, velocity } = marsApproach(t)
        expect(offset.y).toBeGreaterThanOrEqual(23)
        expect(velocity.y).toBeLessThanOrEqual(1e-8)
        for (const drive of Object.values(marsLandingDrives(t))) {
          expect(drive).toBeGreaterThanOrEqual(0)
          expect(drive).toBeLessThanOrEqual(1)
        }
        if (t >= MARS_TOUCHDOWN_SECONDS) expect(Vec.length(velocity)).toBe(0)
      }),
      { numRuns: 500 },
    )
  })

  it('shares position and velocity across each burn segment', () => {
    for (const seconds of [8, 14, 20, 29, 37, 41]) {
      const left = marsApproach(seconds - 1e-6)
      const right = marsApproach(seconds + 1e-6)
      expect(Vec.length(Vec.sub(left.offset, right.offset))).toBeLessThan(0.003)
      expect(Vec.length(Vec.sub(left.velocity, right.velocity))).toBeLessThan(
        0.001,
      )
    }
  })

  it('lights the entry before ignition and extinguishes the terminal burn', () => {
    expect(marsLandingDrives(4).entryHeat).toBe(1)
    expect(marsLandingDrives(4).throttle).toBe(0)
    expect(marsLandingDrives(12).throttle).toBe(1)
    expect(marsLandingDrives(20).entryHeat).toBe(0)
    expect(marsLandingDrives(38).landingDust).toBeGreaterThan(0.6)
    expect(marsLandingDrives(41).throttle).toBe(0)
  })
})
