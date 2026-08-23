import {
  AU,
  EARTH_MASS,
  invariant,
  EARTH_RADIUS,
  GRAVITATIONAL_CONSTANT,
  JUPITER_MASS,
  type Kelvin,
  type Kilograms,
  type Meters,
  type Mu,
  type Radians,
  type Seconds,
  SECONDS_PER_DAY,
  SECONDS_PER_YEAR,
  SOLAR_LUMINOSITY,
  SOLAR_MASS,
  SOLAR_RADIUS,
} from '@inertialref/shared'
import {
  algorithm,
  deriveSeed,
  manifest,
  Rng,
  type Seed,
} from '@inertialref/procedural'
import type { Atmosphere, OrbitalElements } from '@inertialref/physics'
import { orbitalPeriod, sphereOfInfluence } from '@inertialref/physics'
import type { UniverseVector } from '@inertialref/spatial'
import { parseSpectralType, type SpectralClass } from './catalog/spectral.ts'
import {
  bodyAddress,
  type EntityId,
  entityIdForAddress,
  type GalaxyId,
  type SystemId,
  systemAddress,
  type UniverseAddress,
} from './address.ts'
import { type SystemStub, systemSeedOf } from './galaxy.ts'
import { SOL, solarSystem } from './solar/system.ts'
import type { LinearRgb } from './catalog/photometry.ts'
import type { CatalogPlanet } from './catalog/starCatalog.ts'

/*
 * Star system generation.
 *
 * Every property of every body is drawn from a seed derived from that body's
 * own address. Adding a moon to the second planet cannot perturb the third
 * planet, and generating planet 5 does not require generating planets 0-4 —
 * which is what makes it safe to generate on demand, out of order, in a worker.
 *
 * The astrophysics is deliberately shallow but not arbitrary: main-sequence
 * mass-luminosity, a frost line that scales with luminosity, densities that
 * separate rocky worlds from giants. Enough that the results are recognisable
 * and that swapping in something better later is a change to this file only.
 *
 * ## Observed and projected
 *
 * A system is two layers, and the player can always tell which is which
 * (`docs/design/galaxy.md`). Planets that somebody has actually confirmed come
 * from the catalog with their published masses, radii and orbits, and are
 * marked `observed`. Everything else is `projected` — what the ship's computer
 * expects to be there given the star. The game never claims a projection is
 * real, which is what lets real data arrive later without anything having lied.
 *
 * **Observed bodies are issued first, in discovery order.** A planet's index is
 * its issue ordinal, not its orbital one: `b:0` is the first body ever issued in
 * this system and stays that body forever, however its orbit compares to the
 * others. Sorting by semi-major axis instead would mean that confirming a hot
 * Jupiter inside every known orbit renumbers the whole system, and every save
 * that referred to those worlds now points at the wrong one. The exoplanet
 * letters — b, c, d — are already an issue order, so they map straight onto it.
 * See ADR-0009 and `docs/design/galaxy.md` Rule 2.
 */

export const SYSTEM_ALGORITHM = algorithm('system', 2)
export const TERRAIN_ALGORITHM = algorithm('terrain', 1)
export const GALAXY_ALGORITHM = algorithm('galaxy', 2)
/**
 * The measured-to-physical conversion in `catalog/photometry.ts`.
 *
 * It belongs in the manifest because a system's planets are laid out from its
 * star's luminosity: changing a bolometric correction moves every frost line in
 * the cataloged half of the galaxy. It looks like presentation and it is not.
 */
export const PHOTOMETRY_ALGORITHM = algorithm('photometry', 1)

export const GENERATION_VERSIONS = manifest([
  GALAXY_ALGORITHM,
  SYSTEM_ALGORITHM,
  TERRAIN_ALGORITHM,
  PHOTOMETRY_ALGORITHM,
])

export type BodyKind = 'rocky' | 'ice' | 'gas-giant' | 'ice-giant' | 'moon'

/**
 * Where a body's description came from, and therefore what may be claimed about
 * it. `observed` is somebody's published measurement; `projected` is this
 * generator's expectation. Drawn differently, and never conflated.
 */
export type BodyProvenance = 'observed' | 'projected'

export interface Star {
  readonly name: string
  readonly spectralType: string
  readonly spectralClass: SpectralClass
  readonly mass: Kilograms
  readonly radius: Meters
  readonly temperature: Kelvin
  /** Bolometric luminosity, watts. */
  readonly luminosity: number
  /** Linear sRGB of a blackbody at `temperature`, brightest channel normalized. */
  readonly colour: LinearRgb
  readonly mu: Mu
}

/** Terrain generation parameters. The heightfield itself is never stored. */
export interface SurfaceParameters {
  readonly seed: Seed
  /** Peak-to-datum elevation, meters. */
  readonly maxElevation: Meters
  /** Base spatial frequency of the terrain, cycles per body radius. */
  readonly roughness: number
  /** Ocean datum as a fraction of maxElevation, or null for a dry world. */
  readonly seaLevel: number | null
}

export interface Body {
  readonly address: UniverseAddress
  readonly id: EntityId
  readonly name: string
  readonly kind: BodyKind
  readonly provenance: BodyProvenance
  /**
   * Polar radius. Smaller than `radius` for anything that spins.
   *
   * Not a detail: Saturn is 9.8% flattened and Jupiter 6.5%, which is plainly
   * visible from orbit and is the first thing that reads as wrong when a gas
   * giant is drawn as a sphere. It is also real physics — centrifugal support
   * against self-gravity — so procedural bodies get it too, from their own
   * rotation and mass.
   */
  readonly polarRadius: Meters
  readonly appearance: BodyAppearance
  /**
   * How the mass and radius were arrived at, for an observed body. Radial
   * velocity gives `M sin i` — a lower bound, not a mass — and a transit gives a
   * radius with no mass at all, so one of the two is very often inferred from
   * the other. The panel says which.
   */
  readonly measurement: BodyMeasurement | null
  readonly mass: Kilograms
  readonly radius: Meters
  readonly mu: Mu
  readonly elements: OrbitalElements
  readonly orbitalPeriod: Seconds
  readonly rotationPeriod: Seconds
  readonly axialTilt: Radians
  readonly atmosphere: Atmosphere | null
  readonly surface: SurfaceParameters
  readonly sphereOfInfluence: Meters
  readonly moons: readonly Body[]
}

/*
 * What a body looks like.
 *
 * Separate from what it *is* because the two have different provenance and
 * different rules. Mass, radius and orbit are measurements a player can check
 * (`docs/design/art.md`: "the data is not negotiable"). Roughness, relief scale
 * and how vividly a texture is rendered are the sensor's business, and the art
 * doctrine licenses them explicitly — "albedo comes from the biome; roughness
 * and detail are art".
 *
 * `texture` is a key, not a path. `packages/universe` cannot fetch anything and
 * must not know what a URL is; the host resolves the key against the manifest in
 * `data/textures/`, and a key it has no entry for falls back to `colour`.
 */
export type TextureMap =
  'albedo' | 'normal' | 'night' | 'water' | 'clouds' | 'ring'

export interface RingSystem {
  readonly innerRadius: Meters
  readonly outerRadius: Meters
  /**
   * Mean normal optical depth.
   *
   * Drives both opacity and the forward-scattering blaze when the rings are
   * between you and the star — the thing Cassini photographs that no game
   * renders. Saturn's B ring is ~1.5; Jupiter's dust ring is ~1e-6, which is why
   * a ring system is a property rather than a boolean.
   */
  readonly opticalDepth: number
  readonly texture: string | null
}

export interface CloudLayer {
  readonly altitude: Meters
  /**
   * Sidereal period of the cloud deck, which is not the body's.
   *
   * Venus's atmosphere superrotates in 4 days against a 243-day surface; Earth's
   * weather drifts a few degrees a day. Tying clouds to the body's rotation is
   * the thing that makes a planet look like a painted ball.
   */
  readonly rotationPeriod: Seconds
  readonly opacity: number
}

/**
 * The visible haze above a body, which is not the same thing as its atmosphere.
 *
 * `Atmosphere.ceiling` is a *physics* number — where the drag model stops
 * integrating — and for a gas giant it is a thousand kilometers or more, because
 * there is no surface and the air just keeps going. Rendered as a shell that
 * thick, Saturn wears a halo 3% of its own radius and looks like a moon in a
 * jar. What you actually see above the cloud tops is a few hundred kilometers of
 * haze.
 *
 * The colors are the licensed part, and `docs/design/art.md` says so
 * explicitly: scattering coefficients are "tuned within the real range for the
 * modeled composition". The hues are the published ones — Earth's limb is blue
 * and its terminator is orange because Rayleigh scattering says so; Titan's is
 * orange all the way round because its haze is tholins.
 */
export interface HazeLayer {
  /** Rendered thickness above the datum. Not `Atmosphere.ceiling`. */
  readonly height: Meters
  /** Scattering color looking straight down through it. */
  readonly colour: LinearRgb
  /** Forward-scattered color at the terminator — the sunset seen from orbit. */
  readonly limb: LinearRgb
  /**
   * Visible optical thickness of the whole column, 0..1, where 1 is
   * Earth-dense. Not pressure: it is how much the air *shows*. It is what
   * separates Mars — whose 600 Pa limb stays a translucent butterscotch,
   * because thin air never scatters its way to white — from Earth and Venus,
   * whose dense limbs whiten with multiple scattering. Rendering with one
   * constant here painted Mars with Earth's white halo.
   */
  readonly thickness: number
}

export interface BodyAppearance {
  /** Texture-set key, or null for a body with no maps. */
  readonly texture: string | null
  readonly maps: readonly TextureMap[]
  /** Peak-to-trough elevation the normal map represents, meters. */
  readonly relief: Meters
  /** Geometric albedo: how bright the body is at full phase. */
  readonly geometricAlbedo: number
  /** Microfacet roughness of the surface. 0 is a mirror; rock is near 1. */
  readonly roughness: number
  readonly clouds: CloudLayer | null
  readonly rings: RingSystem | null
  readonly haze: HazeLayer | null
  /** Used where there is no albedo map, and to tint one that is grayscale. */
  readonly colour: LinearRgb
}

export interface BodyMeasurement {
  /** True when the mass is an `M sin i` lower bound from radial velocity. */
  readonly massIsLowerBound: boolean
  /** True when the mass was inferred from the radius rather than measured. */
  readonly massInferred: boolean
  /** True when the radius was inferred from the mass rather than measured. */
  readonly radiusInferred: boolean
  readonly discoveryYear: number
  readonly discoveryMethod: string
  /** Insolation relative to Earth, where published. */
  readonly insolation: number | null
  /** Published equilibrium temperature, Kelvin, where available. */
  readonly equilibriumTemperature: number | null
}

export interface StarSystem {
  readonly id: SystemId
  readonly address: UniverseAddress
  readonly name: string
  readonly position: UniverseVector
  readonly seed: Seed
  readonly star: Star
  /** In issue order. `orbitalOrder` sorts them for display. */
  readonly planets: readonly Body[]
  /** How many of `planets` are confirmed rather than projected. */
  readonly observedPlanets: number
  readonly generation: Readonly<Record<string, number>>
}

const mu = (mass: Kilograms): Mu => GRAVITATIONAL_CONSTANT * mass

/*
 * The star's class, for the handful of places that branch on one.
 *
 * Goes through the real parser rather than reading character zero, because the
 * catalog's spectral strings are not MK strings: `dM4` is an M dwarf and
 * `DA2` is a white dwarf, and `spect[0]` calls the first one a D and the second
 * one a D as well. See `catalog/spectral.ts` for the full list of ways this
 * looked easy.
 */
function classify(spectralType: string): SpectralClass {
  // `M` for a string that carries no classification at all: three quarters of
  // the neighborhood is an M dwarf, so it is the least wrong default. A white
  // dwarf or a brown dwarf keeps its own class — forcing those onto the OBAFGKM
  // ladder is how a 10,000 K white dwarf came to be rendered as a red one.
  return parseSpectralType(spectralType).spectralClass ?? 'M'
}

/**
 * The system's star, from its stub.
 *
 * There is no astrophysics left to do here. A cataloged star's temperature,
 * luminosity and radius come from its published magnitude and color through
 * `catalog/photometry.ts`; a procedural star's come from its mass through the
 * main-sequence relations in `galaxy.ts`. Both arrive already converted, which
 * is the point — this used to re-derive everything from mass, and doing that to
 * a cataloged star threw away the measurement and replaced it with a fit. Sol
 * came out at the right mass and the wrong color.
 */
function makeStar(stub: SystemStub): Star {
  const mass = stub.solarMasses * SOLAR_MASS
  return {
    name: stub.name,
    spectralType: stub.spectralType,
    spectralClass: classify(stub.spectralType),
    mass,
    radius: stub.solarRadii * SOLAR_RADIUS,
    temperature: stub.temperature,
    luminosity: stub.solarLuminosities * SOLAR_LUMINOSITY,
    colour: stub.colour,
    mu: mu(mass),
  }
}

/** Water frost line: where volatiles survive, so where giants can form. */
const frostLine = (luminosity: number): Meters =>
  2.7 * AU * Math.sqrt(luminosity / SOLAR_LUMINOSITY)

const DENSITY: Readonly<Record<BodyKind, number>> = {
  rocky: 5_200,
  ice: 1_900,
  moon: 3_100,
  'gas-giant': 1_330,
  'ice-giant': 1_640,
}

const radiusFromMass = (mass: Kilograms, kind: BodyKind): Meters =>
  ((3 * mass) / (4 * Math.PI * (DENSITY[kind] ?? 3_000))) ** (1 / 3)

function makeAtmosphere(
  rng: Rng,
  kind: BodyKind,
  radius: Meters,
  surfaceGravity: number,
): Atmosphere | null {
  if (kind === 'gas-giant' || kind === 'ice-giant') {
    return {
      surfaceDensity: rng.range(0.2, 1.6),
      scaleHeight: rng.range(20_000, 60_000),
      ceiling: radius * 0.06,
    }
  }
  // Small bodies cannot hold onto one; below ~2 m/s² of surface gravity the
  // exosphere escapes, which is why our Moon is bare and Titan is not.
  if (surfaceGravity < 1.6 || !rng.bool(0.55)) return null
  const surfaceDensity = rng.range(0.05, 3.5)
  return {
    surfaceDensity,
    scaleHeight: rng.range(4_000, 16_000),
    ceiling: rng.range(60_000, 180_000),
  }
}

function makeSurface(
  rng: Rng,
  seed: Seed,
  radius: Meters,
  kind: BodyKind,
  hasAtmosphere: boolean,
): SurfaceParameters {
  const relief =
    kind === 'gas-giant' || kind === 'ice-giant' ? 0 : rng.range(0.0005, 0.004)
  return {
    seed,
    maxElevation: radius * relief,
    roughness: rng.range(1.5, 6),
    seaLevel:
      hasAtmosphere &&
      kind !== 'gas-giant' &&
      kind !== 'ice-giant' &&
      rng.bool(0.4)
        ? rng.range(0.15, 0.55)
        : null,
  }
}

function makeMoon(
  parentSeed: Seed,
  parentName: string,
  parentMass: Kilograms,
  parentRadius: Meters,
  parentSoi: Meters,
  index: number,
  galaxy: GalaxyId,
  system: SystemId,
  parentPath: readonly number[],
): Body {
  const seed = deriveSeed(parentSeed, `b:${index}`)
  const rng = new Rng(seed)
  const address = bodyAddress(galaxy, system, [...parentPath, index])

  const mass = rng.powerLaw(
    -1.6,
    1e18,
    Math.max(2e18, Math.min(1.5e23, parentMass * 0.012)),
  )
  const radius = radiusFromMass(mass, 'moon')
  // Between a few parent radii and 40% of the sphere of influence. Inside that
  // lower bound is roughly the Roche limit; outside the upper bound the moon is
  // not actually bound to the planet, it is on its own orbit around the star.
  // `moonOrbitBand` guarantees the caller only asks for moons that fit.
  const [inner, outer] = moonOrbitBand(parentRadius, parentSoi)
  const semiMajorAxis = rng.range(inner, outer)
  const bodyMu = mu(mass)
  const surfaceGravity = bodyMu / (radius * radius)
  const atmosphere =
    radius > 1.2e6 ? makeAtmosphere(rng, 'moon', radius, surfaceGravity) : null

  const elements: OrbitalElements = {
    semiMajorAxis,
    eccentricity: rng.range(0, 0.05),
    inclination: rng.gaussian(0, 0.08),
    longitudeOfAscendingNode: rng.range(0, 2 * Math.PI),
    argumentOfPeriapsis: rng.range(0, 2 * Math.PI),
    meanAnomalyAtEpoch: rng.range(0, 2 * Math.PI),
    epoch: 0,
  }

  const surface = makeSurface(
    rng,
    deriveSeed(seed, 'surface'),
    radius,
    'moon',
    atmosphere !== null,
  )
  // Tidally locked more often than not, this close in.
  const rotationPeriod = rng.bool(0.7)
    ? orbitalPeriod(mu(parentMass) + bodyMu, semiMajorAxis)
    : rng.range(0.4, 30) * SECONDS_PER_DAY

  return {
    address,
    id: entityIdForAddress(address),
    name: `${parentName} ${MOON_SUFFIX[index] ?? String(index)}`,
    kind: 'moon',
    // Not one moon of any exoplanet has been confirmed, so every moon in the
    // game is a projection. When the first one is, this is where it stops being
    // true, and the field already exists to say so.
    provenance: 'projected',
    measurement: null,
    mass,
    radius,
    polarRadius:
      radius * (1 - rotationalFlattening(mass, radius, rotationPeriod)),
    appearance: proceduralAppearance(
      rng,
      'moon',
      radius,
      surface.maxElevation,
      atmosphere,
    ),
    mu: bodyMu,
    elements,
    // `G(M + m)`, matching what `frames.ts` propagates with. See its comment.
    orbitalPeriod: orbitalPeriod(mu(parentMass) + bodyMu, semiMajorAxis),
    rotationPeriod,
    axialTilt: Math.abs(rng.gaussian(0, 0.15)),
    atmosphere,
    surface,
    sphereOfInfluence: sphereOfInfluence(semiMajorAxis, mass, parentMass),
    moons: [],
  }
}

/**
 * The band of orbits a moon can occupy: outside the Roche-ish limit, inside the
 * part of the sphere of influence where an orbit stays stable over the long
 * term (~40% of the SOI is the usual rule of thumb for prograde satellites).
 */
function moonOrbitBand(
  parentRadius: Meters,
  parentSoi: Meters,
): readonly [Meters, Meters] {
  return [parentRadius * 2.5, parentSoi * 0.4]
}

const ROMAN = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
]
const romanNumeral = (n: number): string => ROMAN[n - 1] ?? String(n)
/** Moons take their planet's name and a letter, as real satellites do. */
const MOON_SUFFIX = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

function makePlanet(
  systemSeed: Seed,
  star: Star,
  galaxy: GalaxyId,
  system: SystemId,
  systemName: string,
  index: number,
  semiMajorAxis: Meters,
): Body {
  const seed = deriveSeed(systemSeed, `b:${index}`)
  const rng = new Rng(seed)
  const address = bodyAddress(galaxy, system, [index])

  const beyondFrost = semiMajorAxis > frostLine(star.luminosity)
  const kind: BodyKind = beyondFrost
    ? rng.bool(0.55)
      ? 'gas-giant'
      : rng.bool(0.6)
        ? 'ice-giant'
        : 'ice'
    : rng.bool(0.85)
      ? 'rocky'
      : 'ice'

  const mass =
    kind === 'gas-giant'
      ? rng.powerLaw(-1.1, 0.12 * JUPITER_MASS, 8 * JUPITER_MASS)
      : kind === 'ice-giant'
        ? rng.powerLaw(-1.1, 8 * EARTH_MASS, 22 * EARTH_MASS)
        : rng.powerLaw(-1.3, 0.05 * EARTH_MASS, 6 * EARTH_MASS)
  const radius = radiusFromMass(mass, kind)
  const bodyMu = mu(mass)
  const surfaceGravity = bodyMu / (radius * radius)
  const atmosphere = makeAtmosphere(rng, kind, radius, surfaceGravity)

  const elements: OrbitalElements = {
    semiMajorAxis,
    eccentricity: Math.abs(rng.gaussian(0, 0.05)),
    inclination: rng.gaussian(0, 0.04),
    longitudeOfAscendingNode: rng.range(0, 2 * Math.PI),
    argumentOfPeriapsis: rng.range(0, 2 * Math.PI),
    meanAnomalyAtEpoch: rng.range(0, 2 * Math.PI),
    epoch: 0,
  }

  const name = `${systemName} ${romanNumeral(index + 1)}`
  const soi = sphereOfInfluence(semiMajorAxis, mass, star.mass)
  // A planet close to its star has a sphere of influence barely larger than
  // itself and simply cannot hold a moon; asking for one produced unbound
  // "moons" whose apoapsis lay outside the SOI.
  const [inner, outer] = moonOrbitBand(radius, soi)
  const canHoldMoons = outer > inner * 1.3
  const moonCount = !canHoldMoons
    ? 0
    : kind === 'gas-giant' || kind === 'ice-giant'
      ? rng.int(0, 6)
      : rng.int(0, radius > EARTH_RADIUS ? 3 : 1)
  const moons: Body[] = []
  for (let m = 0; m < moonCount; m += 1) {
    moons.push(
      makeMoon(seed, name, mass, radius, soi, m, galaxy, system, [index]),
    )
  }

  const surface = makeSurface(
    rng,
    deriveSeed(seed, 'surface'),
    radius,
    kind,
    atmosphere !== null,
  )
  // A retrograde spin one time in sixteen. Venus and Uranus are two of eight,
  // which is a small sample and a real phenomenon; giant impacts happen.
  const rotationPeriod =
    rng.range(0.25, 3) * SECONDS_PER_DAY * (rng.bool(0.06) ? -1 : 1)

  return {
    address,
    id: entityIdForAddress(address),
    name,
    kind,
    provenance: 'projected',
    measurement: null,
    mass,
    radius,
    polarRadius:
      radius * (1 - rotationalFlattening(mass, radius, rotationPeriod)),
    appearance: proceduralAppearance(
      rng,
      kind,
      radius,
      surface.maxElevation,
      atmosphere,
    ),
    mu: bodyMu,
    elements,
    orbitalPeriod: orbitalPeriod(star.mu + bodyMu, semiMajorAxis),
    rotationPeriod,
    axialTilt: Math.abs(rng.gaussian(0, 0.35)),
    atmosphere,
    surface,
    sphereOfInfluence: soi,
    moons,
  }
}

/* ------------------------------------------------------------------------- */
/* Appearance                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Rotational flattening, from the Maclaurin relation for a uniform fluid body:
 * `f ≈ (5/4)·ω²R³/GM`.
 *
 * Real for procedural bodies, and wrong by a factor of two for real ones — which
 * is why every body in `solar/bodies.ts` carries its *measured* polar radius
 * instead. The error is central condensation: the relation assumes uniform
 * density, and a gas giant keeps most of its mass in the middle, so it resists
 * being flung outwards more than the formula expects. Applied to Jupiter it
 * gives 11% against a measured 6.5%.
 *
 * Kept anyway, because a procedural gas giant spinning in ten hours *should* be
 * visibly oblate and there is nothing better to derive it from — and because a
 * sphere is not the neutral choice here, it is the wrong one.
 */
export function rotationalFlattening(
  mass: Kilograms,
  radius: Meters,
  rotationPeriod: Seconds,
): number {
  const period = Math.abs(rotationPeriod)
  if (period <= 0 || mass <= 0 || radius <= 0) return 0
  const omega = (2 * Math.PI) / period
  const f =
    1.25 * ((omega * omega * radius ** 3) / (GRAVITATIONAL_CONSTANT * mass))
  // A body past ~0.3 would be a Jacobi ellipsoid rather than a spheroid, and
  // this model has nothing to say about it.
  return Math.min(0.3, Math.max(0, f))
}

/**
 * Class-typical surface colors, linear sRGB.
 *
 * These are what a body looks like when nobody has photographed it, and they are
 * deliberately desaturated: a real airless surface is gray rock or dirty ice,
 * and the saturated palette a generator reaches for first is the single clearest
 * tell that a world was invented. Bodies in `solar/` override these with a map.
 */
const KIND_COLOUR: Readonly<Record<BodyKind, LinearRgb>> = {
  rocky: { r: 0.28, g: 0.21, b: 0.16 },
  ice: { r: 0.62, g: 0.68, b: 0.72 },
  moon: { r: 0.3, g: 0.3, b: 0.29 },
  'gas-giant': { r: 0.6, g: 0.47, b: 0.34 },
  'ice-giant': { r: 0.22, g: 0.4, b: 0.55 },
}

const KIND_ALBEDO: Readonly<Record<BodyKind, number>> = {
  rocky: 0.15,
  ice: 0.5,
  moon: 0.12,
  'gas-giant': 0.5,
  'ice-giant': 0.45,
}

const KIND_ROUGHNESS: Readonly<Record<BodyKind, number>> = {
  rocky: 0.95,
  ice: 0.55,
  moon: 0.95,
  'gas-giant': 1,
  'ice-giant': 1,
}

/**
 * What a generated body looks like.
 *
 * No maps — those exist only for bodies somebody has been to — so this is a
 * color, a roughness and, for a giant, a chance of rings. The renderer's job is
 * to make that look like a world rather than a ball, which is what the relief in
 * `surface` and the terminator are for.
 *
 * Rings on roughly one gas giant in six. That is not a measured frequency,
 * because nobody has measured one: every giant in the Solar System has a ring
 * system and three of the four are invisible, so the honest answer is that the
 * *visible* fraction is unknown and this is a number chosen to make them a find
 * rather than wallpaper.
 */
/*
 * Haze color for a generated world, from its class.
 *
 * Rayleigh scattering goes as λ⁻⁴, so *any* clear atmosphere of small molecules
 * is blue looking down and red looking along — which is why Earth, Uranus and
 * Neptune are all blue for the same reason and Mars is not. A generated world's
 * composition is not modeled, so this is the class-typical answer and the
 * cataloged bodies in `solar/` override it with published ones.
 */
const KIND_HAZE: Readonly<
  Record<BodyKind, { colour: LinearRgb; limb: LinearRgb }>
> = {
  rocky: {
    colour: { r: 0.28, g: 0.48, b: 0.95 },
    limb: { r: 0.86, g: 0.45, b: 0.26 },
  },
  ice: {
    colour: { r: 0.4, g: 0.6, b: 0.9 },
    limb: { r: 0.8, g: 0.6, b: 0.5 },
  },
  moon: {
    colour: { r: 0.4, g: 0.55, b: 0.85 },
    limb: { r: 0.8, g: 0.55, b: 0.4 },
  },
  'gas-giant': {
    colour: { r: 0.72, g: 0.74, b: 0.82 },
    limb: { r: 0.9, g: 0.72, b: 0.5 },
  },
  'ice-giant': {
    colour: { r: 0.45, g: 0.72, b: 0.88 },
    limb: { r: 0.7, g: 0.75, b: 0.9 },
  },
}

function proceduralAppearance(
  rng: Rng,
  kind: BodyKind,
  radius: Meters,
  relief: Meters,
  atmosphere: Atmosphere | null,
): BodyAppearance {
  const giant = kind === 'gas-giant' || kind === 'ice-giant'
  const rings =
    giant && rng.bool(1 / 6)
      ? {
          // Inside the Roche limit for ice, where a moon cannot hold together
          // and rings therefore can be — the reason Saturn's stop where they do.
          innerRadius: radius * rng.range(1.2, 1.6),
          outerRadius: radius * rng.range(1.9, 2.6),
          opticalDepth: rng.range(0.1, 1.2),
          texture: null,
        }
      : null
  const hue = KIND_HAZE[kind] ?? KIND_HAZE.rocky
  return {
    texture: null,
    maps: [],
    relief,
    geometricAlbedo: KIND_ALBEDO[kind] ?? 0.15,
    roughness: KIND_ROUGHNESS[kind] ?? 0.9,
    clouds: null,
    rings,
    haze:
      atmosphere === null
        ? null
        : {
            // A giant's drag ceiling is a thousand kilometers of "there is no
            // surface"; what is visible above its cloud tops is a fraction of a
            // percent of the radius.
            height: giant
              ? radius * 0.008
              : Math.min(atmosphere.ceiling, radius * 0.02),
            colour: hue.colour,
            limb: hue.limb,
            // A giant's limb has no bottom to thin out against; a terrestrial
            // one shows what its sea-level density can scatter. 1.2 kg/m³ is
            // Earth's, which is what "1" means everywhere this is read.
            thickness: giant ? 1 : Math.min(1, atmosphere.surfaceDensity / 1.2),
          },
    colour: KIND_COLOUR[kind] ?? KIND_COLOUR.rocky,
  }
}

/* ------------------------------------------------------------------------- */
/* Observed planets                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Mass and radius from whichever of the two was published.
 *
 * Very few exoplanets have both. Radial velocity gives a mass and no radius;
 * a transit gives a radius and no mass; only a planet found both ways has both,
 * and that is a minority. The Chen & Kipping (2017) probabilistic mass-radius
 * relation fills the gap — forward for a mass, inverted for a radius — in three
 * regimes with genuinely different physics: rock, volatile envelopes, and
 * degenerate interiors where adding mass stops adding size.
 *
 * The Jovian branch is why this cannot be one power law. Above ~130 Earth
 * masses the radius is nearly independent of mass, so inverting it is not
 * ill-conditioned, it is meaningless — Jupiter and a 10-Jupiter object are the
 * same size. A radius that large therefore yields a *typical* Jovian mass, and
 * `massInferred` says so rather than presenting it as a measurement.
 */
const TERRAN_MAX_MASS = 2.04
const NEPTUNIAN_MAX_MASS = 131.6
const TYPICAL_JOVIAN_MASS = 318

function radiusFromPlanetMass(massEarths: number): number {
  if (massEarths < TERRAN_MAX_MASS) return 1.008 * massEarths ** 0.279
  if (massEarths < NEPTUNIAN_MAX_MASS) return 0.808 * massEarths ** 0.589
  return 17.74 * massEarths ** -0.044
}

function massFromPlanetRadius(radiusEarths: number): number {
  if (radiusEarths < radiusFromPlanetMass(TERRAN_MAX_MASS))
    return (radiusEarths / 1.008) ** (1 / 0.279)
  if (radiusEarths < radiusFromPlanetMass(NEPTUNIAN_MAX_MASS))
    return (radiusEarths / 0.808) ** (1 / 0.589)
  return TYPICAL_JOVIAN_MASS
}

/**
 * Kepler's third law, the other way round: the orbit that has this period.
 * Takes `G(M + m)` like every other orbit computation here, so a period fed
 * in comes back out of `orbitalPeriod` exactly.
 */
const axisFromPeriod = (combinedMu: Mu, period: Seconds): Meters =>
  (combinedMu * (period / (2 * Math.PI)) ** 2) ** (1 / 3)

/**
 * Kind from bulk density, not from mass.
 *
 * A four-Earth-mass planet at 1.5 Earth radii is a rock and at 4 Earth radii is
 * a small Neptune with a hydrogen envelope, and mass alone cannot tell them
 * apart. Density can, and it is the quantity the two published numbers were
 * measured to produce.
 */
function classifyObserved(
  massEarths: number,
  radiusEarths: number,
  beyondFrost: boolean,
): BodyKind {
  const density = (massEarths / radiusEarths ** 3) * 5_513 // Earth's, kg/m³
  if (radiusEarths > 6) return 'gas-giant'
  if (radiusEarths > 2) return 'ice-giant'
  if (density < 3_000) return 'ice'
  return beyondFrost ? 'ice' : 'rocky'
}

/**
 * A confirmed planet, as published, with the unpublished remainder projected.
 *
 * The split is the whole point. Semi-major axis, eccentricity, mass, radius and
 * the argument of periapsis are measurements and are used verbatim. Rotation
 * period, axial tilt, atmosphere and terrain are not measured for any exoplanet
 * and are drawn from this body's seed exactly as a projected planet's would be —
 * so the world you land on is invented, while the orbit you fly is not.
 *
 * The one measurement that is deliberately *not* used is inclination. The
 * archive publishes it relative to the plane of the sky, which is a fact about
 * where Earth happens to be, not about the system. Converting it into a
 * system-relative inclination needs the system's orientation, which nobody
 * publishes. What is physically true and worth reproducing is that planets in a
 * system are nearly coplanar, so they get a small shared scatter instead.
 */
function makeObservedPlanet(
  systemSeed: Seed,
  star: Star,
  galaxy: GalaxyId,
  system: SystemId,
  systemName: string,
  index: number,
  planet: CatalogPlanet,
): Body {
  const seed = deriveSeed(systemSeed, `b:${index}`)
  const rng = new Rng(seed)
  const address = bodyAddress(galaxy, system, [index])

  // Mass before orbit: deriving an axis from a published period must invert
  // the same two-body law the simulator integrates, and that law runs on
  // G(M + m). Inverting with the star's mu alone flew a 10-Jupiter-mass
  // planet ~1.5% short of the very period the archive published for it.
  const massInferred = planet.massEarths === null
  const radiusInferred = planet.radiusEarths === null
  const massEarths =
    planet.massEarths ??
    (planet.radiusEarths === null
      ? 1
      : massFromPlanetRadius(planet.radiusEarths))
  const radiusEarths = planet.radiusEarths ?? radiusFromPlanetMass(massEarths)

  const mass = massEarths * EARTH_MASS
  const radius = radiusEarths * EARTH_RADIUS
  const bodyMu = mu(mass)

  const semiMajorAxis =
    planet.semiMajorAxisAu !== null
      ? planet.semiMajorAxisAu * AU
      : planet.orbitalPeriodDays !== null
        ? axisFromPeriod(
            star.mu + bodyMu,
            planet.orbitalPeriodDays * SECONDS_PER_DAY,
          )
        : // Neither published. This is rare enough to be worth failing loudly
          // over rather than inventing an orbit for a body labeled `observed`.
          Number.NaN
  invariant(
    Number.isFinite(semiMajorAxis) && semiMajorAxis > 0,
    `${systemName} ${planet.letter} has neither a semi-major axis nor a period`,
  )
  const kind = classifyObserved(
    massEarths,
    radiusEarths,
    semiMajorAxis > frostLine(star.luminosity),
  )
  const surfaceGravity = bodyMu / (radius * radius)
  const atmosphere = makeAtmosphere(rng, kind, radius, surfaceGravity)

  const elements: OrbitalElements = {
    semiMajorAxis,
    eccentricity: Math.min(
      0.95,
      planet.eccentricity ?? Math.abs(rng.gaussian(0, 0.05)),
    ),
    inclination: rng.gaussian(0, 0.02),
    longitudeOfAscendingNode: rng.range(0, 2 * Math.PI),
    argumentOfPeriapsis:
      planet.argumentOfPeriapsisDeg !== null
        ? (planet.argumentOfPeriapsisDeg * Math.PI) / 180
        : rng.range(0, 2 * Math.PI),
    meanAnomalyAtEpoch: rng.range(0, 2 * Math.PI),
    epoch: 0,
  }

  const period = orbitalPeriod(star.mu + bodyMu, semiMajorAxis)
  const surface = makeSurface(
    rng,
    deriveSeed(seed, 'surface'),
    radius,
    kind,
    atmosphere !== null,
  )
  // Nothing is published. Close in, tidal locking is the overwhelmingly likely
  // outcome and it is the single most consequential fact about such a world;
  // further out it is a free draw.
  const rotationPeriod =
    semiMajorAxis < 0.1 * AU
      ? period
      : rng.range(0.25, 3) * SECONDS_PER_DAY * (rng.bool(0.06) ? -1 : 1)
  const soi = sphereOfInfluence(semiMajorAxis, mass, star.mass)
  const [inner, outer] = moonOrbitBand(radius, soi)
  const moons: Body[] = []
  if (outer > inner * 1.3) {
    const moonCount =
      kind === 'gas-giant' || kind === 'ice-giant'
        ? rng.int(0, 6)
        : rng.int(0, radius > EARTH_RADIUS ? 3 : 1)
    for (let m = 0; m < moonCount; m += 1)
      moons.push(
        makeMoon(seed, planet.name, mass, radius, soi, m, galaxy, system, [
          index,
        ]),
      )
  }

  return {
    address,
    id: entityIdForAddress(address),
    // The published designation, which is what a player will search for and
    // what Wikipedia will confirm. `CatalogPlanet.name` is `<host> <letter>` for
    // every exoplanet and the real name for the eight that have one.
    name: planet.name,
    kind,
    provenance: 'observed',
    measurement: {
      massIsLowerBound: planet.massIsLowerBound,
      massInferred,
      radiusInferred,
      discoveryYear: planet.discoveryYear,
      discoveryMethod: planet.discoveryMethod,
      insolation: planet.insolation,
      equilibriumTemperature: planet.equilibriumTemperature,
    },
    mass,
    radius,
    polarRadius:
      radius * (1 - rotationalFlattening(mass, radius, rotationPeriod)),
    // Confirmed or not, nobody has photographed an exoplanet's surface. The
    // orbit is observed and the appearance is a projection, and the two are
    // marked differently everywhere they are shown.
    appearance: proceduralAppearance(
      rng,
      kind,
      radius,
      surface.maxElevation,
      atmosphere,
    ),
    mu: bodyMu,
    elements,
    orbitalPeriod: period,
    rotationPeriod,
    axialTilt: Math.abs(rng.gaussian(0, 0.35)),
    atmosphere,
    surface,
    sphereOfInfluence: soi,
    moons,
  }
}

/**
 * Generate a whole system from its stub.
 *
 * Two passes. Confirmed planets are issued first, in the order astronomy issued
 * them, so their addresses never move. Projected planets then fill the rest of
 * the system: orbital radii from a geometric progression with per-orbit jitter —
 * the Titius-Bode-shaped spacing that falls out of real formation dynamics —
 * with each planet's *properties* drawn from its own seed, so the spacing and
 * the contents stay independent.
 *
 * A projected orbit that lands on top of a confirmed one is dropped rather than
 * moved. `docs/design/galaxy.md` Rule 4: projections yield to observations, and
 * the overlap test is deliberately generous — within a factor of 1.5 in
 * semi-major axis — because the point is to avoid two bodies visibly sharing an
 * orbit, not to be precise about a guess. Dropping rather than nudging keeps the
 * projection a pure function of its own seed; nudging would make planet 6 depend
 * on what the catalog says about planet 2, which is exactly the
 * order-dependence the whole generator is built to avoid.
 */
export function generateSystem(
  rootSeed: Seed,
  galaxy: GalaxyId,
  stub: SystemStub,
): StarSystem {
  // The one special case in the generator, and it earns it. Sol is the only
  // system where every body is known — eight planets and twenty moons, with
  // measured radii, oblateness, tilts and albedos — so it is built from those
  // rather than from a seed. See `solar/system.ts`.
  if (stub.id === SOL) return solarSystem(rootSeed, galaxy, stub)

  const seed = systemSeedOf(rootSeed, galaxy, stub.id)
  const star = makeStar(stub)
  const layoutRng = new Rng(deriveSeed(seed, 'layout'))

  const planets: Body[] = []
  // Discovery order, which is what the letters already encode: b before c
  // before d. Sorting by orbit here would make the address of a world depend on
  // what is discovered next to it.
  const observed = [...stub.planets].sort((a, b) =>
    a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0,
  )
  for (const planet of observed) {
    planets.push(
      makeObservedPlanet(
        seed,
        star,
        galaxy,
        stub.id,
        stub.name,
        planets.length,
        planet,
      ),
    )
  }
  const observedAxes = planets.map((p) => p.elements.semiMajorAxis)

  const drawn = layoutRng.weightedIndex([6, 9, 12, 14, 14, 12, 9, 7, 5, 3])
  // A system with four confirmed planets does not also want eight invented
  // ones. The draw is the total the generator believes in; the catalog has
  // already accounted for some of it.
  const projectedCount = Math.max(0, drawn - observed.length)
  const luminosityScale = Math.sqrt(star.luminosity / SOLAR_LUMINOSITY)
  let axis = layoutRng.range(0.06, 0.5) * AU * luminosityScale
  for (let i = 0; i < projectedCount; i += 1) {
    const crowded = observedAxes.some(
      (known) => axis / known < ORBIT_OVERLAP && known / axis < ORBIT_OVERLAP,
    )
    if (!crowded)
      planets.push(
        makePlanet(
          seed,
          star,
          galaxy,
          stub.id,
          stub.name,
          planets.length,
          axis,
        ),
      )
    axis *= layoutRng.range(1.4, 2.3)
  }

  return {
    id: stub.id,
    address: systemAddress(galaxy, stub.id),
    name: stub.name,
    position: stub.position,
    seed,
    star,
    planets,
    observedPlanets: observed.length,
    generation: GENERATION_VERSIONS,
  }
}

/** How close two semi-major axes have to be before they count as one orbit. */
const ORBIT_OVERLAP = 1.5

/** Planets sorted by orbit, for anything that displays a system. */
export const orbitalOrder = (system: StarSystem): readonly Body[] =>
  [...system.planets].sort(
    (a, b) => a.elements.semiMajorAxis - b.elements.semiMajorAxis,
  )

/** Depth-first walk of a system's bodies, planets before their moons. */
export function* walkBodies(system: StarSystem): Generator<Body> {
  for (const planet of system.planets) {
    yield planet
    for (const moon of planet.moons) yield moon
  }
}

export function findBody(
  system: StarSystem,
  path: readonly number[],
): Body | undefined {
  const first = path[0]
  if (first === undefined) return undefined
  let body = system.planets[first]
  for (let i = 1; i < path.length && body !== undefined; i += 1) {
    body = body.moons[path[i] as number]
  }
  return body
}

/**
 * Somewhere a ship can actually put down: solid ground, and big enough that the
 * surface is a place rather than a curiosity.
 *
 * The 1,000 km floor is what separates a world from a rubble pile — below it the
 * horizon is close enough that "landing" and "docking" stop being different
 * maneuvers. This predicate decided where every session in the game starts and
 * was written out five times as `body.kind === 'rocky' && body.radius > 1e6`,
 * which is how the client and the headless runner came to disagree about the
 * spawn distance without anything noticing.
 */
export const isLandable = (body: Body): boolean =>
  body.kind === 'rocky' && body.radius > 1e6

/** Habitable-zone check, used by the harness and the star map to pick targets. */
export function insolation(star: Star, semiMajorAxis: Meters): number {
  return star.luminosity / (4 * Math.PI * semiMajorAxis * semiMajorAxis)
}

export const isHabitable = (star: Star, body: Body): boolean =>
  body.kind === 'rocky' &&
  body.atmosphere !== null &&
  insolation(star, body.elements.semiMajorAxis) > 800 &&
  insolation(star, body.elements.semiMajorAxis) < 2_000

export const yearsOf = (seconds: Seconds): number => seconds / SECONDS_PER_YEAR
