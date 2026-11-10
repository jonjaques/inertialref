import fc from 'fast-check'
import { SimulationClock } from '@inertialref/simulation'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PACE_SLACK,
  configurePace,
  frameDelta,
  framesHeld,
  holdFrames,
  paceGrid,
  paceReport,
  paceStep,
} from './frameHold.ts'

afterEach(() => {
  configurePace(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('holds while any measurement holds, and a release counts once', () => {
  expect(framesHeld()).toBe(false)
  const first = holdFrames()
  expect(framesHeld()).toBe(true)
  const second = holdFrames()
  first()
  // Releasing the first again must not lift the second's hold.
  first()
  expect(framesHeld()).toBe(true)
  second()
  expect(framesHeld()).toBe(false)
})

describe('a page without the pace', () => {
  it('reads the pace only as 60, and nothing else, from its own URL', () => {
    const at = (search: string) => {
      vi.stubGlobal('window', { location: { search } })
      configurePace(undefined)
      return paceReport()?.periodMs ?? null
    }
    expect(at('?pace=60&clouds=1')).toBeCloseTo(1000 / 60, 12)
    for (const search of ['', '?presentation=occluded', '?pace=30', '?pace=6O'])
      expect(at(search), search).toBeNull()
  })

  it('holds and hands over `delta` exactly as the base, and reads no clock', () => {
    vi.stubGlobal('window', { location: { search: '?presentation=occluded' } })
    configurePace(undefined)
    const now = vi.spyOn(performance, 'now')
    // The base: held while a measurement holds, `delta` as R3F gave it.
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant({ op: 'hold' as const }),
            fc.constant({ op: 'release' as const }),
            fc.double({ min: 0, max: 0.25, noNaN: true }).map((delta) => ({
              op: 'frame' as const,
              delta,
            })),
          ),
          { maxLength: 60 },
        ),
        (ops) => {
          const releases: (() => void)[] = []
          let count = 0
          for (const step of ops) {
            if (step.op === 'hold') {
              releases.push(holdFrames())
              count += 1
            } else if (step.op === 'release') {
              const release = releases.pop()
              if (release === undefined) continue
              release()
              count -= 1
            } else {
              expect(framesHeld()).toBe(count > 0)
              expect(frameDelta(step.delta)).toBe(count > 0 ? null : step.delta)
            }
          }
          for (const release of releases) release()
        },
      ),
    )
    expect(now).not.toHaveBeenCalled()
  })
})

/**
 * Display callbacks at `hz` with up to ±`jitterMs` on each, for `seconds`,
 * fed to a fresh grid: the times drawn.
 */
function drive(hz: number, jitter: readonly number[], seconds: number) {
  const grid = paceGrid(60)
  const drawn: number[] = []
  const n = Math.floor(seconds * hz)
  for (let k = 0; k < n; k += 1) {
    const at = (k * 1000) / hz + (jitter[k % jitter.length] ?? 0)
    if (paceStep(grid, at)) drawn.push(at)
  }
  return { grid, drawn }
}

const jitters = (ms: number) =>
  fc.array(fc.double({ min: -ms, max: ms, noNaN: true }), {
    minLength: 1,
    maxLength: 64,
  })

describe('the page’s 60 Hz grid', () => {
  it('draws at 60 Hz from callbacks at 60, 90, 120 and 144 Hz with jitter', () => {
    /*
     * The bound: over any 3 s after the first second, 179 to 181 frames
     * drawn, 59.7 to 60.3 Hz, with callbacks jittered by up to 1 ms. The
     * grid is anchored, so its mean is 60 exactly and the bound is the one
     * frame a window's edges may cut either way. No grid point draws twice
     * and none is restarted.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(60, 90, 120, 144),
        jitters(1),
        (hz, jitter) => {
          const { grid, drawn } = drive(hz, jitter, 5)
          for (const start of [1000, 1500, 2000]) {
            const inside = drawn.filter((t) => t >= start && t < start + 3000)
            expect(
              inside.length,
              `${hz} Hz from ${start}`,
            ).toBeGreaterThanOrEqual(179)
            expect(inside.length, `${hz} Hz from ${start}`).toBeLessThanOrEqual(
              181,
            )
          }
          expect(grid.behind).toBe(0)
          // No grid point draws twice: two draws are never closer than one
          // callback interval or the grid's period less the slack, whichever
          // is smaller, less the jitter on both. At 90 Hz the gaps alternate
          // 11.1 and 22.2 ms, which is the grid's 16.7 in the mean.
          const gaps = drawn.slice(1).map((t, i) => t - (drawn[i] ?? t))
          expect(Math.min(...gaps)).toBeGreaterThanOrEqual(
            // 1e-9 ms: the float rounding of two millisecond-scale sums.
            Math.min(1000 / hz, (1 - PACE_SLACK) * (1000 / 60)) - 2 - 1e-9,
          )
        },
      ),
    )
  })

  it('draws every callback under 60 Hz, and its count says the hold was not reached', () => {
    fc.assert(
      fc.property(fc.constantFrom(30, 45, 50, 59), jitters(1), (hz, jitter) => {
        const { grid, drawn } = drive(hz, jitter, 3)
        expect(grid.skipped).toBe(0)
        expect(drawn).toHaveLength(Math.floor(3 * hz))
        expect(grid.behind).toBeGreaterThan(0)
      }),
    )
  })

  it('draws every callback after a stall rather than a burst to catch up', () => {
    const grid = paceGrid(60)
    for (let k = 0; k < 60; k += 1) paceStep(grid, (k * 1000) / 120)
    // A second with no callback, then 120 Hz again: one draw in two.
    const after = Array.from({ length: 24 }, (_, k) =>
      paceStep(grid, 1500 + (k * 1000) / 120),
    )
    expect(after.filter(Boolean)).toHaveLength(12)
  })
})

describe('a page with the pace', () => {
  /** A clock the test moves, and a callback: every consumer of it asks once. */
  function paced() {
    let at = 0
    configurePace(60, () => at)
    return async (ms: number, deltaS: number, consumers = 3) => {
      at += ms
      const seen = Array.from({ length: consumers }, () => frameDelta(deltaS))
      const held = framesHeld()
      // The callback's task ends; the next one decides afresh.
      await Promise.resolve()
      return { seen, held }
    }
  }

  it('gives every consumer of one callback the same answer', async () => {
    const callback = paced()
    await callback(0, 1 / 120)
    const skipped = await callback(1000 / 120, 1 / 120)
    expect(skipped).toEqual({ seen: [null, null, null], held: true })
    const drawn = await callback(1000 / 120, 1 / 120)
    expect(drawn.held).toBe(false)
    // Its own delta and the skipped one's, to every consumer alike.
    expect(drawn.seen).toEqual([2 / 120, 2 / 120, 2 / 120])
  })

  it('books every second of wall time to the world, none dropped and none twice', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(60, 90, 120, 144),
        jitters(0.5),
        async (hz, jitter) => {
          const callback = paced()
          let wall = 0
          let booked = 0
          let last = 0
          for (let k = 0; k < 3 * hz; k += 1) {
            const at = (k * 1000) / hz + (jitter[k % jitter.length] ?? 0)
            const delta = Math.max(0, at - last) / 1000
            const { seen } = await callback(at - last, delta, 1)
            last = at
            wall += delta
            booked += seen[0] ?? 0
          }
          // What is not booked yet is at most the callbacks since the last draw.
          expect(wall - booked).toBeGreaterThanOrEqual(-1e-12)
          expect(wall - booked).toBeLessThan(1 / 60 + 1e-3)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('runs the simulation’s ticks as the unpaced page does, by wall time', async () => {
    /*
     * The clock books ticks from the `delta` it is handed (`clock.plan`), so
     * the same wall time handed over in other frames is the same ticks: none
     * skipped where a draw was, none doubled where two intervals arrive in
     * one. Callbacks at 128 Hz, 1/128 s apiece, keep every sum exact in
     * binary, so the two counts are compared for equality, not within a bound.
     */
    const callback = paced()
    const raw = new SimulationClock()
    const pacedClock = new SimulationClock()
    const book = (clock: SimulationClock, delta: number) => {
      const { wanted } = clock.plan(delta)
      clock.settle(wanted)
      return wanted
    }
    let rawTicks = 0
    let pacedTicks = 0
    let drawn = 0
    // Three seconds, then on to the next drawn frame, so nothing is banked.
    for (let k = 0; k < 3 * 128 || drawn === 0; k += 1) {
      rawTicks += book(raw, 1 / 128)
      const { seen } = await callback(1000 / 128, 1 / 128, 1)
      const step = seen[0] ?? null
      drawn = step === null ? 0 : 1
      if (step !== null) pacedTicks += book(pacedClock, step)
    }
    expect(pacedTicks).toBe(rawTicks)
    // Three seconds and a callback or two at 64 ticks a second.
    expect(rawTicks).toBeGreaterThanOrEqual(3 * 64)
    expect(rawTicks).toBeLessThanOrEqual(3 * 64 + 1)
  })

  it('still holds every frame while a measurement holds, banking nothing', async () => {
    const callback = paced()
    await callback(0, 1 / 60)
    const release = holdFrames()
    expect((await callback(1000 / 60, 1 / 60)).seen).toEqual([null, null, null])
    release()
    // The measurement's frame is timed, not lived: its delta is not carried.
    expect((await callback(1000 / 60, 1 / 60)).seen).toEqual([
      1 / 60,
      1 / 60,
      1 / 60,
    ])
  })
})
