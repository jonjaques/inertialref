/*
 * The segment bookkeeping the trace's shader is held to: maximum-random
 * overlap (plan §3). A segment is one layer's crossing of one column; inside
 * it every step shares the column's largest fraction, and segments multiply.
 * Mixing per step instead counts a half-clear layer twice — at τ 20, crossed
 * in two steps, it passes a quarter of the light where it passes half.
 */

export interface CloudSegment {
  /** The largest fraction the crossing met. */
  readonly fraction: number
  /** In-cloud optical depth so far. */
  readonly depth: number
  /** e^−depth. */
  readonly through: number
  /** In-cloud light per unit source, accumulated. */
  readonly light: number
}

/** A segment nothing has entered: clear, transmitting everything, unlit. */
export const OPEN_SEGMENT: CloudSegment = {
  fraction: 0,
  depth: 0,
  through: 1,
  light: 0,
}

const notYet = (): never => {
  throw new Error('not yet: WP1')
}

/** One constant-medium step inside a segment: light += through·source·(1 − e^−σℓ). */
export function stepSegment(
  _s: CloudSegment,
  _fraction: number,
  _sigma: number,
  _source: number,
  _length: number,
): CloudSegment {
  return notYet()
}

/** Close a segment behind what is in front: T = (1 − c) + c·e^−τ; the light enters as c·L. */
export function closeSegment(
  _front: { readonly transmittance: number; readonly light: number },
  _s: CloudSegment,
): { readonly transmittance: number; readonly light: number } {
  return notYet()
}

/** (1 − e^−τ)/τ with the series under τ = 0.01, as air.ts's `stepShare`. */
export function stepShare(_tau: number): number {
  return notYet()
}
