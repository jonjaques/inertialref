import {
  GALAXY_SOLAR_V_WATTS,
  GALAXY_V_LUMINOUS_EFFICACY,
  GALAXY_V_ZERO_RADIANCE,
} from '@inertialref/universe'
import { SURFACE_LUMINANCE } from './exposure.ts'

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

/**
 * How the sky in front of a star raises the faintest magnitude that shows.
 *
 * Two operating points of the eye fix it: about magnitude 6.5 under a moonless
 * sky of 2 × 10⁻⁴ cd/m², and about −4 — Venus, never Sirius — under a clear
 * day sky of 5,000 cd/m². Between them the threshold illuminance grows as the
 * background to the 0.59, which is `slope` — fitted to the difference, since
 * the loss is counted from a vacuum and the night sky already costs 0.44 of
 * it. Enhanced's own faint limit is deeper than the eye's, and the same loss
 * is taken from it, so a noon sky leaves nothing standing and twilight lets
 * the brightest back first.
 */
export const SKY_VISIBILITY = Object.freeze({
  /** The moonless night sky, in scene units. */
  night: 2e-4 / SURFACE_LUMINANCE,
  slope: 0.59,
})

/** Magnitudes lost to a sky of `luminance` scene units; zero in a vacuum. */
export function skyMagnitudeLoss(luminance: number): number {
  return (
    2.5 *
    SKY_VISIBILITY.slope *
    Math.log10(1 + Math.max(luminance, 0) / SKY_VISIBILITY.night)
  )
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
