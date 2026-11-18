/*
 * The octave series' fitted constants: the higher orders as a few scaled
 * copies of first order, `Σ bⁱ·sun.octave(aⁱ)·p(ν; cⁱ)` for `i` from 1 to
 * `count − 1`, with `p(ν; cⁱ)` a Henyey–Greenstein phase of asymmetry
 * `cⁱ·g′`, fitted to the slab oracle's radiance on the reference's grid
 * slabs under `b ≤ a`, with the worst relative error each fit leaves at the
 * oracle's held-out slabs.
 *
 * The constants are written by `node apps/ingest/src/transport/octaveFit.ts`
 * from `slabReference.generated.ts`; rerun it rather than editing them, then
 * `pnpm exec prettier -w` this file. On the grid the fits' worst errors are
 * 98.8% at 2 orders, 97.8% at 3 orders, 96.9% at 4 orders.
 *
 * **No fit is inside the bound.** `cloudOctavesPass` is false, so the march
 * draws no octave branch.
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
export const CLOUD_OCTAVES: readonly CloudOctaveFit[] = [
  { count: 2, a: 0.0234, b: 0.0234, c: 0.1252, heldOutError: 0.9826 },
  { count: 3, a: 0.127, b: 0.127, c: 0.2894, heldOutError: 0.9752 },
  { count: 4, a: 0.202, b: 0.202, c: 0.4186, heldOutError: 0.9668 },
]

/** The bound a fit's held-out error must be inside for the series to be drawn at all. */
export const CLOUD_OCTAVE_BOUND = 0.05

/** Whether any fit is inside the bound: what decides that the octave branch is built. */
export function cloudOctavesPass(
  fits: readonly CloudOctaveFit[] = CLOUD_OCTAVES,
): boolean {
  return fits.some((fit) => fit.heldOutError <= CLOUD_OCTAVE_BOUND)
}
