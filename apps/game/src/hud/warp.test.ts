import { describe, expect, it } from 'vitest'
import { nextWarp, WARP_STEPS } from './warp.ts'

/*
 * The ladder, checked at both ends and off it.
 *
 * The bug this remembers: `+`/`−` were an index step over `WARP_STEPS`, which
 * assumed the clock's time scale was always one of them. It is not — `ir.warp`
 * takes any number — and a scale above the top rung found no index, fell back
 * to 0, and answered "slower" with 1×. Pressing a button labelled one step and
 * moving five orders of magnitude is the kind of thing that gets diagnosed as a
 * clock bug.
 */

const FLOOR = 1
const CEILING = 100_000

describe('the time-warp ladder', () => {
  it('steps to a neighbouring detent from every detent', () => {
    for (const [index, step] of WARP_STEPS.entries()) {
      expect(nextWarp(step, 1)).toBe(WARP_STEPS[index + 1] ?? CEILING)
      expect(nextWarp(step, -1)).toBe(WARP_STEPS[index - 1] ?? FLOOR)
    }
  })

  it('only ever lands on a detent, from any scale at all', () => {
    // Spanning three orders below the floor to one above the ceiling, off the
    // rungs on purpose: these are the values the console and old saves produce,
    // and every one of them used to be handled by falling back to index 0.
    const scales = [
      0.001, 0.5, 1, 3, 5, 7, 25, 99, 100, 640, 1_000, 50_000, 100_000, 200_000,
    ]
    for (const scale of scales) {
      for (const direction of [1, -1]) {
        expect(WARP_STEPS).toContain(nextWarp(scale, direction))
      }
    }
  })

  it('moves in the direction it was asked to, or stops at the end', () => {
    for (const scale of [0.001, 1, 3, 5, 99, 100, 640, 100_000, 200_000]) {
      const faster = nextWarp(scale, 1)
      const slower = nextWarp(scale, -1)
      // The only permitted standstill is the rung there is nothing beyond.
      expect(faster > scale || faster === CEILING).toBe(true)
      expect(slower < scale || slower === FLOOR).toBe(true)
    }
  })

  it('answers a scale that is not a number with the floor', () => {
    // A save written by a build that stored a string, a division that went to
    // NaN: the clock takes what it is given, so this is the one place that can
    // refuse it. `NaN` compares false against every rung, so a search would
    // otherwise return the wrong end for one of the two directions.
    expect(nextWarp(Number.NaN, 1)).toBe(FLOOR)
    expect(nextWarp(Number.NaN, -1)).toBe(FLOOR)
    expect(nextWarp(Number.POSITIVE_INFINITY, -1)).toBe(FLOOR)
  })
})
