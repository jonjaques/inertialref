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

/**
 * One constant-medium step inside a segment: light += through·source·(1 − e^−σℓ).
 *
 * The step's integral, ∫ T·σ·J ds over its length (§5.8), which telescopes:
 * a step split in two adds (1 − e^−τ₁) + e^−τ₁(1 − e^−τ₂) = 1 − e^−(τ₁+τ₂),
 * so neither the light nor the transmittance depends on how the march cut
 * the segment. The fraction is the largest the crossing met, never a mean.
 */
export function stepSegment(
  s: CloudSegment,
  fraction: number,
  sigma: number,
  source: number,
  length: number,
): CloudSegment {
  const tau = sigma * length
  const share = tau * stepShare(tau)
  return {
    fraction: Math.max(s.fraction, fraction),
    depth: s.depth + tau,
    through: s.through * Math.exp(-tau),
    light: s.light + s.through * source * share,
  }
}

/**
 * Close a segment behind what is in front: T = (1 − c) + c·e^−τ; the light enters as c·L.
 *
 * One mix a segment. A column is cloudy over its share c and clear over the
 * rest, and inside it every step shares the cloudy part, so the segment
 * passes the clear share untouched and the cloudy share through its whole
 * depth. Segments multiply: each is a different column or layer, overlapped
 * at random.
 */
export function closeSegment(
  front: { readonly transmittance: number; readonly light: number },
  s: CloudSegment,
): { readonly transmittance: number; readonly light: number } {
  const c = s.fraction
  return {
    transmittance: front.transmittance * (1 - c + c * s.through),
    light: front.light + front.transmittance * c * s.light,
  }
}

/** Where air.ts's series takes over from the quotient. */
const SERIES_BELOW = 0.01

/**
 * (1 − e^−τ)/τ with the series under τ = 0.01, as air.ts's `stepShare`.
 *
 * One term past the shader's. In float32 the series' first dropped term,
 * τ⁴/120, is below the arithmetic's own rounding; in float64 it is 8 × 10⁻¹¹
 * of a step at τ = 0.01, which would show through the 10⁻¹² a split segment
 * is held to. With τ⁴/120 kept the first dropped term is τ⁵/720, 1.4 × 10⁻¹³.
 * Above the series, `expm1` takes the quotient without the subtraction that
 * cancels near zero.
 */
export function stepShare(tau: number): number {
  if (tau < SERIES_BELOW)
    return 1 - tau / 2 + (tau * tau) / 6 - (tau ** 3 / 24 - tau ** 4 / 120)
  return -Math.expm1(-tau) / tau
}
