import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { HeldTime, MAX_TIME_SCALE, TIME_LIMIT } from './heldTime.ts'

const instant = fc.double({
  min: -TIME_LIMIT,
  max: TIME_LIMIT,
  noNaN: true,
})
const rate = fc.double({
  min: Number.MIN_VALUE,
  max: MAX_TIME_SCALE,
  noNaN: true,
})
const seconds = fc.double({ min: -1e6, max: 1e9, noNaN: true })

describe('the held instant', () => {
  it('is the live clock until something is held, and again after release', () => {
    let live = 42
    const clock = new HeldTime(() => live)
    expect(clock.time).toBe(42)
    expect(clock.heldTime).toBeNull()
    live = 43
    expect(clock.time).toBe(43)
    clock.set(1_000)
    expect(clock.time).toBe(1_000)
    clock.set(null)
    expect(clock.time).toBe(43)
    expect(clock.heldTime).toBeNull()
  })

  it('starts paused at a rate of one', () => {
    const clock = new HeldTime(() => 0)
    expect(clock.paused).toBe(true)
    expect(clock.scale).toBe(1)
  })

  it('pauses on every set, held or released', () => {
    fc.assert(
      fc.property(fc.option(instant), (time) => {
        const clock = new HeldTime(() => 0)
        clock.setPaused(false)
        clock.set(time)
        return clock.paused && clock.heldTime === time
      }),
    )
  })

  it('release lets go of the instant and nothing else', () => {
    const clock = new HeldTime(() => 7)
    clock.set(100)
    clock.setPaused(false)
    clock.setScale(60)
    clock.release()
    expect(clock.time).toBe(7)
    expect(clock.paused).toBe(false)
    expect(clock.scale).toBe(60)
  })

  it('refuses an instant past the limit or not a number, and keeps the one it had', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .double({ min: TIME_LIMIT, noNaN: true })
            .filter((t) => t > TIME_LIMIT),
          fc
            .double({ max: -TIME_LIMIT, noNaN: true })
            .filter((t) => t < -TIME_LIMIT),
          fc.constantFrom(Number.NaN, Infinity, -Infinity),
        ),
        (time) => {
          const clock = new HeldTime(() => 0)
          clock.set(5)
          expect(() => clock.set(time)).toThrow(/100,000 years/)
          return clock.heldTime === 5
        },
      ),
    )
    // The limit itself is an instant.
    const clock = new HeldTime(() => 0)
    clock.set(TIME_LIMIT)
    clock.set(-TIME_LIMIT)
    expect(clock.heldTime).toBe(-TIME_LIMIT)
  })

  it('takes a rate in (0, 100000] and refuses the rest', () => {
    fc.assert(
      fc.property(rate, (scale) => {
        const clock = new HeldTime(() => 0)
        clock.setScale(scale)
        return clock.scale === scale
      }),
    )
    for (const bad of [0, -1, MAX_TIME_SCALE * 1.0001, Number.NaN, Infinity]) {
      const clock = new HeldTime(() => 0)
      expect(() => clock.setScale(bad)).toThrow(/rate/)
      expect(clock.scale).toBe(1)
    }
  })
})

describe('advancing the held instant', () => {
  it('moves by presented seconds times the rate, never backward', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: 1, max: 100, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        (start, scale, dt) => {
          const clock = new HeldTime(() => 0)
          clock.set(start)
          clock.setScale(scale)
          clock.setPaused(false)
          clock.advance(dt)
          expect(clock.heldTime).toBe(start + Math.max(0, dt) * scale)
          expect(clock.heldTime!).toBeGreaterThanOrEqual(start)
        },
      ),
    )
  })

  it('pauses at the limit rather than overflowing, whatever it is asked', () => {
    fc.assert(
      fc.property(instant, rate, seconds, (start, scale, dt) => {
        const clock = new HeldTime(() => 0)
        clock.set(start)
        clock.setScale(scale)
        clock.setPaused(false)
        clock.advance(dt)
        const held = clock.heldTime!
        expect(Math.abs(held)).toBeLessThanOrEqual(TIME_LIMIT)
        // Either it moved where it was told, or it stopped where it was.
        if (held !== start + Math.max(0, dt) * scale) {
          expect(held).toBe(start)
          expect(clock.paused).toBe(true)
        }
      }),
    )
  })

  it('does nothing while paused or released', () => {
    fc.assert(
      fc.property(instant, seconds, (start, dt) => {
        const paused = new HeldTime(() => 0)
        paused.set(start)
        paused.advance(dt)
        const released = new HeldTime(() => 9)
        released.setPaused(false)
        released.advance(dt)
        return paused.heldTime === start && released.time === 9
      }),
    )
  })
})
