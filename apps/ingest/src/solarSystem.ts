import type { PackedPlanet } from '@inertialref/universe'

/*
 * The Solar System, by hand.
 *
 * The NASA Exoplanet Archive contains exoplanets, and the eight planets orbiting
 * the star the player starts at are not among them. Without this the game's home
 * system is entirely projected — eight invented worlds around a real Sun — which
 * is the one place where every player can check the answer and every player
 * would find it wrong.
 *
 * Elements are J2000 osculating values from JPL's planetary fact sheets. The
 * argument of perihelion is given rather than the longitude of perihelion, to
 * match what the exoplanet archive publishes and what `OrbitalElements` wants.
 *
 * Inclinations are not carried, for the same reason they are not carried for
 * exoplanets: the generator scatters a system's planets around its own reference
 * plane, and the ecliptic *is* that plane here, so every value would be within a
 * couple of degrees of zero anyway.
 *
 * The letters are the issue ordinals, assigned outward. For every other system
 * the letters come from discovery order, which for the Solar System would put
 * Uranus and Neptune after Saturn and the other six in no defined order at all —
 * "known since antiquity" is not a sequence. Outward is a real order, and it is
 * stable, which is the only property the ordinal has to have.
 */
const LETTERS = 'bcdefghi'

interface SolarPlanet {
  readonly name: string
  readonly semiMajorAxisAu: number
  readonly eccentricity: number
  readonly orbitalPeriodDays: number
  readonly massEarths: number
  readonly radiusEarths: number
  /** Argument of perihelion, degrees. */
  readonly argumentOfPeriapsisDeg: number
  /** Equilibrium (not surface) temperature, Kelvin — the same quantity the archive publishes. */
  readonly equilibriumTemperature: number
  readonly discoveryYear: number
}

const PLANETS: readonly SolarPlanet[] = [
  {
    name: 'Mercury',
    semiMajorAxisAu: 0.387_098_93,
    eccentricity: 0.205_630_69,
    orbitalPeriodDays: 87.969,
    massEarths: 0.055_3,
    radiusEarths: 0.382_9,
    argumentOfPeriapsisDeg: 29.124,
    equilibriumTemperature: 440,
    discoveryYear: 0,
  },
  {
    name: 'Venus',
    semiMajorAxisAu: 0.723_331_99,
    eccentricity: 0.006_773_23,
    orbitalPeriodDays: 224.701,
    massEarths: 0.815,
    radiusEarths: 0.949_9,
    argumentOfPeriapsisDeg: 54.884,
    equilibriumTemperature: 232,
    discoveryYear: 0,
  },
  {
    name: 'Earth',
    semiMajorAxisAu: 1.000_000_11,
    eccentricity: 0.016_710_22,
    orbitalPeriodDays: 365.256,
    massEarths: 1,
    radiusEarths: 1,
    argumentOfPeriapsisDeg: 114.207_83,
    equilibriumTemperature: 255,
    discoveryYear: 0,
  },
  {
    name: 'Mars',
    semiMajorAxisAu: 1.523_662_31,
    eccentricity: 0.093_412_33,
    orbitalPeriodDays: 686.98,
    massEarths: 0.107,
    radiusEarths: 0.532,
    argumentOfPeriapsisDeg: 286.502,
    equilibriumTemperature: 210,
    discoveryYear: 0,
  },
  {
    name: 'Jupiter',
    semiMajorAxisAu: 5.203_363_01,
    eccentricity: 0.048_392_66,
    orbitalPeriodDays: 4_332.589,
    massEarths: 317.83,
    radiusEarths: 11.209,
    argumentOfPeriapsisDeg: 273.867,
    equilibriumTemperature: 110,
    discoveryYear: 0,
  },
  {
    name: 'Saturn',
    semiMajorAxisAu: 9.537_070_32,
    eccentricity: 0.054_150_6,
    orbitalPeriodDays: 10_759.22,
    massEarths: 95.16,
    radiusEarths: 9.449,
    argumentOfPeriapsisDeg: 339.392,
    equilibriumTemperature: 81,
    discoveryYear: 0,
  },
  {
    name: 'Uranus',
    semiMajorAxisAu: 19.191_263_93,
    eccentricity: 0.047_167_71,
    orbitalPeriodDays: 30_685.4,
    massEarths: 14.536,
    radiusEarths: 4.007,
    argumentOfPeriapsisDeg: 98.999,
    equilibriumTemperature: 58,
    discoveryYear: 1781,
  },
  {
    name: 'Neptune',
    semiMajorAxisAu: 30.068_963_48,
    eccentricity: 0.008_585_87,
    orbitalPeriodDays: 60_189,
    massEarths: 17.147,
    radiusEarths: 3.883,
    argumentOfPeriapsisDeg: 276.336,
    equilibriumTemperature: 47,
    discoveryYear: 1846,
  },
]

/** The eight, as packed planets orbiting star index `host`. */
export const solarSystemPlanets = (host: number): readonly PackedPlanet[] =>
  PLANETS.map((planet, index) => ({
    host,
    letter: LETTERS[index] as string,
    name: planet.name,
    semiMajorAxisAu: planet.semiMajorAxisAu,
    orbitalPeriodDays: planet.orbitalPeriodDays,
    eccentricity: planet.eccentricity,
    inclinationDeg: null,
    argumentOfPeriapsisDeg: planet.argumentOfPeriapsisDeg,
    massEarths: planet.massEarths,
    massIsLowerBound: false,
    radiusEarths: planet.radiusEarths,
    equilibriumTemperature: planet.equilibriumTemperature,
    // Inverse square from the semi-major axis, Earth = 1. Derived rather than
    // transcribed because it is derivable, and a transcription can disagree with
    // the axis it sits next to.
    insolation: 1 / planet.semiMajorAxisAu ** 2,
    discoveryYear: planet.discoveryYear,
    discoveryMethod: 'Direct Observation' as const,
    circumbinary: false,
  }))
