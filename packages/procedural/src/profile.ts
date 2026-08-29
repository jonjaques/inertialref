/*
 * Scalar profile primitives.
 *
 * The shapes a feature field is written out of: a crater's rim and floor, a
 * shield volcano's flank, a rift's shoulder and a scarp's face are all a radial
 * distance run through two or three of these. They live here rather than beside
 * the geology because none of them knows what a crater is, and because a TSL
 * port of the band stack needs exactly this list with `Fn` around it.
 *
 * Every one is C1 at both ends — the value and the slope both land on zero at
 * the edge of a feature's support. That is not tidiness: a feature that stops
 * with a slope discontinuity draws a visible ring at its own radius, and one
 * whose *value* does not reach zero draws a step at it. Both survive into the
 * normals, which is where they become obvious.
 */

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

export const clamp01 = (value: number): number => clamp(value, 0, 1)

export const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** Hermite step, C1 at both ends. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * A radial falloff: 1 at the center, 0 at `t = 1`, flat at both.
 *
 * The apron every feature fades out through. `(1 - t²)²` rather than
 * `1 - smoothstep`, because the square keeps the shoulder wide and the tail
 * short, which is what an ejecta blanket and a volcanic flank both look like.
 */
export function falloff(t: number): number {
  if (t >= 1) return 0
  const s = 1 - t * t
  return s * s
}

/**
 * A ring: 0 at the center, 1 at `t = peak`, 0 at `t = 1`.
 *
 * A crater rim in one call. Written as two smoothsteps rather than a
 * trigonometric bump because the inner and outer widths differ — a rim rises
 * fast off the floor and falls away slowly into the ejecta — and a symmetric
 * bump cannot say that.
 */
export function ring(t: number, peak: number): number {
  if (t <= 0 || t >= 1) return 0
  return t < peak ? smoothstep(0, peak, t) : 1 - smoothstep(peak, 1, t)
}
