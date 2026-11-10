import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  SUN_SLICES_MOVING,
  SUN_SLICES_STEADY,
  type SunSlice,
  sunSchedule,
  sunWakeWeight,
} from './cloudSunSchedule.ts'

/* The sun grid's schedule as the grid draws it: a cap, the missing first, then the oldest. */

const SLICES = 32
const HERE = [7, -3] as const
const THERE = [8, -3] as const

const slice: fc.Arbitrary<SunSlice> = fc.record({
  origin: fc.constantFrom(null, HERE, THERE),
  frame: fc.integer({ min: -1, max: 500 }),
})
const grid = fc.array(slice, { minLength: SLICES, maxLength: SLICES })
const cap = fc.constantFrom(0, 4, 8, 16, 32)

describe('the sun grid’s schedule', () => {
  it('never bakes more slices than the cap, nor one slice twice', () => {
    fc.assert(
      fc.property(grid, cap, (slices, limit) => {
        const { bake } = sunSchedule({ slices, origin: HERE, cap: limit })
        expect(bake.length).toBeLessThanOrEqual(limit)
        expect(new Set(bake).size).toBe(bake.length)
        for (const k of bake) expect(slices[k]).toBeDefined()
      }),
    )
  })

  it('bakes the slices that hold nothing first, lowest first, and nothing else while any is missing', () => {
    fc.assert(
      fc.property(grid, cap, (slices, limit) => {
        const missing = slices.flatMap((one, k) =>
          one.origin === null ? [k] : [],
        )
        fc.pre(missing.length > 0)
        const { bake, weight } = sunSchedule({
          slices,
          origin: HERE,
          cap: limit,
        })
        expect(bake).toEqual(missing.slice(0, limit))
        // The grid stands in for nothing until every slice holds the field.
        expect(weight).toBe(missing.length <= limit ? 1 : 0)
      }),
    )
  })

  it('redraws the oldest of a whole grid: four a frame at rest, six while a slice stands at a window it has left', () => {
    const whole = (moved: number): SunSlice[] =>
      Array.from({ length: SLICES }, (_, k) => ({
        origin: k < moved ? THERE : HERE,
        // Baked in reverse, so the oldest are the highest.
        frame: 100 - k,
      }))
    const rest = sunSchedule({ slices: whole(0), origin: HERE, cap: SLICES })
    expect(rest.bake).toEqual([31, 30, 29, 28])
    expect(rest.bake).toHaveLength(SUN_SLICES_STEADY)
    expect(rest.weight).toBe(1)
    const moving = sunSchedule({ slices: whole(3), origin: HERE, cap: SLICES })
    expect(moving.bake).toHaveLength(SUN_SLICES_MOVING)
    // A cap under the steady share is the cap.
    expect(
      sunSchedule({ slices: whole(0), origin: HERE, cap: 2 }).bake,
    ).toEqual([31, 30])
  })

  it('breaks a tie in age by the slice’s index, so two runs of one sequence bake one order', () => {
    const slices: SunSlice[] = Array.from({ length: SLICES }, () => ({
      origin: HERE,
      frame: 5,
    }))
    expect(sunSchedule({ slices, origin: HERE, cap: SLICES }).bake).toEqual([
      0, 1, 2, 3,
    ])
  })

  it('trusts its source on every frame', () => {
    fc.assert(
      fc.property(
        grid,
        cap,
        (slices, limit) =>
          sunSchedule({ slices, origin: HERE, cap: limit }).sourceTrusted,
      ),
    )
  })
})

describe('the wake’s weight', () => {
  it('is one while the eye is under the height the grid idles above, and zero over it', () => {
    const idle = 51_200
    expect(sunWakeWeight(0, idle)).toBe(1)
    expect(sunWakeWeight(idle, idle)).toBe(1)
    expect(sunWakeWeight(idle + 1, idle)).toBe(0)
    expect(sunWakeWeight(400_000, idle)).toBe(0)
  })
})
