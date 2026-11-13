import { SUN_FACTOR } from './sunFactor.generated.ts'
import type { CloudGenus } from './weatherScenario.ts'

/*
 * How the product reads `SUN_FACTOR`: the two numbers a level's cumuliform
 * genus carries into its uniforms, and the factor they make on the CPU.
 * The light after first order multiplies the source its node returns by
 *
 *   c = 1 + v·(l·(1 + a·√(1 − μ₀²)/μ₀) − 1),   μ₀ = max(|sunMu|, 0.05),
 *
 * with v the convective share the step holds. It is never applied to first
 * order or to the sky, and it does not know which side of the eye the sun
 * stands: that is a ray's number and not a level's, and it bought 0.01 in
 * the logarithm's RMS where the generator measured it.
 */

/** A genus's two numbers: c = l·(1 + a·cot e) at a convective share of one. */
export interface SunFactorPair {
  readonly l: number
  readonly a: number
}

/** The pair of a genus no fit has been committed for: a factor of one at every sun. */
export const SUN_FACTOR_NONE: SunFactorPair = /*@__PURE__*/ Object.freeze({
  l: 1,
  a: 0,
})

/** The sun's cosine the factor takes, as the source table's read floors it. */
export const SUN_FACTOR_FLOOR = 0.05

/**
 * A genus's committed pair, or `SUN_FACTOR_NONE`. A stratiform genus takes
 * none, and so does a cumuliform one the generator has not fitted: a
 * cumulus's numbers leave a tower +112% to +133% under a high sun.
 */
export function sunFactorPair(genus: CloudGenus): SunFactorPair {
  const pairs: Readonly<Partial<Record<CloudGenus, SunFactorPair>>> =
    SUN_FACTOR.pairs
  return pairs[genus] ?? SUN_FACTOR_NONE
}

/**
 * The factor at a convective share `convective` and a sun at `sunMu`, the
 * sun's cosine to the local vertical. Exactly one at a share of zero, for
 * any sun: `1 + 0·x` is one for every finite `x`, and the floor keeps `x`
 * finite.
 */
export function sunFactor(
  pair: SunFactorPair,
  convective: number,
  sunMu: number,
): number {
  const mu = Math.max(Math.abs(sunMu), SUN_FACTOR_FLOOR)
  const lean = Math.sqrt(Math.max(0, 1 - mu * mu)) / mu
  return 1 + convective * (pair.l * (1 + pair.a * lean) - 1)
}
