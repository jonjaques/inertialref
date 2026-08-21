import {
  AU,
  EARTH_MASS,
  type Kelvin,
  type Kilograms,
  type Meters,
  type Radians,
  type Seconds,
  SECONDS_PER_DAY,
} from '@inertialref/shared'
import type { BodyKind } from '../system.ts'
import type { LinearRgb } from '../catalog/photometry.ts'

/*
 * The Solar System, as measured.
 *
 * Everything here is a published value from the NASA/JPL planetary fact sheets
 * and the JPL Solar System Dynamics small-body and satellite tables. It is not a
 * dataset under a licence — these are facts, transcribed — which is why it lives
 * in source rather than in the packed catalogue beside the exoplanets.
 *
 * It exists because Sol is **home**. Every other system in the game is a real
 * star with projected planets around it; this is the one place where the whole
 * system is known, the player has seen photographs of it, and a generated
 * substitute would be immediately and embarrassingly wrong.
 *
 * ## What is here and what is not
 *
 * Eight planets and twenty moons — every satellite large enough to have pulled
 * itself round, plus Phobos and Deimos because Mars would look empty without
 * them. The rest of the ~300 known moons are irregular captured rubble a
 * kilometre or two across, invisible from anywhere you would fly, and would cost
 * more to model than they could ever return.
 *
 * ## Units
 *
 * SI, per the repository convention, converted here from the kilometres, days
 * and degrees the fact sheets publish. Sidereal rotation periods are **signed**:
 * a negative period is retrograde, which is a fact about Venus, Uranus and
 * Triton and not a bug.
 *
 * ## Epoch
 *
 * Orbital elements are J2000 osculating values. Mean anomalies are not
 * published consistently across satellites, so they are derived from the body's
 * own seed at generation time — the *shape* of every orbit is real, and where a
 * moon happens to be along it on a given tick is not something the player can
 * check.
 */

export interface SolarAtmosphere {
  /** Surface pressure, pascals. Zero for a body with no atmosphere. */
  readonly surfacePressure: number
  /** Scale height, metres. */
  readonly scaleHeight: Meters
  /** Where the model stops integrating, metres above the datum. */
  readonly ceiling: Meters
  /** Mass density at the datum, kg/m³. */
  readonly surfaceDensity: number
}

export interface SolarRings {
  readonly innerRadius: Meters
  readonly outerRadius: Meters
  readonly opticalDepth: number
  readonly texture: string | null
}

/**
 * The haze you can see, with its published colours.
 *
 * Earth's limb is blue and its terminator orange because Rayleigh scattering in
 * nitrogen says so. Mars's is butterscotch because it is suspended dust. Titan's
 * is orange all the way round because it is tholins. None of these is a style
 * choice; what is licensed is how vividly they are rendered, not the hue.
 */
export interface SolarHaze {
  readonly height: Meters
  readonly colour: LinearRgb
  readonly limb: LinearRgb
}

export interface SolarClouds {
  readonly altitude: Meters
  readonly rotationPeriod: Seconds
  readonly opacity: number
}

export interface SolarBody {
  readonly name: string
  readonly kind: BodyKind
  /** Equatorial radius. */
  readonly radius: Meters
  /** Polar radius. Equal to `radius` for a body with no measured flattening. */
  readonly polarRadius: Meters
  readonly mass: Kilograms
  /** Sidereal rotation period. Negative is retrograde. */
  readonly rotationPeriod: Seconds
  /** Obliquity to the orbit, radians. */
  readonly axialTilt: Radians
  /** Semi-major axis about the parent. */
  readonly semiMajorAxis: Meters
  readonly eccentricity: number
  /** Inclination to the parent's equator (moons) or the ecliptic (planets). */
  readonly inclination: Radians
  /** Argument of periapsis, radians. */
  readonly argumentOfPeriapsis: Radians
  /** Geometric albedo. */
  readonly geometricAlbedo: number
  /** Mean surface or 1-bar temperature, kelvin. */
  readonly temperature: Kelvin
  /** Texture-set key, or null where no map has been vendored. */
  readonly texture: string | null
  /**
   * Linear-sRGB tint applied to the albedo map, or the whole surface without one.
   *
   * Not decoration. The USGS Voyager and Galileo mosaics for Europa, Ganymede
   * and Callisto are **monochrome** — measured: zero saturation across all three
   * — because that is how those cameras returned them. Rendering them grey would
   * be a different lie from tinting them: the colours here are the published
   * ones, and the map supplies the structure it actually has.
   */
  readonly tint: LinearRgb
  /** Peak-to-trough relief the elevation map covers, metres. */
  readonly relief: Meters
  readonly roughness: number
  readonly atmosphere: SolarAtmosphere | null
  readonly haze: SolarHaze | null
  readonly clouds: SolarClouds | null
  readonly rings: SolarRings | null
  /** Discovery year; 0 for the six known since antiquity. */
  readonly discoveryYear: number
  readonly moons: readonly SolarBody[]
}

/** No tint: the map already carries whatever colour the body has. */
const WHITE: LinearRgb = { r: 1, g: 1, b: 1 }

const KM: Meters = 1_000
const DEG = Math.PI / 180
const DAY = SECONDS_PER_DAY
const HOUR = 3_600

/** Nothing above the surface worth integrating through. */
const AIRLESS = null

/* ------------------------------------------------------------------------- */
/* Moons                                                                      */
/* ------------------------------------------------------------------------- */

/*
 * A moon's inclination and argument of periapsis are relative to its planet's
 * equator, and the regular satellites are all within a degree or two of it —
 * which is the fact worth reproducing. Iapetus at 15° and Triton at 157°
 * (retrograde, captured) are the exceptions, and they are exactly the ones that
 * look wrong if flattened to zero.
 */
const moon = (
  name: string,
  radiusKm: number,
  massKg: number,
  axisKm: number,
  periodDays: number,
  albedo: number,
  options: Partial<SolarBody> = {},
): SolarBody => ({
  name,
  kind: 'moon',
  radius: radiusKm * KM,
  polarRadius: radiusKm * KM,
  mass: massKg,
  // Every one of these is tidally locked, which is why the same face of the
  // Moon has been pointed at us for four billion years. Synchronous rotation is
  // the rule for a close satellite, not a coincidence.
  rotationPeriod: periodDays * DAY,
  axialTilt: 0,
  semiMajorAxis: axisKm * KM,
  eccentricity: 0,
  inclination: 0,
  argumentOfPeriapsis: 0,
  geometricAlbedo: albedo,
  temperature: 100,
  texture: null,
  tint: WHITE,
  relief: 8_000,
  roughness: 0.95,
  atmosphere: AIRLESS,
  haze: null,
  clouds: null,
  rings: null,
  discoveryYear: 0,
  moons: [],
  ...options,
})

const LUNA = moon('Luna', 1_737.4, 7.342e22, 384_400, 27.321_661, 0.136, {
  eccentricity: 0.0549,
  inclination: 5.145 * DEG,
  // 19.2 km from Selenean summit to the South Pole–Aitken floor, which is what
  // the LOLA elevation map spans.
  relief: 19_200,
  temperature: 250,
  texture: 'luna',
})

const GALILEANS: readonly SolarBody[] = [
  moon('Io', 1_821.6, 8.931_9e22, 421_800, 1.769_138, 0.63, {
    eccentricity: 0.0041,
    inclination: 0.05 * DEG,
    temperature: 110,
    relief: 17_000,
    texture: 'io',
    // Sulphur and sulphur dioxide frost. The most colourful surface in the
    // system, returned by Galileo as a monochrome mosaic.
    tint: { r: 1, g: 0.82, b: 0.5 },
  }),
  moon('Europa', 1_560.8, 4.799_8e22, 671_100, 3.551_181, 0.67, {
    eccentricity: 0.009,
    inclination: 0.47 * DEG,
    temperature: 102,
    relief: 1_000,
    // Ice, not rock. A smoother surface than anything else in the system, which
    // is why it is the brightest.
    roughness: 0.55,
    texture: 'europa',
    tint: { r: 1, g: 0.95, b: 0.87 },
  }),
  moon('Ganymede', 2_634.1, 1.481_9e23, 1_070_400, 7.154_553, 0.43, {
    eccentricity: 0.0013,
    inclination: 0.2 * DEG,
    temperature: 110,
    relief: 3_000,
    roughness: 0.8,
    texture: 'ganymede',
    tint: { r: 0.95, g: 0.89, b: 0.8 },
  }),
  moon('Callisto', 2_410.3, 1.075_9e23, 1_882_700, 16.689_017, 0.17, {
    eccentricity: 0.0074,
    inclination: 0.19 * DEG,
    temperature: 134,
    relief: 5_000,
    texture: 'callisto',
    tint: { r: 0.92, g: 0.85, b: 0.76 },
  }),
]

const SATURNIAN: readonly SolarBody[] = [
  moon('Mimas', 198.2, 3.749e19, 185_540, 0.942_422, 0.962, {
    eccentricity: 0.0196,
    inclination: 1.574 * DEG,
    temperature: 64,
    relief: 10_000,
    roughness: 0.7,
  }),
  moon('Enceladus', 252.1, 1.080_2e20, 237_950, 1.370_218, 1.375, {
    eccentricity: 0.0047,
    inclination: 0.009 * DEG,
    temperature: 75,
    relief: 2_000,
    // The most reflective body in the Solar System: fresh water ice, resurfaced
    // continuously by its own south-polar plumes. A geometric albedo above 1 is
    // not an error — it is what strong backscatter from ice does.
    roughness: 0.4,
    // No vendored map. Fresh water ice, resurfaced by its own plumes — the
    // whitest surface in the Solar System, and a tint is a truer account of it
    // than a map of somewhere else would be.
    tint: { r: 0.97, g: 0.98, b: 1 },
  }),
  moon('Tethys', 531.1, 6.174_9e20, 294_670, 1.887_802, 1.229, {
    eccentricity: 0.0001,
    inclination: 1.12 * DEG,
    temperature: 86,
    relief: 6_000,
    roughness: 0.5,
  }),
  moon('Dione', 561.4, 1.095_2e21, 377_420, 2.736_915, 0.998, {
    eccentricity: 0.0022,
    inclination: 0.019 * DEG,
    temperature: 87,
    relief: 4_000,
    roughness: 0.5,
  }),
  moon('Rhea', 763.8, 2.306_5e21, 527_070, 4.517_5, 0.949, {
    eccentricity: 0.001,
    inclination: 0.345 * DEG,
    temperature: 76,
    relief: 5_000,
    roughness: 0.5,
  }),
  moon('Titan', 2_574.7, 1.345_2e23, 1_221_870, 15.945, 0.22, {
    eccentricity: 0.0288,
    inclination: 0.34854 * DEG,
    temperature: 94,
    relief: 700,
    roughness: 0.6,
    // No vendored map: the surface is not visible through the haze anyway, and
    // the haze is what every photograph before Cassini's radar shows.
    tint: { r: 0.88, g: 0.62, b: 0.3 },
    // The only moon with a real atmosphere, and it is denser at the surface than
    // Earth's. Drawn as an opaque orange haze, because that is what every
    // photograph of it before Cassini showed.
    atmosphere: {
      surfacePressure: 146_700,
      scaleHeight: 21_000,
      ceiling: 600_000,
      surfaceDensity: 5.4,
    },
    // Tholins: orange looking down and orange looking along, which is why Titan
    // is a featureless orange ball in every image taken in visible light.
    haze: {
      height: 400_000,
      colour: { r: 0.86, g: 0.6, b: 0.3 },
      limb: { r: 0.95, g: 0.7, b: 0.35 },
    },
    // Opaque, and drawn from the tint rather than a map: Titan is a featureless
    // orange ball to anything but radar.
    clouds: { altitude: 200_000, rotationPeriod: 15.945 * DAY, opacity: 0.95 },
  }),
  moon('Iapetus', 734.5, 1.805_9e21, 3_560_840, 79.321_5, 0.05, {
    eccentricity: 0.0283,
    // 15° to Saturn's equator, far out of the ring plane — which is why it is
    // the one moon from which the rings are visible as anything but a line.
    inclination: 15.47 * DEG,
    temperature: 110,
    relief: 20_000,
    // Two-toned: one hemisphere as dark as asphalt, the other as bright as snow,
    // which no single tint can say. Until a map is vendored this is the dark
    // side, which is the half that faces the direction it is travelling.
    tint: { r: 0.4, g: 0.34, b: 0.28 },
  }),
]

const URANIAN: readonly SolarBody[] = [
  moon('Miranda', 235.8, 6.4e19, 129_390, 1.413_479, 0.32, {
    eccentricity: 0.0013,
    inclination: 4.232 * DEG,
    temperature: 60,
    // A 20 km cliff — Verona Rupes, the tallest known in the Solar System.
    relief: 20_000,
  }),
  moon('Ariel', 578.9, 1.251e21, 190_900, 2.520_379, 0.53, {
    eccentricity: 0.0012,
    inclination: 0.26 * DEG,
    temperature: 60,
    relief: 4_000,
    roughness: 0.6,
  }),
  moon('Umbriel', 584.7, 1.275e21, 266_000, 4.144_177, 0.26, {
    eccentricity: 0.0039,
    inclination: 0.128 * DEG,
    temperature: 75,
    relief: 5_000,
  }),
  moon('Titania', 788.4, 3.4e21, 436_300, 8.705_872, 0.35, {
    eccentricity: 0.0011,
    inclination: 0.34 * DEG,
    temperature: 70,
    relief: 5_000,
  }),
  moon('Oberon', 761.4, 3.076e21, 583_500, 13.463_234, 0.31, {
    eccentricity: 0.0014,
    inclination: 0.058 * DEG,
    temperature: 75,
    relief: 11_000,
  }),
]

/* ------------------------------------------------------------------------- */
/* Planets                                                                    */
/* ------------------------------------------------------------------------- */

export const SOLAR_PLANETS: readonly SolarBody[] = [
  {
    name: 'Mercury',
    tint: { r: 1, g: 0.97, b: 0.92 },
    kind: 'rocky',
    radius: 2_439.7 * KM,
    polarRadius: 2_439.7 * KM,
    mass: 3.3011e23,
    // 58.6 days — locked 3:2 to its 88-day year, so a solar day lasts two of
    // its years. The only body in the system in that resonance.
    rotationPeriod: 1_407.6 * HOUR,
    axialTilt: 0.034 * DEG,
    semiMajorAxis: 0.387_098_93 * AU,
    eccentricity: 0.205_630_69,
    inclination: 7.005 * DEG,
    argumentOfPeriapsis: 29.124 * DEG,
    geometricAlbedo: 0.142,
    temperature: 440,
    texture: 'mercury',
    haze: null,
    relief: 9_800,
    roughness: 0.95,
    atmosphere: AIRLESS,
    clouds: null,
    rings: null,
    discoveryYear: 0,
    moons: [],
  },
  {
    name: 'Venus',
    tint: WHITE,
    kind: 'rocky',
    radius: 6_051.8 * KM,
    polarRadius: 6_051.8 * KM,
    mass: 4.8675e24,
    // Retrograde, and slower than its own year. The negative sign is the fact.
    // The fact sheet states retrograde twice — a negative period AND a 177.36°
    // obliquity — but the spin evaluator applies both, and two flips make a
    // prograde Venus. This file's convention (see the header, and Triton) is
    // the signed period, so the tilt carries only the axis: 180° − 177.36°.
    rotationPeriod: -5_832.5 * HOUR,
    axialTilt: 2.64 * DEG,
    semiMajorAxis: 0.723_331_99 * AU,
    eccentricity: 0.006_773_23,
    inclination: 3.394_71 * DEG,
    argumentOfPeriapsis: 54.884 * DEG,
    geometricAlbedo: 0.689,
    temperature: 737,
    texture: 'venus',
    haze: {
      height: 90_000,
      colour: { r: 0.96, g: 0.9, b: 0.68 },
      limb: { r: 0.98, g: 0.78, b: 0.45 },
    },
    relief: 13_800,
    roughness: 0.9,
    atmosphere: {
      surfacePressure: 9.2e6,
      scaleHeight: 15_900,
      ceiling: 250_000,
      surfaceDensity: 65,
    },
    // The surface is never visible. What you see is a featureless cloud deck
    // that superrotates in four days against a surface that takes 243 — the
    // largest disagreement between a planet and its own weather anywhere.
    clouds: { altitude: 60_000, rotationPeriod: -4.2 * DAY, opacity: 1 },
    rings: null,
    discoveryYear: 0,
    moons: [],
  },
  {
    name: 'Earth',
    tint: WHITE,
    kind: 'rocky',
    radius: 6_378_137,
    polarRadius: 6_356_752,
    mass: 5.972_17e24,
    rotationPeriod: 23.934_47 * HOUR,
    axialTilt: 23.439_3 * DEG,
    semiMajorAxis: 1.000_000_11 * AU,
    eccentricity: 0.016_710_22,
    inclination: 0.000_05 * DEG,
    argumentOfPeriapsis: 114.207_83 * DEG,
    geometricAlbedo: 0.434,
    temperature: 288,
    texture: 'earth',
    haze: {
      height: 100_000,
      colour: { r: 0.28, g: 0.48, b: 0.95 },
      limb: { r: 0.92, g: 0.42, b: 0.2 },
    },
    // Everest to the Challenger Deep, which is what a topography-and-bathymetry
    // map spans.
    relief: 19_800,
    roughness: 0.85,
    atmosphere: {
      surfacePressure: 101_325,
      scaleHeight: 8_500,
      ceiling: 100_000,
      surfaceDensity: 1.217,
    },
    clouds: { altitude: 12_000, rotationPeriod: 25.5 * HOUR, opacity: 0.92 },
    rings: null,
    discoveryYear: 0,
    moons: [LUNA],
  },
  {
    name: 'Mars',
    tint: WHITE,
    kind: 'rocky',
    radius: 3_396_200,
    polarRadius: 3_376_200,
    mass: 6.4171e23,
    rotationPeriod: 24.622_9 * HOUR,
    axialTilt: 25.19 * DEG,
    semiMajorAxis: 1.523_662_31 * AU,
    eccentricity: 0.093_412_33,
    inclination: 1.850_61 * DEG,
    argumentOfPeriapsis: 286.502 * DEG,
    geometricAlbedo: 0.17,
    temperature: 210,
    texture: 'mars',
    haze: {
      height: 60_000,
      colour: { r: 0.78, g: 0.6, b: 0.48 },
      limb: { r: 0.62, g: 0.66, b: 0.9 },
    },
    // Olympus Mons to Hellas Planitia: 29 km, the largest relief on any
    // terrestrial surface in the system.
    relief: 29_400,
    roughness: 0.92,
    atmosphere: {
      surfacePressure: 610,
      scaleHeight: 11_100,
      ceiling: 120_000,
      surfaceDensity: 0.02,
    },
    clouds: null,
    rings: null,
    discoveryYear: 0,
    moons: [
      moon('Phobos', 11.267, 1.0659e16, 9_376, 0.318_91, 0.071, {
        eccentricity: 0.0151,
        inclination: 1.093 * DEG,
        temperature: 233,
        relief: 5_000,
      }),
      moon('Deimos', 6.2, 1.4762e15, 23_463, 1.263_24, 0.068, {
        eccentricity: 0.0002,
        inclination: 0.93 * DEG,
        temperature: 233,
        relief: 3_000,
      }),
    ],
  },
  {
    name: 'Jupiter',
    tint: WHITE,
    kind: 'gas-giant',
    radius: 71_492 * KM,
    // 6.5% flattened. Drawn as a sphere it reads as wrong before you can say
    // why.
    polarRadius: 66_854 * KM,
    mass: 1.8982e27,
    rotationPeriod: 9.925 * HOUR,
    axialTilt: 3.13 * DEG,
    semiMajorAxis: 5.203_363_01 * AU,
    eccentricity: 0.048_392_66,
    inclination: 1.3053 * DEG,
    argumentOfPeriapsis: 273.867 * DEG,
    geometricAlbedo: 0.538,
    temperature: 165,
    texture: 'jupiter',
    haze: {
      height: 570_000,
      colour: { r: 0.78, g: 0.76, b: 0.8 },
      limb: { r: 0.95, g: 0.78, b: 0.55 },
    },
    relief: 0,
    roughness: 1,
    atmosphere: {
      surfacePressure: 100_000,
      scaleHeight: 27_000,
      ceiling: 1_500_000,
      surfaceDensity: 0.16,
    },
    clouds: null,
    // Dust, not ice. Optical depth ~10⁻⁶: invisible except forward-scattered,
    // when it becomes a thin bright hoop. Kept because that is a real and almost
    // never rendered sight, and the cost is one more ring record.
    rings: {
      innerRadius: 122_500 * KM,
      outerRadius: 129_000 * KM,
      opticalDepth: 3e-6,
      texture: null,
    },
    discoveryYear: 0,
    moons: GALILEANS,
  },
  {
    name: 'Saturn',
    tint: WHITE,
    kind: 'gas-giant',
    radius: 60_268 * KM,
    // The most oblate planet in the system: 9.8%.
    polarRadius: 54_364 * KM,
    mass: 5.6834e26,
    rotationPeriod: 10.656 * HOUR,
    axialTilt: 26.73 * DEG,
    semiMajorAxis: 9.537_070_32 * AU,
    eccentricity: 0.054_150_6,
    inclination: 2.484_46 * DEG,
    argumentOfPeriapsis: 339.392 * DEG,
    geometricAlbedo: 0.499,
    temperature: 134,
    texture: 'saturn',
    haze: {
      height: 480_000,
      colour: { r: 0.88, g: 0.84, b: 0.72 },
      limb: { r: 0.95, g: 0.82, b: 0.58 },
    },
    relief: 0,
    roughness: 1,
    atmosphere: {
      surfacePressure: 100_000,
      scaleHeight: 59_500,
      ceiling: 2_000_000,
      surfaceDensity: 0.19,
    },
    clouds: null,
    // C ring inner edge to A ring outer edge: 74,658 to 136,775 km, which is
    // 1.24 to 2.27 Saturn radii, and about 10 metres thick. The whole system
    // would fit between the Earth and the Moon.
    rings: {
      innerRadius: 74_658 * KM,
      outerRadius: 136_775 * KM,
      opticalDepth: 0.7,
      texture: 'saturn-ring',
    },
    discoveryYear: 0,
    moons: SATURNIAN,
  },
  {
    name: 'Uranus',
    tint: WHITE,
    kind: 'ice-giant',
    radius: 25_559 * KM,
    polarRadius: 24_973 * KM,
    mass: 8.681e25,
    rotationPeriod: -17.24 * HOUR,
    // It orbits on its side, so for a quarter of its year one pole points at
    // the Sun. Every other planet's tilt is a detail; this one is the planet's
    // defining fact. The fact sheet's 97.77° obliquity already encodes the
    // retrograde spin the negative period restates — and the evaluator applies
    // both, which un-flips it — so under this file's signed-period convention
    // the tilt is the supplement: 180° − 97.77°.
    axialTilt: 82.23 * DEG,
    semiMajorAxis: 19.191_263_93 * AU,
    eccentricity: 0.047_167_71,
    inclination: 0.769_86 * DEG,
    argumentOfPeriapsis: 98.999 * DEG,
    geometricAlbedo: 0.488,
    temperature: 76,
    texture: 'uranus',
    haze: {
      height: 200_000,
      colour: { r: 0.5, g: 0.82, b: 0.86 },
      limb: { r: 0.62, g: 0.85, b: 0.88 },
    },
    relief: 0,
    roughness: 1,
    atmosphere: {
      surfacePressure: 100_000,
      scaleHeight: 27_700,
      ceiling: 800_000,
      surfaceDensity: 0.42,
    },
    clouds: null,
    rings: {
      innerRadius: 41_837 * KM,
      outerRadius: 51_149 * KM,
      opticalDepth: 0.5,
      texture: null,
    },
    discoveryYear: 1781,
    moons: URANIAN,
  },
  {
    name: 'Neptune',
    tint: WHITE,
    kind: 'ice-giant',
    radius: 24_764 * KM,
    polarRadius: 24_341 * KM,
    mass: 1.024_13e26,
    rotationPeriod: 16.11 * HOUR,
    axialTilt: 28.32 * DEG,
    semiMajorAxis: 30.068_963_48 * AU,
    eccentricity: 0.008_585_87,
    inclination: 1.769_17 * DEG,
    argumentOfPeriapsis: 276.336 * DEG,
    geometricAlbedo: 0.442,
    temperature: 72,
    texture: 'neptune',
    haze: {
      height: 200_000,
      colour: { r: 0.32, g: 0.5, b: 0.92 },
      limb: { r: 0.45, g: 0.6, b: 0.95 },
    },
    relief: 0,
    roughness: 1,
    atmosphere: {
      surfacePressure: 100_000,
      scaleHeight: 19_700,
      ceiling: 700_000,
      surfaceDensity: 0.45,
    },
    clouds: null,
    rings: {
      innerRadius: 41_900 * KM,
      outerRadius: 62_933 * KM,
      opticalDepth: 0.1,
      texture: null,
    },
    discoveryYear: 1846,
    moons: [
      moon('Triton', 1_353.4, 2.139e22, 354_759, -5.876_854, 0.76, {
        eccentricity: 0.000_016,
        // Retrograde and steeply inclined, because it was captured rather than
        // formed here — the only large moon in the system that was.
        inclination: 156.885 * DEG,
        temperature: 38,
        relief: 1_000,
        roughness: 0.5,
        tint: { r: 0.94, g: 0.9, b: 0.86 },
        // Thin, but real: nitrogen at 1.4 Pa, with plumes.
        atmosphere: {
          surfacePressure: 1.4,
          scaleHeight: 20_000,
          ceiling: 100_000,
          surfaceDensity: 5e-5,
        },
        haze: {
          height: 40_000,
          colour: { r: 0.6, g: 0.72, b: 0.9 },
          limb: { r: 0.8, g: 0.8, b: 0.9 },
        },
      }),
    ],
  },
]

/** Every named body in the system, planets and moons alike. */
export function* walkSolarBodies(): Generator<SolarBody> {
  for (const planet of SOLAR_PLANETS) {
    yield planet
    for (const satellite of planet.moons) yield satellite
  }
}

/** Mass in Earth masses, for the readouts that use them. */
export const earthMasses = (body: SolarBody): number => body.mass / EARTH_MASS
