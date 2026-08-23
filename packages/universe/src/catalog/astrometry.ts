import { type Meters, PARSEC, type Radians } from '@inertialref/shared'
import { astroToSim } from '@inertialref/physics'
import { fromMeters, type UniverseVector, vec3 } from '@inertialref/spatial'

/*
 * Getting a published position into the universe's coordinates.
 *
 * Catalogs publish equatorial coordinates — right ascension and declination
 * on a sky centered on the Earth, tilted by the Earth's axis, at an epoch. None
 * of that is a fact about the galaxy; all of it is a fact about where the
 * observation was made from. Three changes of basis get from there to a
 * universe coordinate, and each is done exactly once, here:
 *
 *   ICRS equatorial → galactic     a fixed rotation; the plane becomes the disk
 *   heliocentric    → galactocentric   a translation of 8.178 kpc
 *   +Z up (astronomy) → +Y up (sim)    `physics/frameConvention.ts`
 */

/** Distance from the galactic center to the Sun (Gravity Collaboration, 2019). */
export const SUN_GALACTOCENTRIC_RADIUS: Meters = 8_178 * PARSEC
/** The Sun sits slightly north of the galactic mid-plane. */
export const SUN_HEIGHT_ABOVE_PLANE: Meters = 20.8 * PARSEC

const DEG = Math.PI / 180
/** North galactic pole and the galactic longitude of the north celestial pole, ICRS. */
const NGP_RA = 192.859_48 * DEG
const NGP_DEC = 27.128_25 * DEG
const NCP_L = 122.931_92 * DEG

export interface GalacticCoordinates {
  /** Galactic longitude, radians. */
  readonly l: Radians
  /** Galactic latitude, radians. */
  readonly b: Radians
}

/** Standard ICRS-to-galactic rotation. */
export function equatorialToGalactic(
  rightAscensionDeg: number,
  declinationDeg: number,
): GalacticCoordinates {
  const ra = rightAscensionDeg * DEG
  const dec = declinationDeg * DEG
  const sinB =
    Math.sin(dec) * Math.sin(NGP_DEC) +
    Math.cos(dec) * Math.cos(NGP_DEC) * Math.cos(ra - NGP_RA)
  const b = Math.asin(Math.min(1, Math.max(-1, sinB)))
  const y = Math.cos(dec) * Math.sin(ra - NGP_RA)
  const x =
    Math.sin(dec) * Math.cos(NGP_DEC) -
    Math.cos(dec) * Math.sin(NGP_DEC) * Math.cos(ra - NGP_RA)
  const l = NCP_L - Math.atan2(y, x)
  return { l: ((l % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), b }
}

/** Heliocentric galactic spherical coordinates to heliocentric cartesian, +x inward. */
export function galacticToCartesian(
  { l, b }: GalacticCoordinates,
  distance: Meters,
): { x: Meters; y: Meters; z: Meters } {
  return {
    x: distance * Math.cos(b) * Math.cos(l),
    y: distance * Math.cos(b) * Math.sin(l),
    z: distance * Math.sin(b),
  }
}

/**
 * Heliocentric galactic cartesian meters to a universe coordinate.
 *
 * The universe origin is the galactic center, so the Sun lands 8.178 kpc out
 * rather than at zero. That is deliberate: an origin at the player's home system
 * would have to move the moment the game modeled anywhere else, and every
 * sector index would be a relative quantity pretending to be absolute.
 */
export function heliocentricToUniverse(
  x: Meters,
  y: Meters,
  z: Meters,
): UniverseVector {
  const galactocentric = vec3(
    x - SUN_GALACTOCENTRIC_RADIUS,
    y,
    z + SUN_HEIGHT_ABOVE_PLANE,
  )
  const sim = astroToSim(galactocentric)
  return fromMeters(sim.x, sim.y, sim.z)
}

/** The Sun's own universe position — the origin of every published catalog. */
export const SUN_POSITION: UniverseVector = heliocentricToUniverse(0, 0, 0)
