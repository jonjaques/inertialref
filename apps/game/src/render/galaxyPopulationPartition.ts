import { LUMINOSITY_BANDS } from '@inertialref/universe'

/** Above this threshold every covered luminosity band is entirely unresolved. */
export function coveredLuminosityCeiling(levelMask: number): number {
  let maximum = 0
  for (const band of LUMINOSITY_BANDS)
    if ((levelMask & (1 << band.level)) !== 0)
      maximum = Math.max(maximum, band.maxSolarV)
  return maximum
}
