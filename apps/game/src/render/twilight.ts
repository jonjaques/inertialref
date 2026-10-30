import type { Node } from 'three/webgpu'
import { exp, float, saturate } from 'three/tsl'

/**
 * How much of the day's skylight is left with the sun at `incidence` — its
 * cosine against local up — for the ground's sky term and the sea's
 * reflection of it, both of which ramp it from `horizon` at sunset.
 *
 * Above the horizon the ramp is the linear one the day was tuned on. Below
 * it, a linear ramp reached zero only around −14°, and at the end of civil
 * dusk still gave the ground a sixth of the day's sky: at a fixed exposure
 * that was a dim floor nobody saw, and once Enhanced opens the exposure for a
 * darkening sky it was a desert lit pale orange under a black zenith.
 * Measured, a clear sky puts 10 to 25 klx of skylight on the ground by day,
 * 3.4 lx at −6° and 0.008 lx at −12°; against the middle of the day's range,
 * 17 klx, and continuing from the ramp's own sunset value,
 * e^(66·incidence) gives 1.3 times the first and 0.6 times the second, while
 * the angle is small enough to be its own sine.
 */
export function skylightLeft(
  incidence: Node<'float'>,
  horizon: number,
): Node<'float'> {
  return incidence
    .greaterThanEqual(0)
    .select(
      saturate(incidence.add(horizon)),
      float(horizon).mul(exp(incidence.mul(66))),
    )
}
