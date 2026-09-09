import {
  GALAXY_SOLAR_V_WATTS,
  GALAXY_V_LUMINOUS_EFFICACY,
  GALAXY_V_ZERO_RADIANCE,
} from '@inertialref/universe'

/** Authored Enhanced response. The faint limit has no radiance or footprint floor. */
export const STAR_VISIBILITY = Object.freeze({
  brightMagnitude: -2,
  faintMagnitude: 10,
  maximumSize: 3.4,
  sizeExponent: 0.25,
  peakRadiance: 1.6,
})

/** Johnson V point-source zero point, with the same photopic conversion as the diffuse sky. */
export const STELLAR_V_ZERO_ILLUMINANCE =
  GALAXY_V_ZERO_RADIANCE * (Math.PI / 648000) ** 2 * GALAXY_V_LUMINOUS_EFFICACY

export function stellarVisualIlluminance(
  solarVisualLuminosities: number,
  distanceMeters: number,
): number {
  return (
    (solarVisualLuminosities *
      GALAXY_SOLAR_V_WATTS *
      GALAXY_V_LUMINOUS_EFFICACY) /
    (4 * Math.PI * Math.max(1, distanceMeters) ** 2)
  )
}

export function stellarVisualMagnitude(illuminance: number): number {
  return illuminance <= 0
    ? Infinity
    : -2.5 * Math.log10(illuminance / STELLAR_V_ZERO_ILLUMINANCE)
}

export function enhancedStarVisibility(apparentMagnitude: number): number {
  const amount = Math.max(
    0,
    Math.min(
      1,
      (STAR_VISIBILITY.faintMagnitude - apparentMagnitude) /
        (STAR_VISIBILITY.faintMagnitude - STAR_VISIBILITY.brightMagnitude),
    ),
  )
  return amount * amount * (3 - 2 * amount)
}
