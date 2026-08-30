import { describe, expect, it } from 'vitest'
import {
  getTimer,
  type Span,
  type TimingRecord,
  TimingHub,
  timingHub,
} from './timing.ts'

/*
 * The two claims `timing.ts` makes that are not visible in the code it produces
 * — "off costs nothing" and "a span hands nothing back" — plus the scope
 * composition it borrows from `Logger.child`.
 *
 * The recording sink is the pattern `log.test.ts` already uses for `LogSink`.
 */

const collect = (): {
  sink: { write(record: TimingRecord): void }
  records: TimingRecord[]
} => {
  const records: TimingRecord[] = []
  return { sink: { write: (record) => records.push(record) }, records }
}

/** A clock a test can advance by hand, so intervals are exact rather than close. */
const stepped = (): { now: () => number; advance: (ms: number) => void } => {
  let at = 0
  return {
    now: () => at,
    advance: (ms) => {
      at += ms
    },
  }
}

describe('the timing hub', () => {
  it('is off, and allocates nothing, until a sink attaches', () => {
    const hub = new TimingHub()
    const timer = hub.timer('game.engine')
    expect(timer.on).toBe(false)

    // The allocation claim, asserted by identity rather than by shape: a fresh
    // object per call would be garbage produced at frame rate by an instrument
    // that is switched off.
    const first: Span = timer.span('frame')
    const second: Span = timer.span('terrain.build')
    expect(first).toBe(second)

    // And nothing reaches a sink attached afterwards, because nothing was held.
    const { sink, records } = collect()
    hub.attach(sink, { now: () => 0 })
    first.end()
    second.end()
    expect(records).toEqual([])
  })

  it('reads `on` off the live hub rather than a value captured at construction', () => {
    /*
     * The failure this prevents is silent and total. A module-scope
     * `const timer = getTimer(…)` in the engine is constructed while the entry
     * point has not yet run — ES modules evaluate every static import to
     * completion first — so a captured boolean is `false` for the life of the
     * process and the instrumentation records nothing.
     */
    const hub = new TimingHub()
    const timer = hub.timer('game.engine')
    expect(timer.on).toBe(false)
    const detach = hub.attach(collect().sink, { now: () => 0 })
    expect(timer.on).toBe(true)
    detach()
    expect(timer.on).toBe(false)
  })

  it('refuses a sink with no clock', () => {
    const hub = new TimingHub()
    // A `() => 0` default is harmless on `PoolOptions.now`, where a stat reads
    // 0 ms and is obviously untimed. Here it stacks every entry at t=0, which
    // looks like a recording rather than like a missing argument.
    expect(() =>
      hub.attach(collect().sink, {
        now: undefined as unknown as () => number,
      }),
    ).toThrow(TypeError)
  })

  it('times a span against the host clock', () => {
    const hub = new TimingHub()
    const { sink, records } = collect()
    const clock = stepped()
    hub.attach(sink, { now: clock.now })

    const span = hub.timer('workers.pool').span('run', { track: 'Workers' })
    clock.advance(37)
    span.end()

    expect(records).toEqual([
      {
        kind: 'measure',
        scope: 'workers.pool',
        name: 'run',
        startMs: 0,
        endMs: 37,
        detail: { track: 'Workers' },
      },
    ])
  })

  it('emits a mark as an instant', () => {
    const hub = new TimingHub()
    const { sink, records } = collect()
    const clock = stepped()
    hub.attach(sink, { now: clock.now })
    clock.advance(119)
    hub.timer('game.boot').mark('first light')
    expect(records[0]?.kind).toBe('mark')
    expect(records[0]?.startMs).toBe(119)
    expect(records[0]?.endMs).toBe(119)
  })

  it('takes a measure from numbers the caller already has', () => {
    // The pattern to reach for everywhere both ends of an interval already
    // exist: no new clock read at all.
    const hub = new TimingHub()
    const { sink, records } = collect()
    hub.attach(sink, { now: () => 999 })
    hub.timer('game.engine').measure('frame', 4, 6.04)
    expect(records[0]?.startMs).toBe(4)
    expect(records[0]?.endMs).toBe(6.04)
  })

  it('closes a span once, however many times it is ended', () => {
    const hub = new TimingHub()
    const { sink, records } = collect()
    hub.attach(sink, { now: () => 0 })
    const span = hub.timer('a').span('b')
    span.end()
    span.end()
    expect(records).toHaveLength(1)
  })

  it('composes a child scope the way `Logger.child` does', () => {
    const hub = new TimingHub()
    const { sink, records } = collect()
    hub.attach(sink, { now: () => 0 })
    hub.timer('game').child('terrain').child('scatter').mark('slots')
    expect(records[0]?.scope).toBe('game.terrain.scatter')
  })

  it('records once across attach, emit, detach, emit', () => {
    const hub = new TimingHub()
    const { sink, records } = collect()
    const detach = hub.attach(sink, { now: () => 0 })
    const timer = hub.timer('game')
    timer.mark('one')
    detach()
    timer.mark('two')
    expect(records.map((record) => record.name)).toEqual(['one'])
  })

  it('leaves the process-wide hub off, so importing a package emits nothing', () => {
    // The property `log.ts` establishes and this file inherits. Asserted rather
    // than assumed, because every test in the suite imports through the barrel.
    expect(timingHub.on).toBe(false)
    expect(getTimer('anything').on).toBe(false)
  })

  it('gives a span no way to hand a duration back', () => {
    const hub = new TimingHub()
    const span = hub.timer('sim.world').span('advance')
    // The determinism invariant, as a type. `end(): number` would look helpful
    // and would make a canonical value a function of wall time — which is
    // AGENTS.md rule 2, and the whole reason this seam exists rather than a
    // direct `performance.mark`.
    // @ts-expect-error `Span.end` returns void, and that is the invariant.
    const held: number = span.end()
    expect(held).toBeUndefined()
  })
})
