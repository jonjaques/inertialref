import {
  GRAVITATIONAL_CONSTANT,
  type Meters,
  type Mu,
  SOLAR_LUMINOSITY,
  SOLAR_MASS,
  SOLAR_RADIUS,
} from '@inertialref/shared'
import { deriveSeed, Rng, type Seed } from '@inertialref/procedural'
import type { Atmosphere, OrbitalElements } from '@inertialref/physics'
import { orbitalPeriod, sphereOfInfluence } from '@inertialref/physics'
import {
  bodyAddress,
  entityIdForAddress,
  type GalaxyId,
  type SystemId,
  systemAddress,
  systemId,
} from '../address.ts'
import { blackbodyColour } from '../catalog/photometry.ts'
import type { SystemStub } from '../galaxy.ts'
import { systemSeedOf } from '../galaxy.ts'
import {
  type Body,
  type BodyAppearance,
  GENERATION_VERSIONS,
  type Star,
  type StarSystem,
  type SurfaceParameters,
} from '../system.ts'
import { SOLAR_PLANETS, type SolarBody } from './bodies.ts'
import { SOLAR_SMALL_BODIES } from './smallBodies.ts'

/*
 * Sol, built from measurements rather than from a seed.
 *
 * Every other system in the game is a real star with projected bodies around
 * it. This is the one where the whole system is known — a hundred and twenty-nine
 * bodies the player has seen photographs of — so a generated substitute
 * would not merely be unverifiable, it would be visibly and embarrassingly
 * wrong. `docs/design/charter.md` calls Sol home; this is what that costs.
 *
 * The split is the same one the rest of the generator uses. Anything published
 * is used verbatim and marked `observed`: radii, masses, oblateness, rotation
 * periods, axial tilts, orbits, albedos, ring geometry, atmospheric density
 * profiles. Anything nobody publishes is drawn from the body's own seed exactly as a
 * projected world's would be — where a moon is along its orbit right now, and
 * what its terrain looks like at a hundred meters.
 */

export const SOL: SystemId = systemId('SOL')

const mu = (mass: number): Mu => GRAVITATIONAL_CONSTANT * mass

/**
 * The Sun, from the IAU's defining constants rather than from its own catalog
 * row.
 *
 * The photometric pipeline reads Sol's HYG entry back as 0.973 L☉ and 0.987 R☉,
 * which is a 2.7% error and a fair measure of how well the method works — see
 * `catalog/photometry.ts`. For every other star that is the best available
 * answer. For this one there is a *defined* answer, and using the estimate
 * instead would make the one object every player can check the only one that is
 * knowably wrong.
 */
function theSun(name: string): Star {
  const temperature = 5_772
  return {
    name,
    spectralType: 'G2V',
    spectralClass: 'G',
    mass: SOLAR_MASS,
    radius: SOLAR_RADIUS,
    temperature,
    luminosity: SOLAR_LUMINOSITY,
    colour: blackbodyColour(temperature),
    mu: mu(SOLAR_MASS),
  }
}

const appearanceOf = (body: SolarBody): BodyAppearance => ({
  texture: body.texture,
  // Which maps exist is the manifest's business, not this file's: the host
  // resolves the key and uses whatever it finds. Listing them here would be a
  // second description of `data/textures/manifest.json` to fall out of step
  // with it.
  maps: [],
  relief: body.relief,
  geometricAlbedo: body.geometricAlbedo,
  roughness: body.roughness,
  clouds: body.clouds,
  rings: body.rings,
  haze: body.haze,
  // Tints an albedo map that is grayscale — three of the four Galilean moons
  // were mapped in monochrome — and stands in entirely before the texture
  // arrives, so a body reads as itself on the first frame rather than as white.
  colour: body.tint,
})

const atmosphereOf = (body: SolarBody): Atmosphere | null =>
  body.atmosphere === null
    ? null
    : {
        surfaceDensity: body.atmosphere.surfaceDensity,
        scaleHeight: body.atmosphere.scaleHeight,
        ceiling: body.atmosphere.ceiling,
      }

/**
 * Terrain parameters for a body that has a real elevation map.
 *
 * `relief` is measured — Olympus Mons really is 29 km above Hellas — so
 * `maxElevation` is a fact here rather than a draw. The *shape* at scales below
 * the map's resolution is still generated, because a global map is a few
 * kilometers per pixel and a ship on final approach is looking at meters.
 */
function surfaceOf(body: SolarBody, seed: Seed, rng: Rng): SurfaceParameters {
  return {
    seed,
    maxElevation: body.relief / 2,
    roughness: rng.range(2, 5),
    // Earth is the only body here with a sea, and its datum is what "sea level"
    // means in the first place.
    seaLevel: body.name === 'Earth' ? 0.55 : null,
  }
}

function buildBody(
  parentSeed: Seed,
  parentMu: Mu,
  parentMass: number,
  galaxy: GalaxyId,
  system: SystemId,
  path: readonly number[],
  body: SolarBody,
): Body {
  /*
   * The address *is* the seed path (ADR-0005), and this has to derive it the
   * same way every other generator does: one `deriveSeed` per label, chained
   * from the parent. Joining the path into a single label — `b:5/b:3` — is a
   * different seed, and `universe.test.ts` compares against
   * `derivePath(root, addressLabels(address))` precisely so that a second
   * generator cannot quietly invent its own convention.
   */
  const index = path[path.length - 1] as number
  const seed = deriveSeed(parentSeed, `b:${index}`)
  const rng = new Rng(seed)
  const address = bodyAddress(galaxy, system, path)
  const bodyMu = mu(body.mass)

  /*
   * Both draws happen whichever branch is taken.
   *
   * `rng` is a stream and this is the rule about not making generation depend
   * on order, in its smallest possible form: reading the seed only when the
   * published value is absent would make every *later* draw for this body —
   * its terrain seed, its roughness — depend on whether JPL happens to publish
   * a node for it. Draw, then override.
   */
  const nodeDraw = rng.range(0, 2 * Math.PI)
  const anomalyDraw = rng.range(0, 2 * Math.PI)
  const drawnNode = body.ascendingNode ?? nodeDraw
  const drawnAnomaly = body.meanAnomaly ?? anomalyDraw

  const elements: OrbitalElements = {
    semiMajorAxis: body.semiMajorAxis,
    eccentricity: body.eccentricity,
    inclination: body.inclination,
    /*
     * Where the body is *right now*, when anybody has published it.
     *
     * The satellite tables do not carry a consistent node or mean anomaly, and
     * where a moon is on a given tick is a phase rather than a fact — so those
     * are drawn from the body's own seed, exactly as a projected world's are.
     * The small bodies are the other case: JPL publishes a full osculating
     * element set for every numbered asteroid and comet, and *where Halley is*
     * is something a player will check. Two draws either way, so the order of
     * the stream does not depend on which branch is taken.
     */
    longitudeOfAscendingNode: drawnNode,
    argumentOfPeriapsis: body.argumentOfPeriapsis,
    meanAnomalyAtEpoch: drawnAnomaly,
    epoch: 0,
  }

  const soi = sphereOfInfluence(body.semiMajorAxis, body.mass, parentMass)
  const moons: Body[] = []
  for (let m = 0; m < body.moons.length; m += 1) {
    const satellite = body.moons[m] as SolarBody
    moons.push(
      buildBody(
        seed,
        bodyMu,
        body.mass,
        galaxy,
        system,
        [...path, m],
        satellite,
      ),
    )
  }

  return {
    address,
    id: entityIdForAddress(address),
    name: body.name,
    kind: body.kind,
    provenance: 'observed',
    measurement: {
      massIsLowerBound: false,
      massInferred: false,
      radiusInferred: false,
      discoveryYear: body.discoveryYear,
      discoveryMethod: 'Direct Observation',
      insolation: null,
      // Not `body.temperature`: that is the mean *surface* (or 1-bar)
      // temperature, and the field's contract is the published equilibrium
      // temperature — for Venus those are 737 K and ~227 K, and a panel
      // labeling the first as the second would be wrong about the most
      // checkable planet in the game. Null until the data table carries the
      // actual equilibrium values.
      equilibriumTemperature: null,
    },
    mass: body.mass,
    radius: body.radius,
    polarRadius: body.polarRadius,
    // Straight through. Sol is the one system where a body's figure is a
    // measurement rather than a draw, and this is where that arrives.
    figure: body.figure,
    appearance: appearanceOf(body),
    mu: bodyMu,
    elements,
    // `G(M + m)`: the Moon is 1.2% of Earth and the difference is 0.5% of its
    // period, which is the gap between the published 27.3217 days and 27.45.
    orbitalPeriod: orbitalPeriod(parentMu + bodyMu, body.semiMajorAxis),
    rotationPeriod: body.rotationPeriod,
    axialTilt: body.axialTilt,
    atmosphere: atmosphereOf(body),
    surface: surfaceOf(body, deriveSeed(seed, 'surface'), rng),
    sphereOfInfluence: soi,
    moons,
  }
}

/**
 * The Solar System.
 *
 * Planets in orbital order, which for this one system is also the issue order:
 * six were known before anyone was numbering anything, and Uranus and Neptune
 * were found in that order and are the outermost two anyway. Every other system
 * issues by discovery, and the two orders diverge; here they do not, which is a
 * coincidence worth noting so nobody later reads it as the rule.
 */
export function solarSystem(
  rootSeed: Seed,
  galaxy: GalaxyId,
  stub: SystemStub,
): StarSystem {
  const seed = systemSeedOf(rootSeed, galaxy, stub.id)
  const star = theSun(stub.name)
  /*
   * Planets first, then everything else, and the order is load-bearing.
   *
   * `b:2` is Earth because Earth was the third body *issued* in this system,
   * and ADR-0009 is that an address is an issue ordinal rather than a
   * position. Appending the fifty-nine small bodies after the eight planets
   * is what keeps every save, every bookmark and every cutscene that names
   * `b:2` pointing at Earth. Putting Ceres between Mars and Jupiter — where it
   * is — would renumber half the system.
   */
  const planets = [...SOLAR_PLANETS, ...SOLAR_SMALL_BODIES].map(
    (planet, index) =>
      buildBody(seed, star.mu, star.mass, galaxy, stub.id, [index], planet),
  )
  return {
    id: stub.id,
    address: systemAddress(galaxy, stub.id),
    name: stub.name,
    position: stub.position,
    seed,
    star,
    planets,
    // Eight. The small bodies are observed, and they are not planets — that
    // distinction is what the 2006 IAU vote was about, and this field is the
    // one place in the codebase where the answer matters.
    observedPlanets: SOLAR_PLANETS.length,
    generation: GENERATION_VERSIONS,
  }
}

/** Total bodies in the modeled Solar System: everything, at every depth. */
export const solarBodyCount = (): number =>
  [...SOLAR_PLANETS, ...SOLAR_SMALL_BODIES].reduce(
    (n, body) => n + 1 + body.moons.length,
    0,
  )

export type { Meters }
