import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { BodyWeather } from './weatherClimate.ts'
import {
  cloudFieldAt,
  columnDepth,
  fieldClock,
  fieldLevel,
} from './weatherField.ts'

/*
 * The field's clock, which is whole, and the field's shape. The clock is
 * held without a body: a weather is its rates, and the clock reads nothing
 * else of it.
 */

const TURN = 2 * Math.PI

const weatherAt = (
  turn: readonly [number, number, number],
  drift = 0.25,
): BodyWeather => ({
  seed: { hi: 1, lo: 2 } as unknown as BodyWeather['seed'],
  datumRadius: 6_371_000,
  levels: [
    { base: 1000, top: 2400, stratiform: 'cumulus', cumuliform: 'cumulus' },
    { base: 4000, top: 4800, stratiform: 'cirrus', cumuliform: 'cirrus' },
    { base: 4800, top: 4800, stratiform: 'stratus', cumuliform: 'stratus' },
  ],
  climate: {
    kind: 'regime',
    sample: () => ({
      cover: [0.5, 0.5, 0],
      convective: [1, 0, 0],
      ice: 1,
      deep: 0,
    }),
  },
  turn,
  drift,
})

/** A wind of up to 100 m/s on a body from 500 km to Jupiter's radius, either way. */
const rate = fc
  .tuple(
    fc.double({ min: -100, max: 100, noNaN: true }),
    fc.double({ min: 5e5, max: 7e7, noNaN: true }),
  )
  .map(([wind, radius]) => wind / radius)

describe('the field’s clock', () => {
  it('reduces each level’s turn into [0, 2π), ten years either side of the epoch', () => {
    fc.assert(
      fc.property(
        rate,
        rate,
        rate,
        fc.double({ min: -3.2e8, max: 3.2e8, noNaN: true }),
        (a, b, c, time) => {
          const { turn } = fieldClock(weatherAt([a, b, c]), time)
          for (const angle of turn) {
            expect(angle).toBeGreaterThanOrEqual(0)
            expect(angle).toBeLessThan(TURN)
          }
        },
      ),
    )
  })

  it('is the rate times the time, on the circle', () => {
    fc.assert(
      fc.property(
        rate,
        fc.double({ min: -3.2e8, max: 3.2e8, noNaN: true }),
        (omega, time) => {
          const [angle] = fieldClock(weatherAt([omega, 0, 0]), time).turn
          // The two agree as points of the circle: a turn reduced first is
          // the more exact, so the bound is the unreduced product's own
          // rounding, a few float64 steps of its size.
          const product = omega * time
          const apart = Math.abs(Math.sin((angle - product) / 2) * 2)
          expect(apart).toBeLessThanOrEqual(
            8 * Number.EPSILON * Math.max(1, Math.abs(product)),
          )
        },
      ),
    )
  })

  it('moves by the turn’s own step from one frame to the next, with no restart at any instant', () => {
    fc.assert(
      fc.property(
        rate,
        fc.double({ min: 0, max: 3.2e8, noNaN: true }),
        (omega, time) => {
          const step = 1 / 60
          const before = fieldClock(weatherAt([omega, 0, 0]), time).turn[0]
          const after = fieldClock(weatherAt([omega, 0, 0]), time + step)
            .turn[0]
          const moved = Math.abs(Math.sin((after - before - omega * step) / 2))
          // Each reduction rounds once at the size of a turn's period over
          // the instant; an hourly restart would be a step of radians.
          expect(moved).toBeLessThanOrEqual(1e-9)
        },
      ),
    )
  })

  it('holds still for a level that does not turn, and carries the drift and the instant unreduced', () => {
    const clock = fieldClock(weatherAt([0, 1e-6, -1e-6], 0.25), 86_400)
    expect(clock.turn[0]).toBe(0)
    expect(clock.turn[1]).toBeCloseTo(0.0864, 12)
    expect(clock.turn[2]).toBeCloseTo(TURN - 0.0864, 12)
    expect(clock.drift).toBe(21_600)
    expect(clock.time).toBe(86_400)
  })
})

describe('the field’s shape', () => {
  const weather = weatherAt([0, 0, 0])
  const clock = fieldClock(weather, 0)
  const sun = { x: 0, y: 1, z: 0 }
  const up = (height: number) => ({
    x: 0,
    y: weather.datumRadius + height,
    z: 0,
  })

  it('finds a point’s level by its height over the datum, base in and top out', () => {
    expect(fieldLevel(weather, 999)).toBe(-1)
    expect(fieldLevel(weather, 1000)).toBe(0)
    expect(fieldLevel(weather, 2399)).toBe(0)
    expect(fieldLevel(weather, 2400)).toBe(-1)
    expect(fieldLevel(weather, 4400)).toBe(1)
    // An absent level has no thickness and holds no height.
    expect(fieldLevel(weather, 4800)).toBe(-1)
    expect(cloudFieldAt(weather, clock, sun, up(1500), 50).level).toBe(0)
    expect(cloudFieldAt(weather, clock, sun, up(3000), 50).level).toBe(-1)
  })

  it('answers every point and column with a sample and a depth that are finite', () => {
    const sample = cloudFieldAt(weather, clock, sun, up(1500), 50)
    for (const value of Object.values(sample))
      expect(Number.isFinite(value)).toBe(true)
    expect(sample.fraction).toBeGreaterThanOrEqual(0)
    expect(sample.fraction).toBeLessThanOrEqual(1)
    expect(sample.sigma).toBeGreaterThanOrEqual(0)
    expect(columnDepth(weather, clock, sun, sun, 0)).toBeGreaterThanOrEqual(0)
  })
})
