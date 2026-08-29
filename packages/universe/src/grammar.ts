import {
  GRAVITATIONAL_CONSTANT,
  type Kelvin,
  type Kilograms,
  type Meters,
  STEFAN_BOLTZMANN,
} from '@inertialref/shared'
import {
  clamp01,
  mix,
  Rng,
  smoothstep,
  type Seed,
} from '@inertialref/procedural'
import type { Atmosphere } from '@inertialref/physics'
import {
  ACTIVE_TIDAL_PROXY,
  classifySurface,
  type SurfaceArchetype,
} from './archetype.ts'

/*
 * What kind of geology a body has, from what is already known about it.
 *
 * The band stack in `terrain.ts` is one set of functions for every solid body
 * in the galaxy, and this is what makes Mercury come out of it looking like
 * Mercury and Titan like Titan. Every input is a fact the body already carries
 * — mass, radius, atmosphere, temperature, the tide its primary raises — and
 * every output is a scale or a switch the sample function reads.
 *
 * **Derived, never stored.** A grammar is a pure function of (surface seed,
 * facts) and is computed where a body is generated, alongside the rest of its
 * `SurfaceParameters`. It rides along on that record because the heightfield
 * worker needs it and a worker has no `Body` — not because it is data anybody
 * saves. A save stores an address; the grammar comes back with the body.
 *
 * **It is also what the dossier reads.** A projected world's geology is a claim
 * about the place, in the universe's voice, per ADR-0014 — "a rocky world with
 * no air, saturated with craters" is a sentence about Mercury, not about a
 * random number generator.
 *
 * The archetype from `archetype.ts` is the coarsest output here rather than a
 * second opinion: `classifySurface` is the one implementation and both call it.
 * Everything else is continuous, because the interesting worlds are the ones
 * between the four corners — Mars is two thirds of the way from airless to
 * atmosphered and its craters say so.
 */

/**
 * The compressive strength a crust holds a mountain up with, pascals.
 *
 * Peak relief scales as `strength / (ρ g)`: a mountain is a column of rock
 * standing on rock, and it stops growing when its own base yields. The constant
 * is calibrated on Olympus Mons — 21.9 km on Mars, where ρg is 14,600 — which
 * puts it at 3.2 × 10⁸ Pa, the right order for basalt in compression.
 *
 * Earth comes out at 5.9 km against Everest's 8.8, and the understatement is
 * the model rather than a fitting error: the Himalaya are still being pushed up
 * by a collision, and a static strength limit describes what a crust can hold,
 * not what a convergence is currently doing to it.
 *
 * Cryogenic ice counts as rock here and gets no constant of its own. At 90 K
 * water ice has a compressive strength within a factor of two of basalt, which
 * is why Iapetus stands a 20 km ridge on a 735 km moon and why that is right
 * rather than a bug.
 */
export const CRUST_STRENGTH = 3.2e8

/**
 * The largest relief measured on any body in the Solar System, meters.
 *
 * Vesta's Rheasilvia central peak is ~22 km on a 262 km body; Olympus Mons is
 * 21.9 km on one 3,390 km across. Four orders of magnitude of surface gravity
 * between them and the same number, which is the empirical fact this constant
 * is: relief saturates, and it saturates at about twenty-two kilometers.
 */
export const MAX_RELIEF: Meters = 22_000

/**
 * The most of its own radius a body carries as relief.
 *
 * Vesta again, and it is the extreme: 22 km on a 262 km mean radius is 8.4%.
 * The bound exists because the strength limit is useless on a small body — a
 * 50 km moon could hold a 5,000 km mountain by that arithmetic — and something
 * has to say that a body may not be mostly mountain.
 */
export const RELIEF_RADIUS_FRACTION = 0.09

/** The facts a grammar is derived from. Everything is on `Body` or beside it. */
export interface GrammarFacts {
  readonly mass: Kilograms
  /** `(a·b·c)^(1/3)` — the radius a density divides by. */
  readonly meanRadius: Meters
  readonly atmosphere: Atmosphere | null
  /** Equilibrium temperature, Kelvin. */
  readonly temperature: Kelvin
  /**
   * `tidalProxy` against the primary — zero for a planet.
   *
   * The star is not the primary. Passing the star's mass would call every
   * planet tidally active, which is the mistake `surfaceArchetype` documents.
   */
  readonly tidalProxy: number
  /**
   * Whether the world has standing liquid.
   *
   * It is here for one reason and it is not decoration: water is the leading
   * explanation for why Earth has plate tectonics and Venus, the same size and
   * the same age, does not. A wet lithosphere is weak enough to subduct. So the
   * ocean decides the plate count, and a dry Venus-sized world comes out with
   * a stagnant lid and two enormous shields on it.
   */
  readonly hasOcean: boolean
  /**
   * How much of the strength limit this world has actually spent, 0..1.
   *
   * The one relief number that is a draw rather than a derivation, and it is
   * bounded tightly on purpose: the limit is physics, and this says only that
   * two worlds of the same size are not identically mountainous. Zero means no
   * surface at all, which is what a gas giant passes.
   */
  readonly reliefSpent: number
  /**
   * Measured relief, used verbatim where somebody has published it.
   *
   * `docs/design/art.md` is explicit that the data is not negotiable: Olympus
   * Mons really is 21.9 km and the generator does not get a vote. Null on every
   * body nobody has flown past, which is the whole galaxy outside Sol.
   */
  readonly publishedRelief: Meters | null
}

/** Which bands exist, and how much of the relief budget each is allowed. */
export interface BandAmplitudes {
  /** Continents against ocean floor — the bimodal half of a plate world. */
  readonly hypsometry: number
  /** Uplift, trenches, rifts and scarps along plate boundaries. */
  readonly belts: number
  /** Shields, arc cones and calderas. */
  readonly volcanism: number
  /** The crater field. */
  readonly craters: number
  /** Chaos, sulci and tiger stripes — the icy-active set. */
  readonly ice: number
  /** Derivative-damped fBm: everything the named features do not explain. */
  readonly relief: number
}

export interface SurfaceGrammar {
  readonly archetype: SurfaceArchetype
  /** Surface gravity, m/s². */
  readonly gravity: number
  /** Bulk density, kg/m³. */
  readonly density: number
  /** `(a·b·c)^(1/3)`, meters — the radius the field's angular scales convert through. */
  readonly meanRadius: Meters
  readonly temperature: Kelvin
  /**
   * Atmospheric column mass, kg/m². Zero on an airless world.
   *
   * `surfaceDensity · scaleHeight`, which is `P/g` — Earth comes out at 10,200
   * against a measured 10,330. A pressure rather than a boolean, because crater
   * erasure and dune fields both scale with how much air there is: Mars has 2%
   * of Earth's column and keeps most of its craters, Venus has a hundred times
   * Earth's and has essentially none.
   */
  readonly airMass: number
  readonly tidalProxy: number
  /** Relief the material and the body's own size permit, meters. */
  readonly reliefLimit: Meters
  /**
   * Which of the three limits bound it — or `'measured'`, where somebody has
   * flown over the body and the archive overrides all three.
   *
   * Recorded rather than re-derived, because `reliefLimit` is not always what
   * bound the body and the comparison cannot tell afterwards. See
   * `reliefLimitSource`.
   */
  readonly reliefSource: ReliefSource

  /** 0 on an airless world, 1 under a thick one. The erasure driver. */
  readonly air: number
  /** 0 on a dead surface, 1 on one the tide is still working. */
  readonly young: number
  /** 0 for rock, 1 for ice. Continuous, because the mixed bodies are the point. */
  readonly icy: number
  /** 0 for a stagnant lid, 1 for a world whose plates move freely. */
  readonly mobility: number

  /** Plate nuclei. 1 is a stagnant lid and means one plate, not none. */
  readonly plateCount: number
  /** Fraction of plates that are ocean floor rather than continent. */
  readonly oceanicFraction: number
  readonly hotspotCount: number

  /** Areal crater density against saturation. 1 is the lunar highlands. */
  readonly craterDensity: number
  /** Diameter where crater floors flatten and central peaks appear, meters. */
  readonly complexDiameter: Meters
  /** The largest crater the field places, meters. */
  readonly largestCrater: Meters
  /** How far large old craters relax toward palimpsests. 0..1. */
  readonly relaxation: number

  /** Slope damping for the relief band — the analytic stand-in for erosion. */
  readonly erosion: number
  /** Anisotropic wind-blown relief. 0..1. */
  readonly dunes: number
  /** Voronoi block rafts. 0..1. */
  readonly chaos: number
  /** Parallel grooved bands. 0..1. */
  readonly sulci: number
  /** Great-circle troughs. 0..1. */
  readonly stripes: number

  readonly bands: BandAmplitudes
}

/** Surface gravity from mass and radius, m/s². */
export const surfaceGravity = (mass: Kilograms, radius: Meters): number =>
  radius > 0 ? (GRAVITATIONAL_CONSTANT * mass) / (radius * radius) : 0

/** Bulk density from mass and mean radius, kg/m³. */
export const meanDensity = (mass: Kilograms, radius: Meters): number =>
  radius > 0 ? mass / ((4 / 3) * Math.PI * radius ** 3) : 0

/**
 * Blackbody equilibrium temperature for an incident flux, Kelvin.
 *
 * The Bond albedo is a flat 0.2 rather than the body's own, and that is a
 * deliberate limit rather than an oversight: the appearance — which is where a
 * geometric albedo lives — is drawn *after* the surface, and the geometric
 * albedo is not the Bond albedo anyway (Earth's pair is 0.434 and 0.306). The
 * grammar reads this to decide how fast ice relaxes, which is a smoothstep over
 * a hundred kelvin; a fifth of an albedo moves it by five.
 */
export const equilibriumTemperature = (flux: number): Kelvin =>
  ((0.8 * flux) / (4 * STEFAN_BOLTZMANN)) ** 0.25

/**
 * The three limits on peak relief, whichever bites first.
 *
 * Material strength, the body's own size, and the largest excursion anyone has
 * measured anywhere. Each binds on a different class of body: strength on the
 * planets, size on the small moons, and the absolute ceiling on the ones in
 * between — Luna, where the strength limit alone would allow 59 km.
 */
export function reliefLimit(
  density: number,
  gravity: number,
  meanRadius: Meters,
): Meters {
  const strength =
    density > 0 && gravity > 0
      ? CRUST_STRENGTH / (density * gravity)
      : Number.POSITIVE_INFINITY
  return Math.min(strength, meanRadius * RELIEF_RADIUS_FRACTION, MAX_RELIEF)
}

/** Which of the three limits `reliefLimit` returned, or the archive. */
export type ReliefSource = 'measured' | 'strength' | 'size' | 'ceiling'

/**
 * Which term bound the relief, named where the `Math.min` above runs.
 *
 * The dossier's relief row says *why* a body carries the relief it does, and a
 * panel that re-derives the comparison from the three constants is a second copy
 * of the rule that answers a different question: `reliefLimit` is not always
 * what bound the body. `surfaceOf` in `solar/system.ts` passes a published
 * figure for every body in Sol, which overrides all three — so the re-derived
 * version told Earth's card "limited by what the crust can hold up" over a
 * 9,900 m relief the crust limit puts at 5,910. The answer has to come from the
 * site that knows, and `'measured'` is the case a re-derivation cannot see.
 */
export function reliefLimitSource(
  density: number,
  gravity: number,
  meanRadius: Meters,
): Exclude<ReliefSource, 'measured'> {
  const strength =
    density > 0 && gravity > 0
      ? CRUST_STRENGTH / (density * gravity)
      : Number.POSITIVE_INFINITY
  const size = meanRadius * RELIEF_RADIUS_FRACTION
  if (strength <= size && strength <= MAX_RELIEF) return 'strength'
  return size <= MAX_RELIEF ? 'size' : 'ceiling'
}

/**
 * Crater depth for a diameter, meters.
 *
 * Fresh simple craters carry depth/diameter ≈ 0.2 — a bowl. Past the
 * simple-to-complex transition the floor collapses and the ratio falls away as
 * roughly `D^0.3`, which is why South Pole–Aitken is 2,500 km across and only
 * eight deep. Exported because the grammar inverts it to choose the largest
 * crater it can afford, and the crater band evaluates it: two callers, one law.
 */
export function craterDepth(diameter: Meters, complexDiameter: Meters): Meters {
  if (diameter <= complexDiameter) return 0.2 * diameter
  return 0.2 * complexDiameter * (diameter / complexDiameter) ** 0.3
}

/** The inverse: the diameter whose crater is `depth` deep. */
function craterDiameterForDepth(
  depth: Meters,
  complexDiameter: Meters,
): Meters {
  const atTransition = 0.2 * complexDiameter
  if (depth <= atTransition) return depth / 0.2
  return complexDiameter * (depth / atTransition) ** (1 / 0.3)
}

/**
 * The whole grammar, from the seed and the facts.
 *
 * The seed enters for the draws that are genuinely arbitrary — how many plates
 * a mobile-lid world happens to have, how many hotspots, how much ocean floor
 * there is — and for nothing else. Everything derived from physics is derived
 * from physics, so two bodies with the same mass, radius, air and tide have the
 * same geology up to those draws, which is the claim the archetypes make in the
 * first place.
 */
export function surfaceGrammar(
  seed: Seed,
  facts: GrammarFacts,
): SurfaceGrammar {
  const { mass, meanRadius, atmosphere, temperature, tidalProxy } = facts
  const gravity = surfaceGravity(mass, meanRadius)
  const density = meanDensity(mass, meanRadius)
  const airMass =
    atmosphere === null ? 0 : atmosphere.surfaceDensity * atmosphere.scaleHeight
  const archetype = classifySurface(density, atmosphere !== null, tidalProxy)

  /*
   * The three continuous drivers everything else is written against.
   *
   * `air` is logarithmic because the column mass spans five orders of magnitude
   * across the bodies in scope — Mars 222 kg/m², Earth 10,200, Venus 1.0e6 —
   * and a linear driver would put Mars and Earth in the same bin and Venus off
   * the end. The divisor of six decades lands Mars at 0.39, Earth at 0.67 and
   * Venus at 1, which is roughly the order their craters survive in.
   */
  const air = clamp01(Math.log10(1 + airMass) / 6)
  /*
   * `young` saturates at three times the threshold that separates a dead icy
   * moon from a live one, which is where Europa sits. Below it, Ganymede and
   * Callisto land near 0.08 — the order of magnitude between the two groups is
   * what makes a single scale usable at all.
   */
  const young = clamp01(tidalProxy / (3 * ACTIVE_TIDAL_PROXY))
  /*
   * `icy` is a ramp rather than the archetype's step, because Callisto (1,834)
   * and Titan (1,881) are two thirds ice while Europa (3,013) is a silicate
   * body with an ocean on it, and a step at 2,000 says they are the same thing.
   */
  const icy = clamp01((2_400 - density) / 800)

  const rng = new Rng(seed).fork('grammar')

  /*
   * Mobility: whether the lithosphere moves in pieces or sits as one lid.
   *
   * Size, because a bigger body holds its internal heat longer. Air, because
   * weathering and sediment lubricate a margin. And an ocean, because water is
   * the leading explanation for why Earth subducts and Venus — the same size,
   * the same age, dry — does not. Mars comes out at 0.30 and Venus at 0.29,
   * both stagnant lids with a few enormous shields, which is the Tharsis
   * pattern and is what those two bodies look like.
   */
  const mobility = clamp01(
    (meanRadius / 6.371e6) *
      (0.3 + 0.7 * air) *
      (facts.hasOcean ? 1 : 0.3) *
      (1 + 2 * young),
  )
  const plateCount =
    mobility < 0.35 ? 1 : Math.round(mix(8, 30, (mobility - 0.35) / 0.65))
  const oceanicFraction = plateCount === 1 ? 0 : rng.range(0.45, 0.7)
  // Few and enormous on a lid that never moves — a hotspot burns through the
  // same spot for a billion years and builds Olympus Mons. Many and small where
  // the plate slides over them and leaves a chain.
  const hotspotCount =
    plateCount === 1 ? rng.int(2, 4) : rng.int(6, 6 + Math.round(8 * mobility))

  const limit =
    facts.publishedRelief ??
    reliefLimit(density, gravity, meanRadius) * facts.reliefSpent
  // `??` above, so a published zero is still published — which is what every
  // Sol body with no measured relief passes, and why this is not `> 0`.
  const reliefSource: ReliefSource =
    facts.publishedRelief !== null
      ? 'measured'
      : reliefLimitSource(density, gravity, meanRadius)

  const complexDiameter = mix(29_000, 3_500, icy) / Math.max(gravity, 1e-4)
  /*
   * Crater retention: air erases and a working surface resurfaces.
   *
   * The exponent on `air` is what puts Mars at 0.48 and Earth at 0.19 — both
   * cratered, one obviously so — while Venus and Titan go to zero. `young`
   * enters linearly because a resurfacing event does not thin a crater
   * population, it deletes it.
   */
  const craterDensity = clamp01((1 - air) ** 1.5 * (1 - young))

  const bands = bandAmplitudes(air, young, icy, mobility, craterDensity)
  /*
   * The largest crater is sized from the relief budget rather than being a
   * second dial that could disagree with it, and the factor of three is the
   * interesting part.
   *
   * Sizing it so that its depth *equals* the crater band's share is the obvious
   * choice and it produces a Mercury whose biggest crater is 33 km across. The
   * depth law saturates hard — past the transition, depth grows as `D^0.3`, so
   * a basin thirty times wider is only three times deeper — which means
   * inverting it at the budget throws away two orders of magnitude of diameter
   * to save a factor of three in depth. Sizing at three times the budget and
   * letting `softLimit` fold the depth back down gives Mercury a
   * thousand-kilometer basin 2.4 km deep, against Caloris's measured 1,550 km
   * and ~3 km. The soft ceiling is doing the work the inversion was doing
   * badly, and every crater below half the budget passes through it untouched.
   *
   * Capped at 45% of the mean radius as a diameter, which is a 26° cap on
   * angular radius: past that a "crater" is a hemisphere and a radial profile
   * stops describing anything.
   */
  const largestCrater = Math.min(
    craterDiameterForDepth(3 * bands.craters * limit, complexDiameter),
    meanRadius * 0.45,
  )

  return {
    archetype,
    gravity,
    density,
    meanRadius,
    temperature,
    airMass,
    tidalProxy,
    reliefLimit: limit,
    reliefSource,
    air,
    young,
    icy,
    mobility,
    plateCount,
    oceanicFraction,
    hotspotCount,
    craterDensity,
    complexDiameter,
    largestCrater,
    /*
     * Old ice flows, and how fast depends on how warm it is.
     *
     * A large crater on Callisto (134 K) sags into a palimpsest over a billion
     * years, which is why it is smooth at large scales and rough at small — the
     * small ones are younger than the relaxation time. Pluto is 40 K and its
     * water-ice mountains stand three kilometers with no sign of flow at all,
     * which is why the temperature is in here rather than a constant: ice at 40
     * K is a hard rock and ice at 150 K is not.
     */
    relaxation: icy * (1 - young) * smoothstep(60, 160, temperature),
    // Damping for the relief band's fBm. Zero on an airless world, which is
    // what keeps a lunar rim razor-edged.
    erosion: 24 * air ** 1.5,
    // Wind needs air, and a dune sea needs enough of it to move sand. Below a
    // tenth of a bar there is nothing to blow with.
    dunes: smoothstep(0.15, 0.6, air) * (1 - icy * young),
    chaos: young * icy,
    sulci: young * icy,
    stripes: young * young * icy,
    bands,
  }
}

/**
 * How the relief budget is divided, as fractions that sum to one.
 *
 * Fractions rather than meters, so the whole stack is bounded by
 * `maxElevation` by construction and no band can quietly grow past its share.
 * The shape of the division is the archetype table in `TERRAIN-PLAN.md` § 6,
 * written continuously: an airless world spends most of its budget on craters,
 * an atmosphered one on hypsometry and mountain belts, a live icy one on the
 * ridges and rafts the tide is drawing.
 */
function bandAmplitudes(
  air: number,
  young: number,
  icy: number,
  mobility: number,
  craterDensity: number,
): BandAmplitudes {
  const raw = {
    // Continents need somewhere to be different from: a one-plate world has a
    // unimodal elevation histogram and this is what makes it so.
    hypsometry: 0.12 + 0.35 * mobility,
    // Orogeny is what moving plates do. A stagnant lid still cracks — Mercury's
    // lobate scarps are a whole planet shrinking — so the floor is not zero.
    belts: 0.08 + 0.3 * mobility + 0.25 * young * icy,
    volcanism: 0.06 + 0.12 * (1 - mobility) * (1 - icy) + 0.05 * young,
    craters: 0.5 * craterDensity,
    ice: 0.35 * young * icy,
    // The tail: everything the named features do not explain, and the band that
    // carries the erosion look. Larger where the features are fewer.
    relief: 0.1 + 0.15 * air,
  }
  const total =
    raw.hypsometry +
    raw.belts +
    raw.volcanism +
    raw.craters +
    raw.ice +
    raw.relief
  return {
    hypsometry: raw.hypsometry / total,
    belts: raw.belts / total,
    volcanism: raw.volcanism / total,
    craters: raw.craters / total,
    ice: raw.ice / total,
    relief: raw.relief / total,
  }
}
