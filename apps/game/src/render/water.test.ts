import { describe, expect, it } from 'vitest'
import {
  CHOP_DRIFT,
  SWELL_DRIFT,
  WAVE_CLOCK_PERIOD,
  WAVE_PERIOD,
} from './water.ts'

/*
 * The wave clock is reduced on the CPU so float32 never holds an epoch's
 * worth of seconds, and the reduction is only invisible if every field the
 * clock drives has come back to where it started. Each drift, times the
 * period, has to be a whole number of the noise's own period — in the domain
 * the drift is added in: the swell's, its second octave at twice the
 * frequency, and the chop's, which is the swell's times four plus its own
 * drift.
 */
describe('the wave clock', () => {
  /** Whether `x` is a whole multiple of `period`, to the drift's own rounding. */
  const whole = (x: number, period: number): boolean => {
    const cycles = x / period
    return Math.abs(cycles - Math.round(cycles)) < 1e-9
  }

  it('brings every drift back to its own field after one period', () => {
    for (const rate of SWELL_DRIFT) {
      expect(whole(rate * WAVE_CLOCK_PERIOD, WAVE_PERIOD)).toBe(true)
      expect(whole(2 * rate * WAVE_CLOCK_PERIOD, WAVE_PERIOD)).toBe(true)
    }
    for (const [i, rate] of CHOP_DRIFT.entries()) {
      const swell = SWELL_DRIFT[i] ?? 0
      expect(whole((4 * swell + rate) * WAVE_CLOCK_PERIOD, WAVE_PERIOD)).toBe(
        true,
      )
    }
  })
})
