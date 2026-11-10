/*
 * The octave series' fitted constants: the higher orders as a few scaled
 * copies of first order, `Σ bⁱ·sun.octave(aⁱ)·p(ν; cⁱ)` for `i` from 1 to
 * `count − 1`, fitted to the slab oracle's higher-order radiance under
 * `b ≤ a`, with the error each fit leaves at the oracle's held-out points.
 *
 * **No fit is held.** `CLOUD_OCTAVES` is empty and `cloudOctavesPass` false,
 * so the march draws no octave branch.
 */

export interface CloudOctaveFit {
  /** Orders the series stands for, first order among them: 2, 3 or 4. */
  readonly count: 2 | 3 | 4
  /** An octave's extinction scale, its scattering scale, and its phase's asymmetry scale. */
  readonly a: number
  readonly b: number
  readonly c: number
  /** The fit's worst relative error in radiance at the held-out points. */
  readonly heldOutError: number
}

/** One fit a count, in order of count. */
export const CLOUD_OCTAVES: readonly CloudOctaveFit[] = []

/** The bound a fit's held-out error must be inside for the series to be drawn at all. */
export const CLOUD_OCTAVE_BOUND = 0.05

/** Whether any fit is inside the bound: what decides that the octave branch is built. */
export function cloudOctavesPass(
  fits: readonly CloudOctaveFit[] = CLOUD_OCTAVES,
): boolean {
  return fits.some((fit) => fit.heldOutError <= CLOUD_OCTAVE_BOUND)
}
