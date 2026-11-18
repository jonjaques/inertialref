import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@inertialref/spatial'
import {
  bodyPointOf,
  CLOUD_ADVECTION_PERIOD,
  commonPeriod,
  driftOffset,
  latticeOrigin,
  periodIndex,
  reducePoint,
  reduceSeconds,
  reduceTurns,
  turnBack,
} from './weatherClock.ts'

/*
 * The reductions are what keeps an absolute instant and an absolute position
 * out of every shader, so they are held to exact arithmetic rather than to a
 * tolerance: a float64 instant is an integer times a power of two, and its
 * quotient and remainder by a whole-second period follow in BigInt with no
 * rounding at all. Out to the design's limit of 3.2 × 10¹² s, where one
 * float64 step of the instant is 4.9 × 10⁻⁴ s.
 */

const LIMIT = 3.2e12

/** A float64 as mantissa × 2^exponent, exactly. */
function binary(value: number): {
  readonly mantissa: bigint
  readonly exponent: number
} {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  const sign = bits >> 63n === 1n ? -1n : 1n
  const biased = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & ((1n << 52n) - 1n)
  return biased === 0
    ? { mantissa: sign * fraction, exponent: -1074 }
    : { mantissa: sign * (fraction | (1n << 52n)), exponent: biased - 1075 }
}

const floorDivide = (a: bigint, b: bigint): bigint => {
  const q = a / b
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q
}

/**
 * floor(t / period) and the remainder, exactly, for a whole-second period,
 * the remainder then rounded once to the nearest float64.
 *
 * A remainder whose nearest float64 is the period itself — an instant a few
 * subnormal steps under zero, period − 5 × 10⁻³²⁴ — is the start of the next
 * period, which is the convention the clock states: [0, period) holds, and
 * the index moves up with it.
 */
function exactly(
  t: number,
  period: number,
): { readonly index: bigint; readonly remainder: number } {
  const { mantissa, exponent } = binary(t)
  const scale = exponent < 0 ? 1n << BigInt(-exponent) : 1n
  const numerator = exponent < 0 ? mantissa : mantissa << BigInt(exponent)
  const divisor = BigInt(period) * scale
  const index = floorDivide(numerator, divisor)
  const rest = numerator - index * divisor
  // Past 2¹⁰²⁴ the BigInt's own conversion overflows, which only the period
  // less a subnormal reaches; it rounds to the period.
  const rounded = Number(rest) * 2 ** Math.min(0, exponent)
  const remainder = Number.isFinite(rounded) ? rounded : period
  return remainder >= period
    ? { index: index + 1n, remainder: 0 }
    : { index, remainder }
}

const instant = fc.double({
  min: -LIMIT,
  max: LIMIT,
  noNaN: true,
  noDefaultInfinity: true,
})
const wholePeriod = fc.constantFrom(1, 60, 3600, 7200, 86_400, 86_164)

describe('the weather clock', () => {
  it('reduces an instant by a whole-second period exactly, out to 3.2 × 10¹² s', () => {
    fc.assert(
      fc.property(instant, wholePeriod, (t, period) => {
        const reduced = reduceSeconds(t, period)
        expect(reduced).toBe(exactly(t, period).remainder)
        expect(reduced).toBeGreaterThanOrEqual(0)
        expect(reduced).toBeLessThan(period)
      }),
      { numRuns: 5000 },
    )
  })

  it('stays exact on either side of a period boundary at the limit', () => {
    /*
     * The quotient t/period rounds, and it is at an exact multiple, one float
     * step either side of it, that a floor of the rounded quotient lands a
     * whole period off. These are the instants a sweep at random would almost
     * never draw.
     */
    for (const period of [1, 3600, 7200]) {
      const top = Math.floor(LIMIT / period)
      for (const index of [top, top - 1, 1, 0, -1, -top]) {
        const boundary = index * period
        for (const t of [
          boundary,
          nextDown(boundary),
          nextUp(boundary),
          boundary + 1e-3,
          boundary - 1e-3,
        ]) {
          const truth = exactly(t, period)
          expect(reduceSeconds(t, period)).toBe(truth.remainder)
          const [low, high] = periodIndex(t, period)
          expect(signed64(low, high)).toBe(truth.index)
        }
      }
    }
  })

  it('splits the period index into two uint32 halves that round-trip', () => {
    fc.assert(
      fc.property(instant, wholePeriod, (t, period) => {
        const [low, high] = periodIndex(t, period)
        expect(Number.isInteger(low) && low >= 0 && low < 2 ** 32).toBe(true)
        expect(Number.isInteger(high) && high >= 0 && high < 2 ** 32).toBe(true)
        expect(signed64(low, high)).toBe(exactly(t, period).index)
      }),
      { numRuns: 5000 },
    )
  })

  it('gives the turn as the reduced seconds over the period, under one', () => {
    fc.assert(
      fc.property(instant, wholePeriod, (t, period) => {
        const turns = reduceTurns(t, period)
        expect(turns).toBeGreaterThanOrEqual(0)
        expect(turns).toBeLessThan(1)
        expect(turns).toBeCloseTo(reduceSeconds(t, period) / period, 15)
      }),
    )
  })

  it('holds a pattern that never redraws in period 0', () => {
    for (const period of [0, -5, Number.NaN, Infinity]) {
      expect(periodIndex(1234.5, period)).toEqual([0, 0])
      expect(reduceSeconds(1234.5, period)).toBe(0)
      expect(reduceTurns(1234.5, period)).toBe(0)
    }
  })

  it('reduces a point into [0, period) on each axis, congruent to it', () => {
    const coordinate = fc.double({
      min: -1e8,
      max: 1e8,
      noNaN: true,
      noDefaultInfinity: true,
    })
    fc.assert(
      fc.property(
        coordinate,
        coordinate,
        coordinate,
        fc.constantFrom(4000, 9600, 72_000, 240_000),
        (x, y, z, period) => {
          const reduced = reducePoint({ x, y, z }, period)
          for (const [value, input] of [
            [reduced.x, x],
            [reduced.y, y],
            [reduced.z, z],
          ] as const) {
            expect(value).toBeGreaterThanOrEqual(0)
            expect(value).toBeLessThan(period)
            expect(value).toBe(exactly(input, period).remainder)
          }
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('drifts by the wind times the hour so far, never more than an hour of it', () => {
    const speed = fc.double({ min: -50, max: 50, noNaN: true })
    const drifts = fc.property(
      speed,
      speed,
      speed,
      fc.double({ min: 0, max: LIMIT, noNaN: true }),
      fc.constantFrom(9600, 72_000, 240_000),
      (vx, vy, vz, t, period) => {
        const drift = driftOffset({ x: vx, y: vy, z: vz }, t, period)
        const seconds = reduceSeconds(t, CLOUD_ADVECTION_PERIOD)
        expect(seconds).toBeLessThan(CLOUD_ADVECTION_PERIOD)
        // The displacement the drift stands for is the wind times the
        // seconds into the hour, so it is bounded by an hour of the wind.
        // `hypot` rounds the speed to half a float step, which is relative
        // for a normal speed and absolute for a subnormal one: two
        // components of 5 × 10⁻³²⁴ m/s have a speed of 7 × 10⁻³²⁴ that
        // rounds to 5 × 10⁻³²⁴, while the displacement, formed from the
        // components times the seconds, keeps its √2. The bound carries a
        // whole subnormal step of speed through the hour.
        const speedTotal = Math.hypot(vx, vy, vz)
        expect(
          Math.hypot(vx * seconds, vy * seconds, vz * seconds),
        ).toBeLessThanOrEqual(
          speedTotal * CLOUD_ADVECTION_PERIOD * (1 + 1e-12) +
            Number.MIN_VALUE * CLOUD_ADVECTION_PERIOD,
        )
        for (const [value, velocity] of [
          [drift.x, vx],
          [drift.y, vy],
          [drift.z, vz],
        ] as const) {
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThan(period)
          expect(value).toBe(reduceSeconds(velocity * seconds, period))
        }
      },
    )
    fc.assert(drifts, {
      numRuns: 2000,
      // The shrunk case the seed below found in a full check: a wind of two
      // subnormal components, where the bound itself was wrong.
      examples: [[0, 5e-324, -5e-324, 1_888_303_345.5, 9600]],
    })
    // That run, replayed whole: the regression is the seed's, not one case.
    fc.assert(drifts, { numRuns: 2000, seed: -779636656 })
  })

  it('moves the drift continuously inside an hour, by the wind times the interval', () => {
    /*
     * The reduction into the noise's period wraps the drift by whole periods,
     * which the noise cannot see; the shortest way round the torus is what
     * the field actually moved, and inside one advection period that is the
     * wind times the interval.
     */
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.integer({ min: 0, max: 888_888_888 }),
        fc.double({ min: 0, max: 3599, noNaN: true }),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        (speed, hour, into, step) => {
          const period = 72_000
          const t = hour * CLOUD_ADVECTION_PERIOD + into
          const later = t + step
          fc.pre(
            Math.floor(later / CLOUD_ADVECTION_PERIOD) ===
              Math.floor(t / CLOUD_ADVECTION_PERIOD),
          )
          const a = driftOffset({ x: speed, y: 0, z: 0 }, t, period).x
          const b = driftOffset({ x: speed, y: 0, z: 0 }, later, period).x
          const moved =
            ((((b - a) % period) + 1.5 * period) % period) - period / 2
          // The instant's own float64 step at 3.2e12 s is 4.9e-4 s.
          expect(Math.abs(moved - speed * (later - t))).toBeLessThan(
            Math.abs(speed) * 1e-3 + 1e-6,
          )
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('finds the least period every layer divides', () => {
    expect(commonPeriod([9600, 40_000])).toBe(240_000)
    expect(commonPeriod([14_400, 8000])).toBe(72_000)
    expect(commonPeriod([9600])).toBe(9600)
    expect(commonPeriod([])).toBe(0)
    // A period that is no number is left out, in either place: Euclid's
    // remainder of one is NaN, and the loop that waits for zero never ends.
    expect(commonPeriod([Number.NaN, 9600, 40_000])).toBe(240_000)
    expect(commonPeriod([9600, Infinity, 40_000])).toBe(240_000)
    expect(commonPeriod([Number.NaN])).toBe(0)
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5000 }), {
          minLength: 1,
          maxLength: 3,
        }),
        (periods) => {
          const common = commonPeriod(periods)
          for (const period of periods) expect(common % period).toBe(0)
          // Least: no proper divisor of it is a multiple of every period.
          for (const period of periods) {
            const smaller = common / period
            expect(Number.isInteger(smaller)).toBe(true)
          }
          for (let divisor = 2; divisor <= 7; divisor += 1) {
            if (common % divisor !== 0) continue
            const less = common / divisor
            expect(periods.every((p) => less % p === 0)).toBe(false)
          }
        },
      ),
    )
  })
})

/*
 * A level's noise frame (phase 1 design §5.3): a body-fixed point turned
 * back about the pole by the level's turn and slid along it by the drift,
 * reduced by the noise's period. The lattice coordinate a shader forms is
 * the reduced origin of the eye plus the turned offset from it, so the
 * property that matters is that two eyes give one point one coordinate.
 */
describe('a level’s noise frame', () => {
  /** Earth's radius and a little: every eye and point the field is drawn at. */
  const reach = 6.5e6
  const coordinate = fc.double({ min: -reach, max: reach, noNaN: true })
  const point = fc.record({ x: coordinate, y: coordinate, z: coordinate })
  const angle = fc.double({
    min: 0,
    max: 2 * Math.PI,
    maxExcluded: true,
    noNaN: true,
  })
  /** A quarter of a meter a second, out to the clock's limit. */
  const drift = fc.double({
    min: -0.25 * LIMIT,
    max: 0.25 * LIMIT,
    noNaN: true,
  })
  const period = fc.integer({ min: 1000, max: 240_000 })

  const turned = (m: readonly number[], v: Vec3): Vec3 => ({
    x: m[0]! * v.x + m[1]! * v.y + m[2]! * v.z,
    y: m[3]! * v.x + m[4]! * v.y + m[5]! * v.z,
    z: m[6]! * v.x + m[7]! * v.y + m[8]! * v.z,
  })
  /** How far `a` is from `b` once whole periods are taken out, meters. */
  const offPeriod = (a: number, b: number, p: number): number => {
    const turns = (a - b) / p
    return Math.abs(turns - Math.round(turns)) * p
  }

  it('turns a point back about the pole: the matrix is the rotation the origin takes', () => {
    fc.assert(
      fc.property(point, angle, period, (p, a, wrap) => {
        const m = turnBack(a)
        const reduced = latticeOrigin(p, a, 0, wrap)
        const exact = turned(m, p)
        // A float64 rotation of a point 6,500 km out is good to 2 × 10⁻⁹ m;
        // the bound is a thousand of those.
        for (const axis of ['x', 'y', 'z'] as const) {
          expect(reduced[axis]).toBeGreaterThanOrEqual(0)
          expect(reduced[axis]).toBeLessThan(wrap)
          expect(offPeriod(reduced[axis], exact[axis], wrap)).toBeLessThan(2e-6)
        }
        // About +Y and nothing else: the pole's height is untouched, and the
        // turn is the angle's sense, R_y(−a) taking +X toward +Z.
        expect(m.slice(3, 6)).toEqual([0, 1, 0])
        expect(turned(m, { x: 1, y: 0, z: 0 }).z).toBeCloseTo(Math.sin(a), 15)
      }),
    )
  })

  it('gives one body point one lattice coordinate from any two eyes', () => {
    fc.assert(
      fc.property(point, point, angle, drift, period, (a, b, turn, d, wrap) => {
        // The point the two eyes look at: within 2,000 km of the first.
        const target = {
          x: a.x + (b.x - a.x) * 0.3,
          y: a.y + (b.y - a.y) * 0.3,
          z: a.z + (b.z - a.z) * 0.3,
        }
        const m = turnBack(turn)
        const read = (eye: Vec3): Vec3 => {
          const origin = latticeOrigin(eye, turn, d, wrap)
          const offset = turned(m, {
            x: target.x - eye.x,
            y: target.y - eye.y,
            z: target.z - eye.z,
          })
          return {
            x: origin.x + offset.x,
            y: origin.y + offset.y,
            z: origin.z + offset.z,
          }
        }
        const fromA = read(a)
        const fromB = read(b)
        for (const axis of ['x', 'y', 'z'] as const)
          expect(offPeriod(fromA[axis], fromB[axis], wrap)).toBeLessThan(1e-5)
      }),
      { numRuns: 2000 },
    )
  })

  it('finds a lattice point on the body where the turn and the drift put it', () => {
    fc.assert(
      fc.property(point, angle, drift, (p, a, d) => {
        const m = turnBack(a)
        const lattice = turned(m, p)
        const slid = { ...lattice, y: lattice.y + d }
        const back = bodyPointOf(slid, a, d)
        // The drift's own rounding at its size, and the rotation's at the radius.
        const bound = 4e-9 * reach + 2 ** -52 * Math.abs(d) * 4
        for (const axis of ['x', 'y', 'z'] as const)
          expect(Math.abs(back[axis] - p[axis])).toBeLessThan(bound)
      }),
    )
  })

  it('carries a lattice point east under a positive turn: right-handed about the pole', () => {
    // The spin evaluator's pole is +Y and a body turns right-handed about it,
    // so east at +X is −Z: a quarter turn carries the point there, as a
    // westerly wind carries a cloud.
    const start = bodyPointOf({ x: reach, y: 0, z: 0 }, 0, 0)
    const later = bodyPointOf({ x: reach, y: 0, z: 0 }, Math.PI / 2, 0)
    expect(start.x).toBe(reach)
    expect(later.x).toBeCloseTo(0, 6)
    expect(later.z).toBeCloseTo(-reach, 6)
  })
})

function nextUp(value: number): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigInt64(0)
  if (value === 0) return Number.MIN_VALUE
  view.setBigInt64(0, value > 0 ? bits + 1n : bits - 1n)
  return view.getFloat64(0)
}

function nextDown(value: number): number {
  return -nextUp(-value)
}

/** The 64-bit two's complement index the halves spell. */
function signed64(low: number, high: number): bigint {
  const unsigned = (BigInt(high) << 32n) | BigInt(low)
  return unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned
}
