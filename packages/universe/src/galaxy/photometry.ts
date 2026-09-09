import { invariant, PARSEC } from '@inertialref/shared'

/** Masana et al. 2021 Table 2, Johnson V, Vega/STIS003 zero point. */
export const GALAXY_V_ZERO_RADIANCE = 143.1685
/** Willmer 2018, Johnson V solar absolute magnitude, Vega system. */
export const GALAXY_SOLAR_V_MAGNITUDE = 4.81
/** GAMBONS region ratios span 1.20–1.40. This fixed spectral approximation is explicit. */
export const GALAXY_PHOTOPIC_TO_V = 1.25
export const GALAXY_V_LUMINOUS_EFFICACY = 683 * GALAXY_PHOTOPIC_TO_V
const ARCSECOND_STERADIANS = (Math.PI / 648000) ** 2
export const GALAXY_SOLAR_V_WATTS =
  4 *
  Math.PI *
  (10 * PARSEC) ** 2 *
  GALAXY_V_ZERO_RADIANCE *
  ARCSECOND_STERADIANS *
  10 ** (-0.4 * GALAXY_SOLAR_V_MAGNITUDE)

export function galaxyVMagnitude(vNanowatts: number): number {
  invariant(
    Number.isFinite(vNanowatts) && vNanowatts >= 0,
    'V radiance must be finite and nonnegative',
  )
  return vNanowatts === 0
    ? Infinity
    : -2.5 * Math.log10((vNanowatts * 1e-9) / GALAXY_V_ZERO_RADIANCE)
}

/** RGB holds relative chromaticity with Johnson V radiance in green, not three band energies. */
export function galaxyDisplayRgb(
  rgb: readonly number[],
): readonly [number, number, number] {
  const [r = 0, g = 0, b = 0] = rgb
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const gain = y > 0 ? g / y : 0
  return [r * gain, g * gain, b * gain]
}
