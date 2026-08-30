import { afterEach, describe, expect, it } from 'vitest'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { MemorySaveStore } from '@inertialref/persistence'
import { timingHub, type TimingRecord } from '@inertialref/shared'
import { GameEngine } from './GameEngine.ts'

/*
 * **The timing port is inert when nothing is listening.**
 *
 * The invariant that most needs a live check rather than a unit one, because
 * breaking it costs frame time *silently* — precisely the failure mode a
 * performance tool must not have. The failure it catches is a call site that
 * reads the clock, formats a string or builds a detail object *outside* its
 * `if (timer.on)` guard: invisible in a diff, passes every type check, changes
 * no other test, and makes every frame in the shipped build pay for an
 * instrument nobody turned on.
 *
 * **It counts clock reads, and it took two tries to find the observable that
 * means anything.** The obvious test — attach a recording sink, leave the level
 * `off`, assert no entries — is vacuous by construction: a sink *is* what `on`
 * means, so attaching one turns the instrument on and every guard opens. The
 * question is not "does an entry arrive", it is "was anything spent deciding
 * not to send one", and the only thing spent is a call to `performance.now`.
 *
 * The plan called this a thirteenth capability check. It is deliberately not
 * one: `README.md` carries a `12/12` badge over a closed historical set — the
 * first milestone's list — and growing that number by arithmetic rather than by
 * milestone makes the claim mean something else. This runs beside them.
 */

const registry = createTaskRegistry()
const FRAMES = 120

const engineFor = (): GameEngine => {
  let clock = 0
  return new GameEngine({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    store: new MemorySaveStore(),
    // The *session's* clock, injected. Distinct from `performance.now`, which
    // is what this file counts — so the pool's own bookkeeping cannot be
    // mistaken for the engine reading a wall clock it was not allowed to.
    now: () => (clock += 16),
  })
}

/** Run frames with `performance.now` counted, and hand back how many reads. */
function readsOverRun(run: () => void): number {
  const real = performance.now.bind(performance)
  let reads = 0
  performance.now = () => {
    reads += 1
    return real()
  }
  try {
    run()
  } finally {
    performance.now = real
  }
  return reads
}

afterEach(() => {
  // The hub is module-global, so a leaked sink would make the next file's
  // engine emit into a dead array — the same process-wide-side-effect hazard
  // `main.tsx` describes for the log sink.
  expect(timingHub.on).toBe(false)
})

describe('the timing port, with nothing listening', () => {
  it('reads the wall clock exactly twice a frame', () => {
    /*
     * Two, and they are the two `GameEngine.frame` already had before any of
     * this existed: one before `#step` and one after. Every span in the engine
     * and the terrain streamer is built from those two numbers or from a
     * `PhaseClock` that does not read at all while the hub is empty.
     *
     * An exact count rather than an upper bound, because the bound this is
     * guarding is not "roughly cheap" — it is "the instrumented build and the
     * uninstrumented one do identical work", and only equality says that.
     */
    expect(timingHub.on).toBe(false)
    const engine = engineFor()
    const reads = readsOverRun(() => {
      for (let i = 0; i < FRAMES; i += 1) engine.frame(1 / 60)
    })
    engine.dispose()
    expect(reads).toBe(FRAMES * 2)
  })

  it('reads it more once a sink attaches, so the count above means something', () => {
    /*
     * The other half, and the reason the first test is not vacuous: a run whose
     * spans were never reached would satisfy it exactly as well as a correctly
     * inert one. Same engine, same frames, one sink — and the reads go up
     * because the phases now time themselves.
     */
    const records: TimingRecord[] = []
    const detach = timingHub.attach(
      { write: (record) => records.push(record) },
      { now: () => performance.now() },
    )
    const engine = engineFor()
    const reads = readsOverRun(() => {
      for (let i = 0; i < FRAMES; i += 1) engine.frame(1 / 60)
    })
    engine.dispose()
    detach()

    expect(reads).toBeGreaterThan(FRAMES * 2)
    const names = new Set(records.map((record) => record.name))
    expect(names.has('engine')).toBe(true)
    expect(names.has('frame')).toBe(true)
    expect(names.has('snapshot')).toBe(true)
    // One `engine` entry per frame, which is also the claim that the loop ran.
    expect(records.filter((record) => record.name === 'engine')).toHaveLength(
      FRAMES,
    )
    // One fewer `frame`: the period covers the interval between two frames, so
    // the first has no predecessor to measure against.
    expect(records.filter((record) => record.name === 'frame')).toHaveLength(
      FRAMES - 1,
    )
  })

  it('measures the period as a period and the engine as work', () => {
    /*
     * The two are different quantities against different budgets, and folding
     * them into one entry hid a real class of defect: while `frame` covered the
     * engine step and was colored against `DROPPED_FRAME_MS` — which
     * `perfBudgets.ts` defines for the *interval between frames*, and whose own
     * comment warns that judging on the wrong one "gets this wrong in the most
     * misleading direction" — a session whose engine ran at 2 ms while the
     * renderer took 28 reported no late frames at all.
     *
     * `engine` must therefore be *inside* the wall clock and `frame` must *be*
     * it. The clock here advances 16 ms a frame and the engine step is
     * microseconds, so the two are unmistakable.
     */
    const records: TimingRecord[] = []
    const detach = timingHub.attach(
      { write: (record) => records.push(record) },
      { now: () => performance.now() },
    )
    const engine = engineFor()
    for (let i = 0; i < 8; i += 1) engine.frame(1 / 60)
    engine.dispose()
    detach()

    const spanOf = (name: string): number[] =>
      records
        .filter((record) => record.name === name)
        .map((record) => record.endMs - record.startMs)

    const periods = spanOf('frame')
    const steps = spanOf('engine')
    expect(periods).toHaveLength(7)
    expect(steps).toHaveLength(8)
    // Every period contains its frame's work rather than being it.
    for (const [i, period] of periods.entries()) {
      expect(period).toBeGreaterThanOrEqual(steps[i] ?? 0)
    }
    // And the periods tile: each begins where the previous one ended.
    const starts = records
      .filter((record) => record.name === 'frame')
      .map((record) => [record.startMs, record.endMs] as const)
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]?.[0]).toBe(starts[i - 1]?.[1])
    }
  })
})
