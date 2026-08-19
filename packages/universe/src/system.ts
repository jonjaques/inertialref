import {
  AU,
  EARTH_MASS,
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
import { algorithm, deriveSeed, manifest, Rng, type Seed } from '@inertialref/procedural'
import type { Atmosphere, OrbitalElements } from '@inertialref/physics'
import { orbitalPeriod, sphereOfInfluence } from '@inertialref/physics'
import type { UniverseVector } from '@inertialref/spatial'
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
 */

export const SYSTEM_ALGORITHM = algorithm('system', 1)
export const TERRAIN_ALGORITHM = algorithm('terrain', 1)
export const GALAXY_ALGORITHM = algorithm('galaxy', 1)

export const GENERATION_VERSIONS = manifest([
  GALAXY_ALGORITHM,
  SYSTEM_ALGORITHM,
  TERRAIN_ALGORITHM,
])

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M'
export type BodyKind = 'rocky' | 'ice' | 'gas-giant' | 'ice-giant' | 'moon'

export interface Star {
  readonly name: string
  readonly spectralType: string
  readonly spectralClass: SpectralClass
  readonly mass: Kilograms
  readonly radius: Meters
  readonly temperature: Kelvin
  /** Bolometric luminosity, watts. */
  readonly luminosity: number
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

export interface StarSystem {
  readonly id: SystemId
  readonly address: UniverseAddress
  readonly name: string
  readonly position: UniverseVector
  readonly seed: Seed
  readonly star: Star
  readonly planets: readonly Body[]
  readonly generation: Readonly<Record<string, number>>
}

const mu = (mass: Kilograms): Mu => GRAVITATIONAL_CONSTANT * mass

function classify(spectralType: string): SpectralClass {
  const first = spectralType.charAt(0).toUpperCase()
  return (['O', 'B', 'A', 'F', 'G', 'K', 'M'] as const).find((c) => c === first) ?? 'M'
}

function makeStar(stub: SystemStub): Star {
  const solarMasses = stub.solarMasses
  const mass = solarMasses * SOLAR_MASS
  // Main-sequence relations: R ∝ M^0.8, L ∝ M^3.5, T from Stefan-Boltzmann.
  const radius = SOLAR_RADIUS * solarMasses ** 0.8
  const luminosity = SOLAR_LUMINOSITY * solarMasses ** 3.5
  const temperature = 5772 * solarMasses ** 0.475
  return {
    name: stub.name,
    spectralType: stub.spectralType,
    spectralClass: classify(stub.spectralType),
    mass,
    radius,
    temperature,
    luminosity,
    mu: mu(mass),
  }
}

/** Water frost line: where volatiles survive, so where giants can form. */
const frostLine = (luminosity: number): Meters => 2.7 * AU * Math.sqrt(luminosity / SOLAR_LUMINOSITY)

const DENSITY: Readonly<Record<BodyKind, number>> = {
  rocky: 5_200,
  ice: 1_900,
  moon: 3_100,
  'gas-giant': 1_330,
  'ice-giant': 1_640,
}

const radiusFromMass = (mass: Kilograms, kind: BodyKind): Meters =>
  ((3 * mass) / (4 * Math.PI * (DENSITY[kind] ?? 3_000))) ** (1 / 3)

function makeAtmosphere(rng: Rng, kind: BodyKind, radius: Meters, surfaceGravity: number): Atmosphere | null {
  if (kind === 'gas-giant' || kind === 'ice-giant') {
    return { surfaceDensity: rng.range(0.2, 1.6), scaleHeight: rng.range(20_000, 60_000), ceiling: radius * 0.06 }
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

function makeSurface(rng: Rng, seed: Seed, radius: Meters, kind: BodyKind, hasAtmosphere: boolean): SurfaceParameters {
  const relief = kind === 'gas-giant' || kind === 'ice-giant' ? 0 : rng.range(0.0005, 0.004)
  return {
    seed,
    maxElevation: radius * relief,
    roughness: rng.range(1.5, 6),
    seaLevel: hasAtmosphere && kind !== 'gas-giant' && kind !== 'ice-giant' && rng.bool(0.4)
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

  const mass = rng.powerLaw(-1.6, 1e18, Math.max(2e18, Math.min(1.5e23, parentMass * 0.012)))
  const radius = radiusFromMass(mass, 'moon')
  // Between a few parent radii and 40% of the sphere of influence. Inside that
  // lower bound is roughly the Roche limit; outside the upper bound the moon is
  // not actually bound to the planet, it is on its own orbit around the star.
  // `moonOrbitBand` guarantees the caller only asks for moons that fit.
  const [inner, outer] = moonOrbitBand(parentRadius, parentSoi)
  const semiMajorAxis = rng.range(inner, outer)
  const bodyMu = mu(mass)
  const surfaceGravity = bodyMu / (radius * radius)
  const atmosphere = radius > 1.2e6 ? makeAtmosphere(rng, 'moon', radius, surfaceGravity) : null

  const elements: OrbitalElements = {
    semiMajorAxis,
    eccentricity: rng.range(0, 0.05),
    inclination: rng.gaussian(0, 0.08),
    longitudeOfAscendingNode: rng.range(0, 2 * Math.PI),
    argumentOfPeriapsis: rng.range(0, 2 * Math.PI),
    meanAnomalyAtEpoch: rng.range(0, 2 * Math.PI),
    epoch: 0,
  }

  return {
    address,
    id: entityIdForAddress(address),
    name: `${parentName} ${MOON_SUFFIX[index] ?? String(index)}`,
    kind: 'moon',
    mass,
    radius,
    mu: bodyMu,
    elements,
    orbitalPeriod: orbitalPeriod(mu(parentMass), semiMajorAxis),
    // Tidally locked more often than not, this close in.
    rotationPeriod: rng.bool(0.7)
      ? orbitalPeriod(mu(parentMass), semiMajorAxis)
      : rng.range(0.4, 30) * SECONDS_PER_DAY,
    axialTilt: Math.abs(rng.gaussian(0, 0.15)),
    atmosphere,
    surface: makeSurface(rng, deriveSeed(seed, 'surface'), radius, 'moon', atmosphere !== null),
    sphereOfInfluence: sphereOfInfluence(semiMajorAxis, mass, parentMass),
    moons: [],
  }
}

/**
 * The band of orbits a moon can occupy: outside the Roche-ish limit, inside the
 * part of the sphere of influence where an orbit stays stable over the long
 * term (~40% of the SOI is the usual rule of thumb for prograde satellites).
 */
function moonOrbitBand(parentRadius: Meters, parentSoi: Meters): readonly [Meters, Meters] {
  return [parentRadius * 2.5, parentSoi * 0.4]
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']
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
    moons.push(makeMoon(seed, name, mass, radius, soi, m, galaxy, system, [index]))
  }

  return {
    address,
    id: entityIdForAddress(address),
    name,
    kind,
    mass,
    radius,
    mu: bodyMu,
    elements,
    orbitalPeriod: orbitalPeriod(star.mu, semiMajorAxis),
    rotationPeriod: rng.range(0.25, 3) * SECONDS_PER_DAY * (rng.bool(0.06) ? -1 : 1),
    axialTilt: Math.abs(rng.gaussian(0, 0.35)),
    atmosphere,
    surface: makeSurface(rng, deriveSeed(seed, 'surface'), radius, kind, atmosphere !== null),
    sphereOfInfluence: soi,
    moons,
  }
}

/**
 * Generate a whole system from its stub.
 *
 * Orbital radii come from a geometric progression with per-orbit jitter — the
 * Titius-Bode-shaped spacing that falls out of real formation dynamics — but
 * each planet's *properties* come from its own derived seed, so the spacing and
 * the contents are independent.
 */
export function generateSystem(rootSeed: Seed, galaxy: GalaxyId, stub: SystemStub): StarSystem {
  const seed = systemSeedOf(rootSeed, galaxy, stub.id)
  const star = makeStar(stub)
  const layoutRng = new Rng(deriveSeed(seed, 'layout'))

  const planetCount = layoutRng.weightedIndex([6, 9, 12, 14, 14, 12, 9, 7, 5, 3])
  const luminosityScale = Math.sqrt(star.luminosity / SOLAR_LUMINOSITY)
  let axis = layoutRng.range(0.06, 0.5) * AU * luminosityScale
  const planets: Body[] = []
  for (let i = 0; i < planetCount; i += 1) {
    planets.push(makePlanet(seed, star, galaxy, stub.id, stub.name, i, axis))
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
    generation: GENERATION_VERSIONS,
  }
}

/** Depth-first walk of a system's bodies, planets before their moons. */
export function* walkBodies(system: StarSystem): Generator<Body> {
  for (const planet of system.planets) {
    yield planet
    for (const moon of planet.moons) yield moon
  }
}

export function findBody(system: StarSystem, path: readonly number[]): Body | undefined {
  const first = path[0]
  if (first === undefined) return undefined
  let body = system.planets[first]
  for (let i = 1; i < path.length && body !== undefined; i += 1) {
    body = body.moons[path[i] as number]
  }
  return body
}

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
