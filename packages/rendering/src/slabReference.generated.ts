/*
 * The slab oracle's reference rows: a plane slab's leaving radiance and
 * reflected flux on the true medium and on the scaled one, and the
 * black-surface reflected flux `R(τ, μ₀)` the calibration inverts.
 *
 * `rows` are one geometry each: an unscaled optical depth, a sun's cosine, a
 * view's cosine and azimuth from the sun, degrees, at a radius row, µm, with
 * the reflected radiance of each medium per unit of the sun's irradiance,
 * `scaled` and `truth`. `flux` is `R(τ, μ₀)` at each `depths[i]` for each of
 * `sunMus`, laid out [sun][depth].
 *
 * A stand-in: no row, and a flux of zero at one depth. A generator writes
 * this file from the slab oracle; rerun it rather than editing, then
 * `pnpm exec prettier -w` this file.
 */
export const SLAB_REFERENCE = {
  format: 'inertialref/slab-reference',
  version: 1,
  /** The largest relative difference in radiance between the two media over the rows. */
  scalingError: 0,
  rows: [] as readonly {
    readonly depth: number
    readonly sunMu: number
    readonly viewMu: number
    readonly azimuth: number
    readonly radius: number
    readonly scaled: readonly [number, number, number]
    readonly truth: readonly [number, number, number]
  }[],
  sunMus: [0.7, 0.4],
  depths: [0.1],
  flux: [0, 0],
} as const
