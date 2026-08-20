import {
  type Kilograms,
  LIGHT_YEAR,
  type Meters,
  PARSEC,
  type Radians,
} from '@inertialref/shared'
import { astroToSim } from '@inertialref/physics'
import { fromMeters, type UniverseVector, vec3 } from '@inertialref/spatial'
import { type SystemId, systemId } from './address.ts'

/*
 * A small real star catalogue.
 *
 * The spec calls for real astronomy near the player and procedure everywhere
 * else, so these are the nearest well-known systems, hand-transcribed from
 * published ICRS positions and parallaxes. It is an abridgement, not a data
 * import: a Gaia/HYG ingest belongs in a worker task later, and the shape here
 * is chosen so that swapping the source does not change anything downstream.
 *
 * Known simplification: several of these are multiple-star systems (α Cen,
 * Sirius, Procyon, 61 Cyg). They are modelled as single stars for now, which
 * costs nothing structurally — a binary is two bodies in one system frame —
 * but would be wrong to present as fact, so `components` records the truth.
 */

/** Distance from the galactic centre to the Sun (Gravity Collaboration, 2019). */
export const SUN_GALACTOCENTRIC_RADIUS: Meters = 8_178 * PARSEC
/** The Sun sits slightly north of the galactic mid-plane. */
export const SUN_HEIGHT_ABOVE_PLANE: Meters = 20.8 * PARSEC

export interface CatalogStar {
  readonly id: SystemId
  readonly name: string
  /** Right ascension, ICRS, degrees. */
  readonly rightAscension: number
  /** Declination, ICRS, degrees. */
  readonly declination: number
  /** Distance from the Sun, light-years. */
  readonly distanceLightYears: number
  readonly spectralType: string
  /** Estimated mass in solar masses. */
  readonly solarMasses: number
  /** Number of stellar components; >1 means we are simplifying. */
  readonly components: number
}

export const CATALOG: readonly CatalogStar[] = [
  {
    id: systemId('SOL'),
    name: 'Sol',
    rightAscension: 0,
    declination: 0,
    distanceLightYears: 0,
    spectralType: 'G2V',
    solarMasses: 1,
    components: 1,
  },
  {
    id: systemId('HIP70890'),
    name: 'Proxima Centauri',
    rightAscension: 217.4289,
    declination: -62.6795,
    distanceLightYears: 4.2465,
    spectralType: 'M5.5Ve',
    solarMasses: 0.122,
    components: 1,
  },
  {
    id: systemId('HIP71683'),
    name: 'Alpha Centauri',
    rightAscension: 219.9021,
    declination: -60.834,
    distanceLightYears: 4.365,
    spectralType: 'G2V',
    solarMasses: 1.079,
    components: 2,
  },
  {
    id: systemId('HIP87937'),
    name: "Barnard's Star",
    rightAscension: 269.4521,
    declination: 4.6933,
    distanceLightYears: 5.9629,
    spectralType: 'M4.0V',
    solarMasses: 0.144,
    components: 1,
  },
  {
    id: systemId('HIP54035'),
    name: 'Lalande 21185',
    rightAscension: 165.8341,
    declination: 35.9699,
    distanceLightYears: 8.3044,
    spectralType: 'M2.0V',
    solarMasses: 0.39,
    components: 1,
  },
  {
    id: systemId('HIP32349'),
    name: 'Sirius',
    rightAscension: 101.2871,
    declination: -16.7161,
    distanceLightYears: 8.6094,
    spectralType: 'A1V',
    solarMasses: 2.063,
    components: 2,
  },
  {
    id: systemId('HIP92403'),
    name: 'Ross 154',
    rightAscension: 282.4557,
    declination: -23.8362,
    distanceLightYears: 9.7035,
    spectralType: 'M3.5V',
    solarMasses: 0.17,
    components: 1,
  },
  {
    id: systemId('HIP16537'),
    name: 'Epsilon Eridani',
    rightAscension: 53.2327,
    declination: -9.4583,
    distanceLightYears: 10.4753,
    spectralType: 'K2V',
    solarMasses: 0.82,
    components: 1,
  },
  {
    id: systemId('HIP114046'),
    name: 'Lacaille 9352',
    rightAscension: 346.4667,
    declination: -35.8533,
    distanceLightYears: 10.7241,
    spectralType: 'M0.5V',
    solarMasses: 0.479,
    components: 1,
  },
  {
    id: systemId('HIP57548'),
    name: 'Ross 128',
    rightAscension: 176.9375,
    declination: 0.8043,
    distanceLightYears: 11.0074,
    spectralType: 'M4.0V',
    solarMasses: 0.168,
    components: 1,
  },
  {
    id: systemId('HIP104214'),
    name: '61 Cygni',
    rightAscension: 316.7247,
    declination: 38.7495,
    distanceLightYears: 11.4031,
    spectralType: 'K5V',
    solarMasses: 0.7,
    components: 2,
  },
  {
    id: systemId('HIP37279'),
    name: 'Procyon',
    rightAscension: 114.8255,
    declination: 5.225,
    distanceLightYears: 11.4601,
    spectralType: 'F5IV-V',
    solarMasses: 1.499,
    components: 2,
  },
  {
    id: systemId('HIP8102'),
    name: 'Tau Ceti',
    rightAscension: 26.017,
    declination: -15.9375,
    distanceLightYears: 11.9124,
    spectralType: 'G8.5V',
    solarMasses: 0.783,
    components: 1,
  },
  {
    id: systemId('HIP19849'),
    name: '40 Eridani',
    rightAscension: 63.818,
    declination: -7.6528,
    distanceLightYears: 16.3355,
    spectralType: 'K0.5V',
    solarMasses: 0.84,
    components: 3,
  },
  {
    id: systemId('HIP97649'),
    name: 'Altair',
    rightAscension: 297.6958,
    declination: 8.8683,
    distanceLightYears: 16.73,
    spectralType: 'A7Vn',
    solarMasses: 1.79,
    components: 1,
  },
  {
    id: systemId('HIP91262'),
    name: 'Vega',
    rightAscension: 279.2347,
    declination: 38.7837,
    distanceLightYears: 25.04,
    spectralType: 'A0Va',
    solarMasses: 2.135,
    components: 1,
  },
  {
    id: systemId('HIP113368'),
    name: 'Fomalhaut',
    rightAscension: 344.4127,
    declination: -29.6222,
    distanceLightYears: 25.13,
    spectralType: 'A3Va',
    solarMasses: 1.92,
    components: 3,
  },
  {
    id: systemId('HIP37826'),
    name: 'Pollux',
    rightAscension: 116.329,
    declination: 28.0262,
    distanceLightYears: 33.78,
    spectralType: 'K0III',
    solarMasses: 1.91,
    components: 1,
  },
]

/* ------------------------------------------------------------------------- */
/* ICRS → galactic → universe coordinates                                     */
/* ------------------------------------------------------------------------- */

const DEG = Math.PI / 180
/** North galactic pole and the galactic longitude of the north celestial pole, ICRS. */
const NGP_RA = 192.85948 * DEG
const NGP_DEC = 27.12825 * DEG
const NCP_L = 122.93192 * DEG

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

/**
 * Position of a catalogue star in universe coordinates.
 *
 * The universe origin is the galactic centre, so the Sun lands 8.178 kpc out
 * rather than at zero. That is deliberate: an origin at the player's home
 * system would have to move the moment the game modelled anywhere else, and
 * every sector index would be a relative quantity pretending to be absolute.
 */
export function catalogStarPosition(star: CatalogStar): UniverseVector {
  const { l, b } = equatorialToGalactic(star.rightAscension, star.declination)
  const distance = star.distanceLightYears * LIGHT_YEAR

  // Heliocentric galactic Cartesian, +x toward the galactic centre.
  const hx = distance * Math.cos(b) * Math.cos(l)
  const hy = distance * Math.cos(b) * Math.sin(l)
  const hz = distance * Math.sin(b)

  // Shift onto the galactic centre, then swap into the simulation's Y-up axes.
  const galactocentric = vec3(
    hx - SUN_GALACTOCENTRIC_RADIUS,
    hy,
    hz + SUN_HEIGHT_ABOVE_PLANE,
  )
  const sim = astroToSim(galactocentric)
  return fromMeters(sim.x, sim.y, sim.z)
}

export const SOLAR_MASS_KG: Kilograms = 1.98847e30

export function findCatalogStar(id: SystemId): CatalogStar | undefined {
  return CATALOG.find((star) => star.id === id)
}
