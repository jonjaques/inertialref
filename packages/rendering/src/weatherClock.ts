import type { Vec3 } from '@inertialref/spatial'

/*
 * Time and position reduced before they reach a shader (rule 58, plan §3).
 * A float32 holds a presentation instant to minutes and an absolute position
 * on Earth to half a meter, so nothing absolute enters a lattice: the field
 * reads reductions formed here in float64, and every lattice decision is
 * taken on integers (`periodIndex`).
 */

/**
 * The drift's period: the field slides for this long, then starts over (§5.4).
 * A change of `periodIndex(t, CLOUD_ADVECTION_PERIOD)` is a jump.
 */
export const CLOUD_ADVECTION_PERIOD = 3600

const notYet = (): never => {
  throw new Error('not yet: WP1')
}

/** frac(t / period), float64. */
export function reduceTurns(_t: number, _period: number): number {
  return notYet()
}

/** t mod period, in [0, period), float64. */
export function reduceSeconds(_t: number, _period: number): number {
  return notYet()
}

/** floor(t / period) as two uint32 halves, exact for |t| ≤ 3.2 × 10¹² s. */
export function periodIndex(
  _t: number,
  _period: number,
): readonly [low: number, high: number] {
  return notYet()
}

/** A body-fixed point reduced into [0, period) on each axis, float64. */
export function reducePoint(_point: Vec3, _periodMeters: number): Vec3 {
  return notYet()
}

/** velocity × (t mod CLOUD_ADVECTION_PERIOD), reduced into the noise's period, float64. */
export function driftOffset(
  _velocity: Vec3,
  _t: number,
  _periodMeters: number,
): Vec3 {
  return notYet()
}
