import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CACHE_PACE_SHARE,
  cachePace,
  freshSunGrid,
  freshSunSource,
  owedByMotion,
  owedBySun,
  SUN_PACE_DEGREES,
  SUN_SLICES_MOVING,
  SUN_WAKE_SHARE,
  type SunGridState,
  sunGridStep,
  type SunGridStep,
  type SunSourceState,
  sunSourceStep,
  type SunSourceStep,
  sunWakeWeight,
  trustedWindow,
} from './cloudSunSchedule.ts'

/*
 * The sun's depth as the renderer schedules it: a volume of three levels of
 * 34 slices and a grid of 32 over the middle one, stepped a frame at a time
 * through whatever a session does to them.
 */

const LEVELS = 3
/** The level the grid's cells are laid on. */
const GRID_LEVEL = 1
const STACK = 34
const SLICES = 32
const CAPS = [4, 8, 16] as const
const RAMPS = [8, 16, 32] as const

/** What one frame does to the caches. */
interface Frame {
  /** The field is another one: a jump, a new weather. */
  readonly reset: boolean
  /** The maps the volume bakes from owe nothing. */
  readonly ready: boolean
  /** Texels each level's window moved. */
  readonly scroll: readonly [number, number, number]
  /** Whether each level's anchor moved. */
  readonly anchor: readonly [boolean, boolean, boolean]
  /** Whether each level is out of reach. */
  readonly idle: readonly [boolean, boolean, boolean]
  /** The share of a whole redraw the frame owes: the volume's levels, then the grid. */
  readonly owed: readonly [number, number, number, number]
}

const QUIET: Frame = {
  reset: false,
  ready: true,
  scroll: [0, 0, 0],
  anchor: [false, false, false],
  idle: [false, false, false],
  owed: [0, 0, 0, 0],
}

interface World {
  frame: number
  source: SunSourceState
  grid: SunGridState
  origin: number[]
  epoch: number[]
  /** The frame the grid's field last changed under it. */
  lost: number
}

interface Stepped {
  readonly source: SunSourceStep
  readonly grid: SunGridStep
  /** The source was trusted when the grid's step read it. */
  readonly trusted: boolean
}

const fresh = (): World => ({
  frame: 0,
  source: freshSunSource(LEVELS, STACK),
  grid: freshSunGrid(SLICES),
  origin: [0, 0, 0],
  epoch: [0, 0, 0],
  lost: 0,
})

/** One frame of the two caches, the grid reading the volume it was just handed, as the field renders them. */
function step(world: World, now: Frame, cap: number, ramp: number): Stepped {
  const wasIdle = world.grid.idle
  world.origin = world.origin.map((at, L) => at + now.scroll[L]!)
  world.epoch = world.epoch.map((at, L) => at + (now.anchor[L]! ? 1 : 0))
  const source = sunSourceStep(world.source, {
    frame: world.frame,
    reset: now.reset,
    ready: now.ready,
    cap,
    levels: world.origin.map((origin, L) => ({
      origin: [origin, 0] as const,
      epoch: world.epoch[L]!,
      rebuilt: now.anchor[L]!,
      idle: now.idle[L]!,
      owed: now.owed[L]!,
    })),
  })
  if (now.reset || now.anchor[GRID_LEVEL] || (wasIdle && !now.idle[GRID_LEVEL]))
    world.lost = world.frame
  const grid = sunGridStep(world.grid, {
    frame: world.frame,
    // Two of the level's texels a cell.
    origin: [Math.floor(world.origin[GRID_LEVEL]! / 2), 0],
    epoch: world.epoch[GRID_LEVEL]!,
    rebuilt: now.anchor[GRID_LEVEL],
    idle: now.idle[GRID_LEVEL],
    owed: now.owed[LEVELS]!,
    cap,
    ramp,
    source: { trusted: source.trusted, generation: source.state.generation },
  })
  world.source = source.state
  world.grid = grid.state
  world.frame += 1
  return { source, grid, trusted: source.trusted }
}

/** Frames until the grid's weight is one, from a world that has just lost everything. */
function framesToWhole(cap: number, ramp: number): number {
  const world = fresh()
  for (let n = 1; n <= 200; n += 1) {
    step(world, n === 1 ? { ...QUIET, reset: true } : QUIET, cap, ramp)
    if (world.grid.weight === 1) return n
  }
  return Infinity
}

const settled = (cap = 8, ramp = 16): World => {
  const world = fresh()
  for (let n = 0; n < 200; n += 1) step(world, QUIET, cap, ramp)
  return world
}

const frame: fc.Arbitrary<Frame> = fc.record({
  reset: fc.integer({ min: 0, max: 39 }).map((n) => n === 0),
  ready: fc.integer({ min: 0, max: 9 }).map((n) => n > 0),
  scroll: fc.tuple(
    fc.constantFrom(0, 0, 0, 0, 1, 2, 9),
    fc.constantFrom(0, 0, 0, 0, 1, 2, 5),
    fc.constantFrom(0, 0, 0, 0, 0, 1),
  ),
  anchor: fc.tuple(
    fc.integer({ min: 0, max: 39 }).map((n) => n === 0),
    fc.integer({ min: 0, max: 39 }).map((n) => n === 0),
    fc.integer({ min: 0, max: 39 }).map((n) => n === 0),
  ),
  idle: fc
    .integer({ min: 0, max: 19 })
    // A finer level idles first on the way up, and never awake over a
    // coarser one that idles.
    .map((n): [boolean, boolean, boolean] => [n < 3, n < 2, n < 1]),
  owed: fc.tuple(
    fc.double({ min: 0, max: 0.6, noNaN: true }),
    fc.double({ min: 0, max: 0.6, noNaN: true }),
    fc.double({ min: 0, max: 0.6, noNaN: true }),
    fc.double({ min: 0, max: 0.6, noNaN: true }),
  ),
})
const session = fc.array(frame, { minLength: 1, maxLength: 160 })
const cap = fc.constantFrom(...CAPS)
const ramp = fc.constantFrom(...RAMPS)

describe('a cache’s pace', () => {
  it('bakes whole units up to the cap, carries the rest, and never owes more than itself once over', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.array(fc.double({ min: 0, max: 2, noNaN: true }), {
          minLength: 1,
          maxLength: 120,
        }),
        fc.integer({ min: 0, max: 16 }),
        (units, owes, limit) => {
          let credit = 0
          let asked = 0
          let done = 0
          for (const owed of owes) {
            const pace = cachePace({ units, owed, credit, cap: limit })
            expect(Number.isInteger(pace.bake)).toBe(true)
            expect(pace.bake).toBeGreaterThanOrEqual(0)
            expect(pace.bake).toBeLessThanOrEqual(limit)
            expect(pace.credit).toBeGreaterThanOrEqual(0)
            expect(pace.credit).toBeLessThanOrEqual(units)
            asked += units * owed
            done += pace.bake
            credit = pace.credit
          }
          // Nothing is baked that was not asked for.
          expect(done).toBeLessThanOrEqual(asked + 1e-6)
        },
      ),
    )
  })

  it('redraws a cache whole in the time its content takes to cross a tenth of a texel', () => {
    // 25 m/s across 400 m cells at 60 Hz: a tenth of a cell in 1.6 s, 96 frames.
    const owed = owedByMotion(25 / 60, 400)
    expect(1 / owed).toBeCloseTo((400 * CACHE_PACE_SHARE) / (25 / 60), 9)
    let credit = 0
    let done = 0
    for (let n = 0; n < 96; n += 1) {
      const pace = cachePace({ units: SLICES, owed, credit, cap: 8 })
      done += pace.bake
      credit = pace.credit
    }
    expect(done).toBeGreaterThanOrEqual(SLICES - 1)
    expect(done).toBeLessThanOrEqual(SLICES)
  })

  it('asks for a whole grid in the time the sun turns a quarter of a degree', () => {
    const turn = (SUN_PACE_DEGREES * Math.PI) / 180
    expect(owedBySun(turn)).toBeCloseTo(1, 12)
    expect(owedBySun(-turn / 4)).toBeCloseTo(0.25, 12)
    expect(owedBySun(Number.NaN)).toBe(0)
    expect(owedByMotion(10, 0)).toBe(0)
  })
})

describe('the sun’s depth through any session', () => {
  it('bakes no more than the cap of either cache in any frame, and no slice twice', () => {
    fc.assert(
      fc.property(session, cap, ramp, (frames, limit, rise) => {
        const world = fresh()
        for (const now of frames) {
          const { source, grid } = step(world, now, limit, rise)
          expect(source.bake.length).toBeLessThanOrEqual(limit)
          expect(grid.bake.length).toBeLessThanOrEqual(limit)
          expect(new Set(grid.bake).size).toBe(grid.bake.length)
          expect(
            new Set(source.bake.map((one) => one.level * STACK + one.slice))
              .size,
          ).toBe(source.bake.length)
        }
      }),
    )
  })

  it('bakes no slice of the grid while a level of the volume is untrusted, and none of the volume while its maps owe work', () => {
    fc.assert(
      fc.property(session, cap, ramp, (frames, limit, rise) => {
        const world = fresh()
        for (const now of frames) {
          const { source, grid, trusted } = step(world, now, limit, rise)
          if (!trusted) expect(grid.bake).toEqual([])
          if (!now.ready) expect(source.bake).toEqual([])
          // Trusted is every awake level whole, and at least one awake.
          if (trusted) {
            expect(world.source.levels.some((level) => !level.idle)).toBe(true)
            for (const level of world.source.levels)
              if (!level.idle)
                for (const one of level.slices)
                  expect(one.origin).not.toBeNull()
          }
        }
      }),
    )
  })

  it('holds the weight at zero until every slice holds the current field, raises it by no more than 1/ramp a frame, and drops it only to zero', () => {
    fc.assert(
      fc.property(session, cap, ramp, (frames, limit, rise) => {
        const world = fresh()
        let before = 0
        for (const now of frames) {
          step(world, now, limit, rise)
          const { weight, slices } = world.grid
          expect(weight).toBeGreaterThanOrEqual(0)
          expect(weight).toBeLessThanOrEqual(1)
          if (weight > before)
            expect(weight - before).toBeLessThanOrEqual(1 / rise + 1e-12)
          else if (weight < before) expect(weight).toBe(0)
          if (weight > 0)
            for (const one of slices) {
              expect(one.origin).not.toBeNull()
              // Baked since the field last changed under the grid.
              expect(one.frame).toBeGreaterThanOrEqual(world.lost)
            }
          before = weight
        }
      }),
    )
  })

  it('bakes what the motion asked for and no more, whatever the sun or the clock does to a whole grid', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 3, noNaN: true }), {
          minLength: 1,
          maxLength: 200,
        }),
        cap,
        (owes, limit) => {
          const world = settled(limit)
          let asked = 0
          let done = 0
          for (const owed of owes) {
            const { grid } = step(
              world,
              { ...QUIET, owed: [0, 0, 0, owed] },
              limit,
              16,
            )
            asked += SLICES * owed
            done += grid.bake.length
            // No event: the weight stands, and no frame is a rebuild.
            expect(world.grid.weight).toBe(1)
            expect(grid.bake.length).toBeLessThanOrEqual(limit)
            expect(grid.bake.length).toBeLessThan(SLICES)
          }
          expect(done).toBeLessThanOrEqual(asked + 1e-6)
        },
      ),
    )
  })
})

describe('a turning sun', () => {
  /** Earth's sun, degrees a frame at 60 Hz, at a warp. */
  const earth = (warp: number): number =>
    owedBySun((((360 / 86_164) * warp) / 60) * (Math.PI / 180))

  it('is no event: a steady turn bakes its own pace every frame, through 0.05° and past it', () => {
    for (const warp of [1, 25, 100, 400]) {
      const world = settled()
      const owed = earth(warp)
      let most = 0
      let least = Infinity
      // Ten degrees of sun at the least: two hundred times the 0.05° a
      // whole rebuild fired on.
      const frames = Math.max(600, Math.ceil(40 / owed))
      for (let n = 0; n < frames; n += 1) {
        const { grid } = step(world, { ...QUIET, owed: [0, 0, 0, owed] }, 8, 16)
        most = Math.max(most, grid.bake.length)
        least = Math.min(least, grid.bake.length)
      }
      const pace = SLICES * owed
      expect(most).toBeLessThanOrEqual(Math.ceil(pace))
      expect(least).toBeGreaterThanOrEqual(Math.floor(pace))
      // No slice is ever further behind the sun than the pace allows.
      const oldest = Math.min(...world.grid.slices.map((one) => one.frame))
      expect((world.frame - 1 - oldest) * owed).toBeLessThanOrEqual(1 + owed)
      expect(world.grid.weight).toBe(1)
    }
  })

  it('at a warp of 1,000 bakes the cap every frame and never the grid whole', () => {
    const world = settled()
    const owed = earth(1000)
    // 0.0696° a frame asks for 8.9 slices, and the cap is 8.
    expect(SLICES * owed).toBeGreaterThan(8)
    for (let n = 0; n < 400; n += 1) {
      const { grid, source } = step(
        world,
        { ...QUIET, owed: [owed, owed, owed, owed] },
        8,
        16,
      )
      expect(grid.bake.length).toBe(8)
      expect(source.bake.length).toBeLessThanOrEqual(8)
      expect(world.grid.weight).toBe(1)
    }
    // It lags by a cycle and no more: every slice is from the last four frames.
    const oldest = Math.min(...world.grid.slices.map((one) => one.frame))
    expect(world.frame - 1 - oldest).toBeLessThan(SLICES / 8)
    // No level of the volume starves another: each is redrawn whole within
    // two of its own cycles at a third of the cap.
    for (const level of world.source.levels) {
      const behind = Math.min(...level.slices.map((one) => one.frame))
      expect(world.frame - 1 - behind).toBeLessThan((2 * STACK * LEVELS) / 8)
    }
  })
})

describe('a rebuild', () => {
  it('is the volume, then the grid, then the ramp: 33 frames at the defaults', () => {
    // 102 slices at 8 a frame, 32 at 8, and 16 frames of weight.
    expect(framesToWhole(8, 16)).toBe(13 + 4 + 16)
    expect(framesToWhole(4, 16)).toBe(26 + 8 + 16)
    expect(framesToWhole(8, 32)).toBe(13 + 4 + 32)
    expect(framesToWhole(16, 16)).toBe(7 + 2 + 16)
    expect(framesToWhole(16, 8)).toBe(7 + 2 + 8)
  })

  it('bakes the finest level first, then the coarser ones, then the grid from the frame after the volume is whole', () => {
    const world = fresh()
    const order: string[] = []
    for (let n = 0; n < 17; n += 1) {
      const { source, grid } = step(world, QUIET, 8, 16)
      const levels = new Set(source.bake.map((one) => one.level))
      order.push(
        grid.bake.length > 0
          ? 'grid'
          : [...levels].map((L) => `level ${L}`).join('+'),
      )
      expect(world.grid.weight).toBe(0)
    }
    expect(order).toEqual([
      'level 0',
      'level 0',
      'level 0',
      'level 0',
      'level 0+level 1',
      'level 1',
      'level 1',
      'level 1',
      'level 1+level 2',
      'level 2',
      'level 2',
      'level 2',
      'level 2',
      'grid',
      'grid',
      'grid',
      'grid',
    ])
  })

  it('waits for the maps: nothing is baked while they owe work, and the rebuild starts when they do not', () => {
    const world = fresh()
    for (let n = 0; n < 6; n += 1) {
      const { source, grid } = step(world, { ...QUIET, ready: false }, 8, 16)
      expect(source.bake).toEqual([])
      expect(grid.bake).toEqual([])
      expect(source.pending).toBe(true)
      expect(grid.pending).toBe(true)
    }
    expect(step(world, QUIET, 8, 16).source.bake).toHaveLength(8)
  })

  it('follows a jump of the field, and another level’s own rebuild only pauses the grid', () => {
    const world = settled()
    step(world, { ...QUIET, reset: true }, 8, 16)
    expect(world.grid.weight).toBe(0)
    expect(world.grid.slices.every((one) => one.origin === null)).toBe(true)
    for (const anchor of [
      [true, false, false],
      [false, false, true],
    ] as const) {
      const again = settled()
      const { grid } = step(again, { ...QUIET, anchor }, 8, 16)
      // The grid's cells are the middle level's: they still hold the field.
      expect(again.grid.weight).toBe(1)
      expect(grid.bake).toEqual([])
      expect(grid.pending).toBe(false)
    }
    // Its own level's anchor is its own: every slice again.
    const own = settled()
    step(own, { ...QUIET, anchor: [false, true, false] }, 8, 16)
    expect(own.grid.weight).toBe(0)
  })

  it('redraws six slices a frame at a new window, the oldest first, and the weight stands', () => {
    const world = settled()
    // Two texels of the grid's level: one cell of the grid.
    const { grid } = step(world, { ...QUIET, scroll: [0, 2, 0] }, 8, 16)
    expect(grid.bake).toHaveLength(SUN_SLICES_MOVING)
    expect(grid.pending).toBe(true)
    expect(world.grid.weight).toBe(1)
    let frames = 1
    let owing = true
    while (owing) {
      owing = step(world, QUIET, 8, 16).grid.pending
      frames += 1
    }
    expect(frames).toBe(Math.ceil(SLICES / SUN_SLICES_MOVING))
    expect(trustedWindow(world.grid.slices, 128)).toEqual([1, 0, 129, 128])
  })

  it('trusts the windows its slices share, and nothing while one is missing', () => {
    const at = (x: number) => ({ origin: [x, 0] as const, frame: 0 })
    expect(trustedWindow([at(0), at(1), at(3)], 128)).toEqual([3, 0, 128, 128])
    expect(trustedWindow([at(0), { origin: null, frame: -1 }], 128)).toBeNull()
    expect(trustedWindow([], 128)).toBeNull()
  })
})

describe('the wake', () => {
  const IDLE = 51_200

  it('is zero at the height the grid idles above and one a quarter of it lower, by the eye’s height alone', () => {
    expect(sunWakeWeight(IDLE, IDLE)).toBe(0)
    expect(sunWakeWeight(400_000, IDLE)).toBe(0)
    expect(sunWakeWeight(IDLE * (1 - SUN_WAKE_SHARE), IDLE)).toBe(1)
    expect(sunWakeWeight(0, IDLE)).toBe(1)
    expect(sunWakeWeight(-500, IDLE)).toBe(1)
    expect(sunWakeWeight(IDLE - 6400, IDLE)).toBeCloseTo(0.5, 12)
    fc.assert(
      fc.property(
        fc.double({ min: -1e4, max: 1e6, noNaN: true }),
        fc.double({ min: 0, max: 1e4, noNaN: true }),
        (height, lower) => {
          const high = sunWakeWeight(height, IDLE)
          const low = sunWakeWeight(height - lower, IDLE)
          expect(high).toBeGreaterThanOrEqual(0)
          expect(low).toBeLessThanOrEqual(1)
          // Lower is never less of the grid.
          expect(low).toBeGreaterThanOrEqual(high)
        },
      ),
    )
  })

  it('starts the rebuild at the wake, so the weight has risen before the eye is through the fade', () => {
    const world = settled()
    const up: Frame = { ...QUIET, idle: [true, true, false] }
    step(world, up, 8, 16)
    expect(world.grid.weight).toBe(0)
    expect(step(world, up, 8, 16).grid.pending).toBe(false)
    // Its own level awake again, the finest still out of reach: that level
    // and the grid come back under the cap.
    const down: Frame = { ...QUIET, idle: [true, false, false] }
    let frames = 0
    do {
      step(world, down, 8, 16)
      frames += 1
    } while (world.grid.weight < 1)
    expect(frames).toBe(Math.ceil(STACK / 8) + 4 + 16)
    // The finest level waking lower down pauses the grid and costs it nothing.
    const { grid } = step(world, QUIET, 8, 16)
    expect(grid.bake).toEqual([])
    expect(world.grid.weight).toBe(1)
  })
})
