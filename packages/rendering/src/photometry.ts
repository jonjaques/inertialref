import { AU, SOLAR_LUMINOSITY, SOLAR_RADIUS } from '@inertialref/shared'
import { SOLAR_LUMINANCE } from './exposure.ts'

/** Solar-calibrated visible-light estimates; catalog luminosities are bolometric. */
export const sunlightAt = (luminosity: number, distance: number): number =>
  (luminosity / SOLAR_LUMINOSITY) * (AU / Math.max(1, distance)) ** 2

export const stellarLuminance = (luminosity: number, radius: number): number =>
  ((SOLAR_LUMINANCE * luminosity) / SOLAR_LUMINOSITY) *
  (SOLAR_RADIUS / Math.max(1, radius)) ** 2

/** Illuminance of an unresolved disk, in lux. Distance survives the shell projection here. */
export const stellarIlluminance = (
  solarLuminosities: number,
  distance: number,
): number =>
  SOLAR_LUMINANCE *
  Math.PI *
  solarLuminosities *
  (SOLAR_RADIUS / Math.max(1, distance)) ** 2
