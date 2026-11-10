import type { Vec3 } from '@inertialref/spatial'

/*
 * Time and position reduced before they reach a shader (rule 58, plan §3).
 * A float32 holds a presentation instant to minutes and an absolute position
 * on Earth to half a meter, so nothing absolute enters a lattice: the field
 * reads reductions formed here in float64, and every lattice decision is
 * taken on integers (`periodIndex`).
 *
 * Every reduction goes through one quotient, `split`, so an index and its
 * remainder always agree. Formed apart, a remainder can round up to the
 * period itself while the index says that period has not ended, and the two
 * then name instants a whole period apart. For a whole-second period both
 * are exact: the product of the index and the period is an integer, and the
 * remainder is a difference on the instant's own grid.
 *
 * The floor of the rounded quotient needs no correction for such a period.
 * An instant under k·period has a true quotient more than half a float step
 * under k — exactly half only for a power-of-two period, whose quotient is
 * exact — so rounding never carries it up to k; a search of 18 million
 * instants one step under a multiple found none that it did.
 */

/**
 * The drift's period: the field slides for this long, then starts over (§5.4).
 * A change of `periodIndex(t, CLOUD_ADVECTION_PERIOD)` is a jump.
 */
export const CLOUD_ADVECTION_PERIOD = 3600

const TWO_32 = 0x1_0000_0000

interface Quotient {
  readonly index: number
  readonly remainder: number
}

/**
 * floor(t / period) and t − index·period, with 0 ≤ remainder < period.
 *
 * The one rounding that can break the range is the remainder's own: an
 * instant a subnormal step under zero leaves period − 5 × 10⁻³²⁴, whose
 * nearest float64 is the period itself, and that is the next period's start.
 * A period that is not a positive number is a pattern that never moves on:
 * index 0, remainder 0.
 */
function split(t: number, period: number): Quotient {
  if (!(period > 0) || !Number.isFinite(period) || !Number.isFinite(t))
    return { index: 0, remainder: 0 }
  const index = Math.floor(t / period)
  const remainder = t - index * period
  return remainder >= period
    ? { index: index + 1, remainder: 0 }
    : { index, remainder: Math.max(0, remainder) }
}

/** frac(t / period), float64. */
export function reduceTurns(t: number, period: number): number {
  const { remainder } = split(t, period)
  if (remainder === 0) return 0
  // The quotient of the largest remainder under the period can round to one
  // turn, which is the same angle as none.
  const turns = remainder / period
  return turns < 1 ? turns : 0
}

/** t mod period, in [0, period), float64. */
export function reduceSeconds(t: number, period: number): number {
  return split(t, period).remainder
}

/**
 * floor(t / period) as two uint32 halves, exact for |t| ≤ 3.2 × 10¹² s.
 *
 * Two's complement over 64 bits, so an instant before the epoch keeps its
 * own index rather than folding onto the one after it: −1 is
 * (0xFFFFFFFF, 0xFFFFFFFF). The halves are what a shader hashes, as uints.
 */
export function periodIndex(
  t: number,
  period: number,
): readonly [low: number, high: number] {
  const { index } = split(t, period)
  const high = Math.floor(index / TWO_32)
  return [index - high * TWO_32, high >>> 0]
}

/** A body-fixed point reduced into [0, period) on each axis, float64. */
export function reducePoint(point: Vec3, periodMeters: number): Vec3 {
  return {
    x: split(point.x, periodMeters).remainder,
    y: split(point.y, periodMeters).remainder,
    z: split(point.z, periodMeters).remainder,
  }
}

/** velocity × (t mod CLOUD_ADVECTION_PERIOD), reduced into the noise's period, float64. */
export function driftOffset(
  velocity: Vec3,
  t: number,
  periodMeters: number,
): Vec3 {
  const seconds = reduceSeconds(t, CLOUD_ADVECTION_PERIOD)
  return reducePoint(
    {
      x: velocity.x * seconds,
      y: velocity.y * seconds,
      z: velocity.z * seconds,
    },
    periodMeters,
  )
}

const greatestDivisor = (a: number, b: number): number => {
  let x = a
  let y = b
  while (y !== 0) [x, y] = [y, x % y]
  return x
}

/**
 * The shortest length every one of `periods` divides, in whole meters: what
 * one reduced origin can be reduced by and stay right for every layer.
 *
 * A noise read at (origin + offset)/period stays on its lattice only when the
 * origin was reduced by a multiple of that layer's period. Two layers of
 * different cells share one `noiseOrigin`, so reducing by either cell's
 * period alone would slide the other's noise by the difference each time the
 * eye crossed a boundary. Each period is rounded to the meter first: the
 * scenarios' cells are whole meters, and their multiples stay small —
 * `cirrus-over-cumulus`'s 1,200 m and 5,000 m cells come to 240 km of base
 * period, where a float32 position still resolves 1.6 cm. Zero for no periods.
 * A period that is not finite has no lattice to hold and is left out: the
 * divisor's remainder of one is NaN, which never reaches the zero it ends on.
 */
export function commonPeriod(periods: readonly number[]): number {
  let common = 0
  for (const period of periods) {
    if (!Number.isFinite(period)) continue
    const whole = Math.max(1, Math.round(period))
    common =
      common === 0 ? whole : (common / greatestDivisor(common, whole)) * whole
  }
  return common
}
