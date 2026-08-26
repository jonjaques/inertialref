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
  STEFAN_BOLTZMANN,
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
import { ROUNDING_RADIUS } from './rounding.ts'

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

/*
 * Bumped to 3 when generated systems gained their debris.
 *
 * A version is what invalidates a save's references (`docs/design/galaxy.md`
 * Rule 1), and this changed what is *in* every system in the galaxy: six to
 * eighteen small bodies per system, at addresses past the last planet. Nothing
 * a save could already point at moved — that is the whole point of issue
 * ordinals — but a system now contains things it did not, and a manifest that
 * did not say so would let two builds of the game disagree about the contents
 * of the same address space with nothing to notice.
 */
export const SYSTEM_ALGORITHM = algorithm('system', 3)
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

/*
 * What a body *is*, which decides how it is generated and how it is drawn.
 *
 * The last three arrived with the small bodies and are not cosmetic labels.
 * They are the classes gravity never rounded off: a `dwarf` is round and a
 * world, an `asteroid` and a `comet` are usually neither, and the renderer
 * asks this question to decide whether to draw a sphere at all.
 */
export type BodyKind =
  | 'rocky'
  | 'ice'
  | 'gas-giant'
  | 'ice-giant'
  | 'moon'
  | 'dwarf'
  | 'asteroid'
  | 'comet'

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

/**
 * The measured figure of a body that gravity did not round off.
 *
 * `radius` and `polarRadius` describe a spheroid, which is the right shape for
 * everything hydrostatic equilibrium got hold of — every planet, every large
 * moon, Pluto and Ceres. Below roughly 400 km across, self-gravity loses to
 * material strength and the body keeps whatever shape the last collision left
 * it. Phobos is 27 × 22 × 18 km with a nine-kilometer crater in one end;
 * Kleopatra is a dog bone; Bennu is a spinning top. A spheroid cannot say any
 * of that, and drawing one is not an approximation of those bodies, it is a
 * picture of a different object.
 *
 * Present exactly when the body is *not* a spheroid. Null is not "unknown", it
 * is "round", and the renderer reads it that way.
 */
export interface BodyFigure {
  /**
   * The second equatorial half-extent, meters.
   *
   * `radius` is a and `polarRadius` is c; this is b. It lives here rather than
   * as a third top-level radius because `a = b` for every hydrostatic body
   * there is, so on a spheroid the field would be a third number restating the
   * first. In Sol that is 37 bodies it would be redundant on against 92 it is
   * load-bearing for; across the galaxy the ratio inverts, because a generated
   * system is mostly round worlds with a belt. Either way the field belongs
   * with the bodies that need it rather than on the ones that do not.
   */
  readonly intermediateRadius: Meters
  /**
   * Key into the shape-model manifest, or null.
   *
   * A key, not a path, for the same reason `BodyAppearance.texture` is one:
   * `packages/universe` cannot fetch anything and must not know what a URL is.
   * A key with no entry falls back to the generated figure below, which is why
   * this can name a model that has not been vendored yet.
   */
  readonly model: string | null
  /**
   * Radial roughness as a fraction of the mean radius, for the generated
   * figure that stands in when there is no model.
   *
   * The measured half-extents are a fact and this is not; it is the same split
   * `SurfaceParameters` makes, where the published relief is used verbatim and
   * the shape below the map's resolution is drawn from the seed. A body with a
   * model ignores it.
   */
  readonly irregularity: number
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
  /** The measured figure, for a body that is not a spheroid. See `BodyFigure`. */
  readonly figure: BodyFigure | null
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
  // Pluto is 1,853 and Ceres 2,162: an ice-rock mix, closer to a large moon
  // than to anything else.
  dwarf: 2_000,
  // Measured across the visited ones. Bennu and Ryugu are 1.19 and 1.27 —
  // rubble piles are half void — and Vesta is 3.46 because it is differentiated.
  asteroid: 2_400,
  // 67P came out at 533 kg/m³, which is less dense than balsa. A comet nucleus
  // is mostly hole.
  comet: 600,
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
  /*
   * Most generated moons are rocks, and now look like it.
   *
   * The mass draw runs from 10¹⁸ kg — a 42 km body — up to a Titan, so a
   * majority of them land below the rounding threshold. They were all drawn as
   * spheroids until the Solar System's own small bodies forced the question,
   * and every irregular moon in the galaxy was a ball with a normal map. This
   * is the change that makes the other five hundred billion systems as lumpy as
   * the one we live in.
   */
  const shape = irregularFigure(rng, radius)

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
    radius: shape?.radius ?? radius,
    polarRadius:
      shape?.polarRadius ??
      radius * (1 - rotationalFlattening(mass, radius, rotationPeriod)),
    figure: shape?.figure ?? null,
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
    // A planet is a world by definition — the generator's smallest is a
    // thousand kilometers across. Rocks are moons and small bodies.
    figure: null,
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

/*
 * Re-exported, not defined here: it is read on both sides of the
 * `system.ts` ↔ `solar/system.ts` import cycle, and a value read at module
 * scope across that edge is a TDZ crash. `rounding.ts` explains the whole
 * thing.
 */
export { ROUNDING_RADIUS }

/**
 * A generated body's figure, from the twenty-five that have been measured.
 *
 * The numbers below are not invented. `data/shapes/manifest.json` holds
 * published shape models of everything from a 13 m rock to Vesta, and the
 * distribution across them is:
 *
 * ```
 *                                    min    median      max
 *   b / a                           0.43      0.74     0.99
 *   c / b                           0.71      0.87     1.00
 *   rms(r) about the fitted         0.023     0.090    0.61
 *     ellipsoid, over the mean
 * ```
 *
 * The third row is the residual *after* the ellipsoid is taken out, which is
 * what `BodyFigure.irregularity` means — the elongation is already carried by
 * the two rows above it, and measuring the roughness against a sphere would
 * count it twice.
 *
 * The one clear trend is the threshold: the two bodies above 200 km — Vesta
 * and Proteus — have a/c of 1.21 and 1.09, and everything below it is scattered
 * from 1.05 (Mathilde, a ball) to 2.89 (Eros, a banana) with no strong size
 * dependence inside the range. So the model is a threshold plus a spread, not
 * a formula: elongation is switched on below `ROUNDING_RADIUS` and ramps with
 * how far below, and *within* that it is a wide draw, because that is what the
 * measurements say. A tidy monotonic function of radius would fit the data
 * worse and look more scientific, which is the wrong trade.
 *
 * Returns null for a body gravity has rounded — the caller keeps its spheroid,
 * including its rotational flattening, which is a different and real effect.
 */
export function irregularFigure(
  rng: Rng,
  meanRadius: Meters,
): { radius: Meters; polarRadius: Meters; figure: BodyFigure } | null {
  if (meanRadius >= ROUNDING_RADIUS) return null
  const strength = Math.min(1, 1 - meanRadius / ROUNDING_RADIUS)
  const bOverA = 1 - strength * rng.range(0.05, 0.55)
  const cOverB = 1 - strength * rng.range(0.02, 0.3)
  /*
   * Volume is the thing that must not move: it came from the mass and the class
   * density, and a figure that quietly changed it would change the body's
   * density instead. `a·b·c = r̄³`.
   *
   * What that costs, named because it is a real difference between the two
   * kinds of body: for a body with a *shipped model* `radius` is the measured
   * bounding box, so the drawn silhouette never exceeds it. Here it is the
   * reference *ellipsoid's* semi-axis, and the generated lumps stand above it —
   * about 17% at the median roughness and up to 55% at the top of the range.
   * Both normalizations are defensible and they cannot both hold for a lumpy
   * body, because a body with the same volume as an ellipsoid has a larger
   * bounding box than one. The volume is chosen because the mass depends on it
   * and nothing depends on the bounding box except the angular radius the LOD
   * tiers are picked from, which is a tier boundary rather than a fact.
   */
  const a = meanRadius / (bOverA * bOverA * cOverB) ** (1 / 3)
  const b = a * bOverA
  const c = b * cOverB
  return {
    radius: a,
    polarRadius: c,
    figure: {
      intermediateRadius: b,
      // Nobody has been here. The figure below the half-extents is the seed's.
      model: null,
      // The measured residual range, ramped by the same distance below the
      // rounding threshold that sets the elongation. A body just under 200 km
      // is smooth *and* nearly round; a ten-kilometer one is neither.
      irregularity: strength * rng.range(0.02, 0.3),
    },
  }
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
  dwarf: { r: 0.52, g: 0.47, b: 0.44 },
  // A C-type asteroid reflects four percent of the light that reaches it,
  // which is darker than coal and darker than anything a palette wants to be.
  asteroid: { r: 0.14, g: 0.13, b: 0.12 },
  // Halley's nucleus is the darkest object ever imaged in the Solar System.
  comet: { r: 0.1, g: 0.1, b: 0.1 },
}

const KIND_ALBEDO: Readonly<Record<BodyKind, number>> = {
  rocky: 0.15,
  ice: 0.5,
  moon: 0.12,
  'gas-giant': 0.5,
  'ice-giant': 0.45,
  dwarf: 0.3,
  asteroid: 0.09,
  comet: 0.04,
}

const KIND_ROUGHNESS: Readonly<Record<BodyKind, number>> = {
  rocky: 0.95,
  ice: 0.55,
  moon: 0.95,
  'gas-giant': 1,
  'ice-giant': 1,
  dwarf: 0.8,
  asteroid: 0.98,
  comet: 0.98,
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
  // Pluto's haze really is blue, for the same Rayleigh reason Earth's is, and
  // New Horizons photographed it backlit to prove it.
  dwarf: {
    colour: { r: 0.45, g: 0.6, b: 0.9 },
    limb: { r: 0.8, g: 0.7, b: 0.6 },
  },
  // Neither of these can hold an atmosphere; a comet's coma is not one, and is
  // not drawn as one. Present so the record is total rather than because it is
  // ever read.
  asteroid: {
    colour: { r: 0.4, g: 0.4, b: 0.4 },
    limb: { r: 0.5, g: 0.5, b: 0.5 },
  },
  comet: {
    colour: { r: 0.5, g: 0.62, b: 0.7 },
    limb: { r: 0.7, g: 0.78, b: 0.8 },
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
    // Every confirmed exoplanet was found by transit or radial velocity, and
    // neither method can see a shape. A figure here would be an invention
    // about a real object, which is the one thing `provenance: 'observed'`
    // promises this record is not.
    figure: null,
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
  // system where every body is known — a hundred and twenty-nine of them, with
  // measured radii, oblateness, tilts, albedos and, for ninety-two, a figure
  // gravity never rounded off — so it is built from those rather than from a
  // seed. See `solar/system.ts`.
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

  /*
   * And then the debris.
   *
   * Issued after every planet, which is what keeps a system's planets at the
   * addresses they had before this existed — `b:3` was the fourth planet and
   * stays the fourth planet. See ADR-0009.
   *
   * The count is not a constant: a system with more planets has more of them,
   * because a belt is what is left over from making the planets and there is
   * more left over where more was made. Six to eighteen is a *sample* of a
   * population that in reality runs to millions, drawn large enough to be a
   * belt and small enough that the renderer can put every one of them on
   * screen at once — which it will, from the planetarium, at Sol's own scale.
   */
  const debrisRng = new Rng(deriveSeed(seed, 'debris'))
  const debrisCount = 6 + debrisRng.int(0, 6) + Math.min(6, planets.length)
  const frost = frostLine(star.luminosity)
  /*
   * How big this system's biggest rock is.
   *
   * Ceres is 470 km and is the largest thing in the Solar System's belt by a
   * factor of two. Log-uniform from 40 to 500 km, because a debris disc's total
   * mass is not something the generator knows and the observed range across the
   * discs that *have* been imaged is at least that wide — some systems have a
   * Ceres and some have nothing over a Vesta.
   */
  const largestRadius = 40_000 * (500 / 40) ** debrisRng.range(0, 1)
  let rank = 0
  for (let i = 0; i < debrisCount; i += 1) {
    /*
     * Where debris survives: a belt just inside the innermost giant, a
     * scattered population outside everything, and comets from further out
     * still. The three bands are drawn in the *log* of the axis, because a
     * system spans four orders of magnitude in radius and a uniform draw puts
     * everything in the outermost decade.
     */
    const band = debrisRng.weightedIndex([55, 30, 15])
    const axis = Math.max(
      // The same floor the eccentricity is truncated against, so a circular
      // body in the innermost band is outside it too.
      3 * star.radius,
      band === 0
        ? frost * debrisRng.range(0.5, 1.1)
        : band === 1
          ? frost * debrisRng.range(1.6, 9)
          : frost * debrisRng.range(6, 60),
    )
    const crowded = planets.some((planet) => {
      const known = planet.elements.semiMajorAxis
      return axis / known < DEBRIS_OVERLAP && known / axis < DEBRIS_OVERLAP
    })
    if (crowded) continue
    planets.push(
      makeSmallBody(
        seed,
        star,
        galaxy,
        stub.id,
        stub.name,
        planets.length,
        rank,
        // A comet is not a belt member and does not come off the belt's size
        // ladder: cometary nuclei run from Hartley 2 at a kilometer to
        // Hale-Bopp at thirty, whatever else the system has.
        band === 2 ? 1_000 + debrisRng.range(0, 20_000) : largestRadius,
        axis,
        band === 2 ? 'comet' : 'asteroid',
      ),
    )
    if (band !== 2) rank += 1
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

/* ------------------------------------------------------------------------- */
/* Small bodies                                                               */
/* ------------------------------------------------------------------------- */

/**
 * The debris a system keeps, which is most of what is in one.
 *
 * Every star system that formed planets has leftovers: the Solar System has a
 * main belt, two Trojan swarms, a Kuiper belt and a comet reservoir, and the
 * count of *named* small bodies passed a million while this was being written.
 * Until they were generated, every system in the galaxy except Sol had exactly
 * planets and moons in it and nothing else — a tidy, empty diagram of a system
 * rather than a system.
 *
 * Three things here are measured rather than chosen, and they are the three
 * that make a generated belt read as one.
 *
 * **The size distribution is Dohnanyi's.** A population grinding itself down by
 * collisions reaches a steady state with `dN/dD ∝ D^-3.5`, derived in 1969 and
 * measured in the main belt ever since. It is why there is one Ceres, a
 * handful of 200 km bodies and a million kilometer-sized ones — and why a
 * uniform draw over a size range, which is what a generator reaches for first,
 * produces a belt of implausibly similar boulders.
 *
 * **The spin barrier is real.** Nothing above about 200 m across rotates faster
 * than 2.2 hours. It is not a coincidence and not a selection effect: a rubble
 * pile held together by its own gravity comes apart at that rate, and the
 * handful of known fast rotators are monolithic fragments below the threshold.
 * The distribution below respects it, which means a generated asteroid can be a
 * four-hour rotator and cannot be a one-hour one.
 *
 * **Where they are is where a planet is not.** Debris survives in the gaps —
 * the main belt sits between Mars and Jupiter because Jupiter stopped a planet
 * forming there — so a body drawn on top of a planet's orbit is dropped rather
 * than nudged, exactly as a projected planet is, and for the same reason: a
 * nudge would make one body's orbit depend on another's.
 */
function makeSmallBody(
  systemSeed: Seed,
  star: Star,
  galaxy: GalaxyId,
  system: SystemId,
  systemName: string,
  index: number,
  /** Position in this system's own debris list, largest first. */
  rank: number,
  /** The mean radius of this belt's biggest member. */
  largestRadius: Meters,
  semiMajorAxis: Meters,
  band: 'asteroid' | 'comet',
): Body {
  /*
   * Nothing survives inside the sublimation radius, so the population is
   * truncated there rather than clamped.
   *
   * Silicate goes to vapor around 1,500 K, which for a given star is at
   * `sqrt(L / 16πσT⁴)` — 0.034 AU for the Sun, about seven solar radii, which
   * is where sungrazing comets stop coming back. A body whose periapsis would
   * be inside it is not a body with a bad orbit, it is a body that is no longer
   * there, and the surviving distribution is cut off exactly at that line. This
   * is what stopped the generator putting a rock on a 0.047 AU periapsis around
   * a ten-solar-radius giant.
   */
  const sublimation = Math.sqrt(
    star.luminosity / (16 * Math.PI * STEFAN_BOLTZMANN * 1_500 ** 4),
  )
  const survives = Math.max(sublimation, 2.5 * star.radius)
  const seed = deriveSeed(systemSeed, `b:${index}`)
  const rng = new Rng(seed)
  const address = bodyAddress(galaxy, system, [index])

  /*
   * Dohnanyi, sampled from the top rather than at random — and the difference
   * is the whole reason a first attempt at this produced an invisible belt.
   *
   * `dN/dD ∝ D^-3.5` means the population is overwhelmingly small: there is one
   * Ceres and something like a million kilometer-sized rocks. Draw fourteen
   * bodies at random from that and all fourteen are kilometer-sized, which is
   * physically correct and useless — a belt nobody can see is a belt nobody
   * has.
   *
   * What a system actually *presents* is its largest members. So the draw is
   * the order statistic: for a Dohnanyi population the k-th largest body scales
   * as `k^(-1/2.5)`, and the belt is parameterized by its biggest member
   * instead of by its smallest. `rank` comes in from the caller as the index
   * within this system's debris, so the first is the belt's Ceres and the
   * fourteenth is about a third of its size — which is the spread the real main
   * belt's top fourteen have.
   */
  /*
   * The ladder is the *belt's*, so a comet does not climb it.
   *
   * `rank` is the count of asteroids already issued in this system, and the
   * caller never advances it for a comet — it passes a nucleus size drawn on
   * its own ("A comet is not a belt member and does not come off the belt's
   * size ladder"). Applying the order statistic anyway divided that nucleus by
   * however many rocks happened to precede it: at eighteen bodies a comet drawn
   * last came out at `16 ** -0.4 = 0.33` of its size, so a 20 km nucleus became
   * 6.6 km and the same comet drawn first stayed 20 km. Comet size was a
   * function of draw order rather than of the comet.
   */
  const ladder = band === 'comet' ? 1 : (rank + 1) ** -0.4
  const meanRadius = largestRadius * ladder * rng.range(0.75, 1.25)
  /*
   * A belt's largest member is often not an asteroid.
   *
   * Ceres is 470 km across and round, and it is a dwarf planet rather than an
   * asteroid for exactly that reason — the 2006 vote turned on hydrostatic
   * equilibrium and nothing else. `ROUNDING_RADIUS` is the same threshold
   * `irregularFigure` uses to decide whether to hand a body a figure at all, so
   * classifying here keeps the two from disagreeing: a body cannot come out
   * round *and* be called an asteroid.
   */
  const kind: BodyKind =
    band === 'asteroid' && meanRadius >= ROUNDING_RADIUS ? 'dwarf' : band
  const density = DENSITY[kind]

  const mass = (4 / 3) * Math.PI * meanRadius ** 3 * density
  const shape = irregularFigure(rng, meanRadius)

  /*
   * The spin barrier, as the floor of the distribution rather than a clamp.
   *
   * 2.2 hours is where a strengthless rubble pile comes apart under its own
   * rotation: `T = sqrt(3π / Gρ)`, which at 2 g/cm³ is 2.33 h. Every asteroid
   * above about 200 m across obeys it — the measured population piles up
   * against the barrier and does not cross it, and the handful of known faster
   * rotators are monolithic fragments below the size where cohesion stops
   * mattering. It is one of the cleanest signals in the whole light-curve
   * database and it is free to reproduce.
   *
   * Above the barrier the measured distribution is roughly log-normal about
   * eight hours, with a genuine slow tail: 253 Mathilde takes 17 days and 3548
   * Leucus 18. So: a log-normal, floored at the barrier, plus one body in eight
   * that is a slow tumbler.
   */
  const spinBarrier = Math.sqrt(
    (3 * Math.PI) / (GRAVITATIONAL_CONSTANT * density),
  )
  const rotationPeriod =
    (rng.bool(0.125)
      ? rng.range(2, 20) * SECONDS_PER_DAY
      : Math.max(spinBarrier, 8 * 3_600 * Math.exp(rng.gaussian(0, 0.7)))) *
    // Retrograde about a third of the time. Small bodies are spun by the YORP
    // effect and by collisions, and neither prefers a direction.
    (rng.bool(0.35) ? -1 : 1)

  const elements: OrbitalElements = {
    semiMajorAxis,
    /*
     * A comet is defined by its orbit rather than by its composition — the
     * difference between 2060 Chiron the asteroid and 95P/Chiron the comet is
     * that somebody saw a coma. So an eccentricity above 0.5 makes it one, and
     * the two draws are the two populations: a belt member scattered by
     * resonances, and something falling in from the cold.
     */
    eccentricity: Math.min(
      // The truncation: whatever was drawn, or the most this orbit can carry
      // and still clear the sublimation radius at periapsis.
      Math.max(0, 1 - survives / semiMajorAxis),
      band === 'comet'
        ? rng.range(0.55, 0.97)
        : Math.abs(rng.gaussian(0, 0.12)),
    ),
    // Belt inclinations run to 30° and comets arrive from anywhere, which is
    // what makes a comet look like a comet in a system diagram: it is the one
    // thing not in the plane.
    inclination:
      band === 'comet'
        ? rng.range(0, Math.PI)
        : Math.abs(rng.gaussian(0, 0.17)),
    longitudeOfAscendingNode: rng.range(0, 2 * Math.PI),
    argumentOfPeriapsis: rng.range(0, 2 * Math.PI),
    meanAnomalyAtEpoch: rng.range(0, 2 * Math.PI),
    epoch: 0,
  }

  const bodyMu = mu(mass)
  const insolationHere = insolation(star, semiMajorAxis)
  const surfaceSeed = deriveSeed(seed, 'surface')
  return {
    address,
    id: entityIdForAddress(address),
    name: `${systemName} ${designation(index)}`,
    kind,
    provenance: 'projected',
    measurement: null,
    mass,
    radius: shape?.radius ?? meanRadius,
    polarRadius: shape?.polarRadius ?? meanRadius,
    figure: shape?.figure ?? null,
    appearance: {
      texture: null,
      maps: [],
      // The figure is the relief; see `solar/smallBodies.ts`.
      relief: 0,
      geometricAlbedo: KIND_ALBEDO[kind],
      roughness: KIND_ROUGHNESS[kind],
      clouds: null,
      rings: null,
      haze: null,
      /*
       * Darker the further out, and the reason is chemistry rather than light.
       *
       * The inner belt is S-type — silicate, 20% albedo — and the outer belt
       * and beyond are C- and D-type, carbonaceous and organic-rich, down to
       * 4%. The transition is at the frost line, because that is where
       * volatiles and the organics that come with them survive. It is the
       * clearest compositional gradient in the Solar System and it costs one
       * interpolation.
       */
      colour: darkening(KIND_COLOUR[kind], insolationHere, rng),
    },
    mu: bodyMu,
    elements,
    orbitalPeriod: orbitalPeriod(star.mu + bodyMu, semiMajorAxis),
    rotationPeriod,
    // Whatever the last collision left. Small bodies have no preferred axis,
    // which is why Uranus's 98° is remarkable and 4179 Toutatis's is not.
    axialTilt: Math.acos(rng.range(-1, 1)),
    atmosphere: null,
    surface: {
      seed: surfaceSeed,
      maxElevation: 0,
      roughness: rng.range(2, 6),
      seaLevel: null,
    },
    sphereOfInfluence: sphereOfInfluence(semiMajorAxis, mass, star.mass),
    moons: [],
  }
}

/**
 * Surface color from where the body formed.
 *
 * `insolation` at the frost line is about 350 W/m² for any star, because the
 * frost line is *defined* by the equilibrium temperature. Inside it a body is
 * silicate and reflects a fifth of what hits it; outside it, carbonaceous and
 * reflects a twentieth.
 */
function darkening(
  base: LinearRgb,
  insolationHere: number,
  rng: Rng,
): LinearRgb {
  const inner = Math.min(1, Math.max(0, Math.log10(insolationHere / 60) / 1.2))
  const brightness = (0.55 + 1.5 * inner) * rng.range(0.8, 1.25)
  return {
    r: base.r * brightness,
    g: base.g * brightness * (0.94 + 0.06 * inner),
    b: base.b * brightness * (0.88 + 0.12 * inner),
  }
}

/**
 * A provisional designation, which is what a small body has instead of a name.
 *
 * Real ones look like `2004 MN4` until somebody names them, and the vast
 * majority never are: fewer than 25,000 of the 1.4 million numbered bodies have
 * a name. A generated system's debris gets the same treatment — an index and a
 * letter pair — because giving every rock in the galaxy a proper noun is the
 * single fastest way to make a generated universe read as generated.
 */
const DESIGNATION_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
function designation(index: number): string {
  const first = DESIGNATION_LETTERS[index % DESIGNATION_LETTERS.length] ?? 'A'
  const second =
    DESIGNATION_LETTERS[
      Math.floor(index / DESIGNATION_LETTERS.length) %
        DESIGNATION_LETTERS.length
    ] ?? 'A'
  return `${first}${second}${index}`
}

/** How close two semi-major axes have to be before they count as one orbit. */
const ORBIT_OVERLAP = 1.5

/**
 * The same question for a small body, and a very different answer.
 *
 * Two planets a factor of 1.5 apart would be a system nobody believes. A small
 * body a factor of 1.5 from a planet is *the main belt*: 2.1 AU against Mars at
 * 1.52 is a ratio of 1.38, and the first draft of this dropped every asteroid
 * the real Solar System has. Debris belongs in the gaps between worlds and, in
 * the Trojan case, exactly on top of one — so the exclusion here is only wide
 * enough to stop a rock being drawn visibly inside a planet's own orbit.
 */
const DEBRIS_OVERLAP = 1.08

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

/**
 * Debris: the classes a planetarium draws only when they are the subject.
 *
 * A planetarium draws a subject's siblings to show where it sits, which was
 * unambiguous while a star's children were eight planets. Sol has sixty-six,
 * and fifty-nine of them are rubble — drawn all at once they are a cage of a
 * hundred and twenty-nine lines with the subject somewhere behind it.
 *
 * A `Record<BodyKind, boolean>` rather than a `Set<string>`, and exported
 * rather than written out at each site, because it was written out at three:
 * `RUBBLE` in `GameEngine`, `WORLD_KINDS` in `universe.test.ts` and
 * `PLANET_KINDS` in `ingest.test.ts`, all untyped string sets. A ninth
 * `BodyKind` compiled against every one of them and landed silently in the
 * wrong half of all three. Against this table it is a type error.
 *
 * A dwarf is *not* debris. Pluto, Ceres, Eris, Haumea and Makemake are the
 * bodies a planetarium user most wants context for — "where does Pluto's orbit
 * cross Neptune's" is the question the 2006 vote was about — and there are nine
 * of them, not fifty-nine.
 */
const DEBRIS: Readonly<Record<BodyKind, boolean>> = {
  rocky: false,
  ice: false,
  'gas-giant': false,
  'ice-giant': false,
  moon: false,
  dwarf: false,
  asteroid: true,
  comet: true,
}

/** Whether a body's orbit is rubble rather than context. See `DEBRIS`. */
export const isDebris = (kind: BodyKind): boolean => DEBRIS[kind]

/**
 * The classes that are planets, which since 2006 is a question about roundness
 * *and* about having cleared the neighborhood. `system.planets` holds every
 * body orbiting the star, so this is what separates the eight from the rest.
 */
const PLANET: Readonly<Record<BodyKind, boolean>> = {
  rocky: true,
  ice: true,
  'gas-giant': true,
  'ice-giant': true,
  moon: false,
  dwarf: false,
  asteroid: false,
  comet: false,
}

/** Whether a body is a planet by the IAU definition. See `PLANET`. */
export const isPlanetKind = (kind: BodyKind): boolean => PLANET[kind]

/**
 * How many of a system's bodies are planets.
 *
 * `system.planets` is every body orbiting the star, which since the small
 * bodies landed is 66 for Sol rather than 8 — so `planets.length` stopped
 * being the number anything should show a player. Four call sites rendered it
 * beside the literal word "planets" and read "G2V · 66 planets".
 *
 * Not `observedPlanets`: that field is 0 for a real catalog star nobody has
 * found a planet around yet, and it means something different again for a
 * generated system.
 */
export const planetCount = (system: StarSystem): number =>
  system.planets.reduce((n, body) => n + (isPlanetKind(body.kind) ? 1 : 0), 0)

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
