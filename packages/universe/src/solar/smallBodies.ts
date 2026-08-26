import {
  AU,
  type Kilograms,
  type Meters,
  SECONDS_PER_DAY,
} from '@inertialref/shared'
import type { LinearRgb } from '../catalog/photometry.ts'
/*
 * `../rounding.ts`, not `../system.ts`, and that is not a tidiness preference.
 *
 * `system.ts` imports `solar/system.ts`, which imports this file. The array
 * below is built at module scope, so a *value* read from `system.ts` here is
 * dereferenced before that module's body has run — `import('system.ts')`
 * directly threw `ReferenceError: Cannot access 'ROUNDING_RADIUS' before
 * initialization`, and only the order of `index.ts`'s re-exports hid it.
 * `rounding.ts` is a leaf with no imports of its own and cannot be on either
 * side of the cycle.
 */
import { ROUNDING_RADIUS } from '../rounding.ts'
import type { SolarBody } from './bodies.ts'

/*
 * The rest of the Solar System.
 *
 * `bodies.ts` holds the eight planets and the twenty moons big enough to be
 * worlds. This holds everything else that has been *resolved* — every dwarf
 * planet, every asteroid and comet a spacecraft has flown past or orbited, the
 * main-belt bodies large enough to have a geology, and the moons of all of
 * them. Eighty objects — fifty-nine orbiting the Sun and twenty-one going round
 * one of those — from Eris at 1,200 km to a rock eleven meters across.
 *
 * ## The rule that chose them
 *
 * There are 1.4 million numbered small bodies and "complete" is a category
 * error. The line here is **somebody has measured its figure**: a shape from a
 * flyby, a radar inversion, or a stellar occultation. That is exactly the set
 * for which a size, a spin and a silhouette are measurements rather than a
 * guess wearing a measurement's clothes, and `docs/design/art.md` draws the
 * same line through the whole project. The other 1.4 million would be
 * procedural content with real names on it, which is the one thing this file
 * must never contain.
 *
 * ## Why this is the file that made the renderer stop drawing spheres
 *
 * Everything in `bodies.ts` is round, because gravity rounded it. Almost
 * nothing here is. Phobos and Deimos were already the exception and were
 * already wrong — two ellipsoids drawn as balls — and it did not show, because
 * they are eleven and six kilometers across and nobody flies to them. Bennu is
 * a spinning top with a ridge round its equator, Kleopatra is a dog bone, and
 * 1P/Halley is a black peanut. Draw those as spheres and you have not
 * simplified them, you have drawn different objects. `BodyFigure` and
 * `packages/rendering/src/shape.ts` exist because of this list.
 *
 * ## How this file was made, and how it is maintained
 *
 * The first draft was *emitted* — a throwaway script read
 * `data/reference/solar-system.json` and a curation table and printed this,
 * because typing nine hundred numbers by hand has a known error rate and
 * copying them mechanically does not. That script is not in the repository and
 * is not meant to be run again: everything since has been hand-edited, and the
 * check that keeps the numbers honest is
 * `apps/headless/src/solarSystem.test.ts` rather than the ability to
 * regenerate.
 *
 * Worth knowing because it caught somebody out once. While the emitter still
 * existed, a fix applied to this file came back the next time it ran — the
 * general lesson being that a correction belongs wherever the content is
 * actually authored, and for this file that is now here.
 *
 * ## Provenance
 *
 * Orbital elements are JPL's Small-Body Database values, propagated to J2000
 * (the epoch `epoch: 0` means — see `packages/shared`) by advancing the mean
 * anomaly at the published mean motion. That is a two-body propagation of an
 * osculating element set across a couple of decades, so it is right to a few
 * hours of orbital phase for a comet and better than that for anything in the
 * belt; it is not an ephemeris and does not pretend to be one.
 *
 * Half-extents are JPL's published `extent` halved, except where a shape model
 * is vendored — those bodies carry the model's own measured bounding box, and
 * where the two disagree the reason is written down beside them. Masses,
 * rotation periods and albedos are JPL's. Everything a spacecraft has not
 * measured — surface color for a body nobody has resolved in color, the shape
 * between the samples of a model — is generated from the body's own seed and
 * is marked as such by the absence of a value here.
 *
 * `data/reference/solar-system.json` holds the same numbers straight out of
 * JPL, and `apps/headless/src/solarSystem.test.ts` checks this file against it
 * body by body. A transposed digit here fails a test rather than quietly
 * moving an asteroid.
 */

const KM: Meters = 1_000
const DEG = Math.PI / 180
const DAY = SECONDS_PER_DAY
const HOUR = 3_600

/**
 * Surface color for a body nobody has photographed in color.
 *
 * Almost everything here falls into that class, and the tempting thing — a
 * plausible brown — is exactly what `docs/design/art.md` calls the clearest
 * tell that a world was invented. So the hue is the body's *spectral class*,
 * which is measured, and the brightness is its *geometric albedo*, which is
 * also measured.
 *
 * The conversion is the physical one. A geometric albedo `p` is the brightness
 * at zero phase relative to a perfect Lambert disc; the Lambert reflectance
 * that produces it is `1.5 p`. The hue is normalized to its brightest channel
 * first, so it carries color and nothing else and the reflectance is not
 * quietly multiplied by it twice.
 *
 * This replaced `0.18 + 1.6 p`, which was a guess and which compressed a
 * 6-to-1 range of real albedos into 2.3-to-1 of rendered brightness. Measured
 * in the planetarium against the Moon, whose map is real and whose rendering
 * is the reference: Deimos at `p = 0.068` came out *twice as bright* as the
 * Moon at 0.136, and Iapetus's dark side came out brighter than Callisto. The
 * darkest objects in the Solar System are supposed to look like it.
 */
const surfaceColour = (albedo: number, hue: LinearRgb): LinearRgb => {
  const peak = Math.max(hue.r, hue.g, hue.b, 1e-6)
  const reflectance = Math.min(1, 1.5 * albedo)
  return {
    r: (hue.r / peak) * reflectance,
    g: (hue.g / peak) * reflectance,
    b: (hue.b / peak) * reflectance,
  }
}

/**
 * One small body, from the fields that differ between them.
 *
 * Everything here is `kind`-defaulted rather than repeated: an asteroid has no
 * atmosphere, no clouds and no rings unless it is one of the four that do, and
 * writing `atmosphere: null` sixty-eight times would bury the four differences
 * that matter under sixty-eight lines that do not.
 */
const smallBody = (
  name: string,
  kind: SolarBody['kind'],
  /** Half-extents a >= b >= c, kilometers. */
  axes: readonly [number, number, number],
  mass: Kilograms,
  /** Sidereal rotation, hours. Negative is retrograde. */
  rotationHours: number,
  orbit: {
    /** Semi-major axis, astronomical units. */
    readonly a: number
    readonly e: number
    /** Inclination to the ecliptic, degrees. */
    readonly i: number
    /** Longitude of the ascending node, degrees. */
    readonly node: number
    /** Argument of periapsis, degrees. */
    readonly w: number
    /** Mean anomaly at J2000, degrees. */
    readonly m: number
  },
  albedo: number,
  hue: LinearRgb,
  options: Partial<SolarBody> = {},
): SolarBody => {
  const [a, b, c] = axes
  return {
    name,
    kind,
    radius: a * KM,
    polarRadius: c * KM,
    figure:
      b / a > 0.99 && (a * b * c) ** (1 / 3) * KM >= ROUNDING_RADIUS
        ? /*
           * Round — meaning a *spheroid*, which is what the renderer's
           * `radius`/`polarRadius` pair already describes.
           *
           * The test is `b` close to `a`, not `a = b = c`. Ceres is
           * 482 x 482 x 446: equatorially symmetric and 7.5% flattened by its
           * own nine-hour rotation, which is exactly the case `polarRadius`
           * exists for and exactly what Saturn is. Requiring all three axes to
           * agree would have handed Ceres a shape model and drawn a
           * hydrostatic dwarf planet as a rubble pile.
           *
           * Haumea fails this and should: 1050 x 840 x 537 is a Jacobi
           * ellipsoid, and no amount of polar flattening describes a body
           * whose equator is an ellipse.
           *
           * The size condition is the other half, and it is the one that is
           * easy to leave out. Ryugu's published figure is 1004 x 1004 x 876 m
           * — equatorially symmetric to the precision anybody has measured —
           * and Ryugu is a rubble pile with boulders on it the size of houses.
           * Below `ROUNDING_RADIUS` an `a = b` in the literature means "nobody
           * resolved the asymmetry", not "gravity made it a spheroid", and
           * reading it as the second draws a 500 m rock as a billiard ball.
           */
          null
        : {
            intermediateRadius: b * KM,
            model: null,
            /*
             * How lumpy, when no model says.
             *
             * The residual roughness about the fitted ellipsoid, measured across the
             * twenty-five vendored models: 0.023 to 0.61, median 0.090. See
             * `irregularFigure` in `system.ts`, which draws from the same
             * distribution for generated worlds. This is the median, because a body
             * whose half-extents are published and whose relief is not is exactly
             * the average case.
             */
            irregularity: 0.09,
          },
    mass,
    rotationPeriod: rotationHours * HOUR,
    axialTilt: 0,
    semiMajorAxis: orbit.a * AU,
    eccentricity: orbit.e,
    inclination: orbit.i * DEG,
    argumentOfPeriapsis: orbit.w * DEG,
    ascendingNode: orbit.node * DEG,
    meanAnomaly: orbit.m * DEG,
    geometricAlbedo: albedo,
    temperature: 100,
    texture: null,
    tint: surfaceColour(albedo, hue),
    // The figure *is* the relief. Sinking the drawn body by a second helping of
    // it — which is what a non-zero relief asks the renderer to do — would
    // shrink every asteroid inside its own shape model.
    relief: 0,
    roughness: kind === 'dwarf' ? 0.85 : 0.98,
    atmosphere: null,
    haze: null,
    clouds: null,
    rings: null,
    discoveryYear: 0,
    moons: [],
    ...options,
  }
}

/**
 * A satellite of a small body, whose orbit is published in kilometers and days
 * rather than in AU and years.
 */
const satellite = (
  name: string,
  axes: readonly [number, number, number],
  mass: Kilograms,
  axisKm: number,
  periodDays: number,
  eccentricity: number,
  inclinationDeg: number,
  albedo: number,
  hue: LinearRgb,
  options: Partial<SolarBody> = {},
): SolarBody => {
  const [a, b, c] = axes
  return {
    name,
    kind: 'moon',
    radius: a * KM,
    polarRadius: c * KM,
    // Round above 200 km — Charon and Vanth are worlds — and a rock below it.
    figure:
      a * KM >= 200_000
        ? null
        : { intermediateRadius: b * KM, model: null, irregularity: 0.09 },
    mass,
    // Every one of these that has been measured is tidally locked, except
    // Pluto's four small moons, which tumble chaotically because they orbit a
    // binary and there is no stable state to fall into. Nix is the measured
    // case: 43.9 hours, and its pole wanders.
    rotationPeriod: periodDays * DAY,
    axialTilt: 0,
    semiMajorAxis: axisKm * KM,
    eccentricity,
    inclination: inclinationDeg * DEG,
    argumentOfPeriapsis: 0,
    geometricAlbedo: albedo,
    temperature: 40,
    texture: null,
    tint: surfaceColour(albedo, hue),
    relief: 0,
    roughness: 0.9,
    atmosphere: null,
    haze: null,
    clouds: null,
    rings: null,
    discoveryYear: 0,
    moons: [],
    ...options,
  }
}

/* ------------------------------------------------------------------------- */
/* The bodies                                                                 */
/* ------------------------------------------------------------------------- */

export const SOLAR_SMALL_BODIES: readonly SolarBody[] = [
  /* --- Dwarf planets ------------------------------------------------------- */
  /*
   * The five the IAU recognizes and the four next in line. Every one of
   * them is round, which is what makes them dwarf *planets* rather than
   * asteroids — and two of them, Haumea and Pluto, are the interesting
   * cases either side of that line. Pluto is a sphere to within the
   * measurement. Haumea is a Jacobi ellipsoid two thousand kilometers long,
   * spun into it by a collision, and it is round in the sense that matters:
   * it is the shape hydrostatic equilibrium gives a body turning that fast.
   */
  /*
   * Half of JPL's 964.4 x 964.2 x 891.8 km extent. Round, and the only
   * dwarf planet inside Neptune.
   */
  smallBody(
    'Ceres',
    'dwarf',
    [482.1, 481.6, 445.9],
    9.384e20,
    9.07417,
    // 1 Ceres (A801 AA)
    {
      a: 2.7655526,
      e: 0.0796923,
      i: 10.58803,
      node: 80.24863,
      w: 73.29421,
      m: 5.202723,
    },
    0.09,
    { r: 0.62, g: 0.6, b: 0.58 },
    {
      axialTilt: 4 * DEG,
      temperature: 166,
      texture: 'ceres',
      discoveryYear: 1801,
    },
  ),
  /*
   * Radius from the New Horizons occultation (Nimmo et al. 2017); no
   * flattening is measurable. The 119.591 obliquity is retrograde, so under
   * this file's signed-period convention the tilt is its supplement.
   */
  smallBody(
    'Pluto',
    'dwarf',
    [1188.3, 1188.3, 1188.3],
    1.3025e22,
    -153.2935,
    // 134340 Pluto (1930 BM)
    {
      a: 39.5886294,
      e: 0.2518379,
      i: 17.14771,
      node: 110.2924,
      w: 113.709,
      m: 14.77051,
    },
    0.52,
    { r: 0.78, g: 0.66, b: 0.55 },
    {
      axialTilt: 60.409 * DEG,
      temperature: 42,
      texture: 'pluto',
      discoveryYear: 1930,
      moons: [
        /*
         * Half Pluto's diameter, orbiting a barycentre outside Pluto itself — the
         * only true double body in the Solar System.
         */
        satellite(
          'Charon',
          [606, 606, 606],
          1.5897e21,
          19_600,
          6.38722,
          0,
          0,
          0.38,
          { r: 0.66, g: 0.62, b: 0.58 },
          {
            texture: 'charon',
          },
        ),
        satellite('Styx', [8, 4.5, 4], 7.5e15, 43_200, 20.16, 0.025, 0, 0.65, {
          r: 0.8,
          g: 0.78,
          b: 0.76,
        }),
        /*
         * Tumbling chaotically, because it orbits a binary and there is no stable
         * spin state to fall into.
         */
        satellite(
          'Nix',
          [24.9, 16.6, 15.5],
          2.247e16,
          49_300,
          24.85,
          0.015,
          0,
          0.56,
          { r: 0.82, g: 0.8, b: 0.78 },
        ),
        satellite(
          'Kerberos',
          [9.5, 5, 4.5],
          1.65e16,
          58_300,
          32.17,
          0.01,
          0.4,
          0.56,
          { r: 0.78, g: 0.76, b: 0.74 },
        ),
        satellite(
          'Hydra',
          [25.45, 18.05, 15.45],
          2.997e16,
          65_200,
          38.2,
          0.009,
          0.3,
          0.83,
          { r: 0.83, g: 0.81, b: 0.79 },
        ),
      ],
    },
  ),
  /*
   * The body that cost Pluto its planethood: more massive, and 96 AU out.
   * Its surface is methane frost, the brightest in the outer system after
   * Enceladus.
   */
  smallBody(
    'Eris',
    'dwarf',
    [1_200, 1_200, 1_200],
    1.66e22,
    25.9,
    // 136199 Eris (2003 UB313)
    {
      a: 67.9339469,
      e: 0.4382385,
      i: 43.92583,
      node: 36.00477,
      w: 150.7949,
      m: 194.7784,
    },
    0.96,
    { r: 0.92, g: 0.9, b: 0.88 },
    {
      axialTilt: 78.3 * DEG,
      temperature: 30,
      discoveryYear: 2003,
      moons: [
        /*
         * As dark as Eris is bright, which is what let its mass be weighed
         * against a body nobody can resolve.
         */
        satellite(
          'Dysnomia',
          [307.5, 307.5, 307.5],
          8.2e19,
          37_273,
          15.786,
          0.0062,
          0,
          0.05,
          { r: 0.3, g: 0.29, b: 0.28 },
        ),
      ],
    },
  ),
  /*
   * A Jacobi ellipsoid: spun so fast by a collision that its own gravity
   * cannot pull it round, so it is a genuine triaxial world two thousand
   * kilometers long. Half-extents from the 2017 stellar occultation (Ortiz
   * et al., Nature 550, 219).
   */
  smallBody(
    'Haumea',
    'dwarf',
    [1_050, 840, 537],
    4.006e21,
    3.915341,
    // 136108 Haumea (2003 EL61)
    {
      a: 43.0602902,
      e: 0.194443,
      i: 28.20847,
      node: 121.7861,
      w: 240.6905,
      m: 189.5311,
    },
    0.51,
    { r: 0.95, g: 0.94, b: 0.92 },
    {
      temperature: 40,
      discoveryYear: 2003,
      /*
       * A 70 km ring at 2,287 km, in 3:1 resonance with a body that turns
       * in under four hours (Ortiz et al., Nature 550, 219, 2017).
       */ rings: {
        innerRadius: 2_252_000,
        outerRadius: 2_322_000,
        opticalDepth: 0.5,
        texture: null,
      },
      moons: [
        /*
         * Water ice, almost pure — a fragment of the collision that spun Haumea
         * into an ellipsoid.
         */
        satellite(
          'Hiiaka',
          [160, 160, 160],
          1.79e19,
          49_880,
          49.12,
          0.0513,
          0,
          0.6,
          { r: 0.9, g: 0.89, b: 0.88 },
        ),
        satellite(
          'Namaka',
          [85, 85, 85],
          1.79e18,
          25_657,
          18.28,
          0.249,
          13.4,
          0.6,
          { r: 0.88, g: 0.87, b: 0.86 },
        ),
      ],
    },
  ),
  smallBody(
    'Makemake',
    'dwarf',
    [717, 717, 717],
    3.1e21,
    22.8266,
    // 136472 Makemake (2005 FY9)
    {
      a: 45.5709332,
      e: 0.158889,
      i: 29.02786,
      node: 79.29483,
      w: 297.0923,
      m: 139.0032,
    },
    0.82,
    { r: 0.85, g: 0.72, b: 0.62 },
    {
      temperature: 37,
      discoveryYear: 2005,
      moons: [
        /*
         * Charcoal-dark beside a body of methane frost, which is why it took a
         * decade and Hubble to see it.
         */
        satellite(
          'S/2015 (136472) 1',
          [87.5, 87.5, 87.5],
          1e18,
          21_100,
          12.4,
          0,
          0,
          0.04,
          { r: 0.22, g: 0.21, b: 0.2 },
        ),
      ],
    },
  ),
  /*
   * Two rings, both outside the classical Roche limit, which is the
   * discovery that broke the rule (Morgado et al., Nature 614, 239, 2023).
   */
  smallBody(
    'Quaoar',
    'dwarf',
    [545, 545, 545],
    1.2e21,
    8.84,
    // 50000 Quaoar (2002 LM60)
    {
      a: 43.1561765,
      e: 0.03520024,
      i: 7.991576,
      node: 188.9191,
      w: 163.2091,
      m: 259.2816,
    },
    0.124,
    { r: 0.72, g: 0.62, b: 0.55 },
    {
      temperature: 42,
      discoveryYear: 2002,
      /*
       * Two narrow rings, at 4,100 and 2,520 km — both *outside* the Roche
       * limit, where theory says they should have accreted into a moon and
       * did not.
       */ rings: {
        innerRadius: 2_400_000,
        outerRadius: 4_200_000,
        opticalDepth: 0.02,
        texture: null,
      },
      moons: [
        satellite(
          'Weywot',
          [40, 40, 40],
          5e17,
          13_300,
          12.438,
          0.056,
          14,
          0.04,
          { r: 0.28, g: 0.26, b: 0.25 },
        ),
      ],
    },
  ),
  /*
   * Pluto's antithesis: the same 3:2 resonance with Neptune, the same
   * period, and always on the opposite side of it.
   */
  smallBody(
    'Orcus',
    'dwarf',
    [458, 458, 458],
    5.47e20,
    13.188,
    // 90482 Orcus (2004 DW)
    {
      a: 39.3768654,
      e: 0.2205241,
      i: 20.55681,
      node: 268.4054,
      w: 73.56849,
      m: 150.5834,
    },
    0.23,
    { r: 0.7, g: 0.72, b: 0.74 },
    {
      temperature: 43,
      discoveryYear: 2004,
      moons: [
        /*
         * A third of Orcus's mass — another near-binary, and again in the Kuiper
         * belt.
         */
        satellite(
          'Vanth',
          [221, 221, 221],
          8.7e19,
          9_030,
          9.5391,
          0.0086,
          0,
          0.08,
          { r: 0.34, g: 0.3, b: 0.28 },
        ),
      ],
    },
  ),
  /*
   * One of the reddest large bodies known — methane irradiated to tholins.
   */
  smallBody(
    'Gonggong',
    'dwarf',
    [615, 615, 615],
    1.75e21,
    22.4,
    // 225088 Gonggong (2007 OR10)
    {
      a: 66.866638,
      e: 0.5042507,
      i: 30.89906,
      node: 336.8383,
      w: 206.6232,
      m: 94.26007,
    },
    0.14,
    { r: 0.72, g: 0.52, b: 0.44 },
    {
      temperature: 34,
      discoveryYear: 2007,
      moons: [
        satellite(
          'Xiangliu',
          [50, 50, 50],
          1e18,
          24_021,
          25.22,
          0.29,
          0,
          0.07,
          { r: 0.34, g: 0.26, b: 0.24 },
        ),
      ],
    },
  ),
  /*
   * Perihelion 76 AU, aphelion 937, and a period of eleven thousand years.
   * Nothing else known orbits so far from everything.
   */
  smallBody(
    'Sedna',
    'dwarf',
    [497, 497, 497],
    1e21,
    10.273,
    // 90377 Sedna (2003 VB12)
    {
      a: 543.719529,
      e: 0.8598825,
      i: 11.92528,
      node: 144.5062,
      w: 311.0988,
      m: 357.8451,
    },
    0.32,
    { r: 0.8, g: 0.42, b: 0.3 },
    {
      temperature: 12,
      discoveryYear: 2003,
    },
  ),

  /* --- The main belt ------------------------------------------------------- */
  /*
   * Bodies large enough to have a geology, and the ones a spacecraft has
   * resolved. Vesta and Pallas between them are a fifth of the belt's mass;
   * everything below Lutetia here is a fragment of something that used to
   * be bigger.
   */
  /*
   * Differentiated: it has a core, a mantle and a crust, and the Rheasilvia
   * basin took a sixth of its volume off the south pole.
   */
  smallBody(
    'Vesta',
    'asteroid',
    [289.449, 285.447, 239.062],
    2.5908e20,
    5.342128,
    // 4 Vesta (A807 FA)
    {
      a: 2.36136597,
      e: 0.09020374,
      i: 7.143926,
      node: 103.7013,
      w: 151.4686,
      m: 338.5791,
    },
    0.4228,
    { r: 0.62, g: 0.6, b: 0.56 },
    {
      axialTilt: 29 * DEG,
      temperature: 173,
      texture: 'vesta',
      figure: {
        intermediateRadius: 285.447 * KM,
        model: 'vesta',
        irregularity: 0,
      },
      discoveryYear: 1807,
    },
  ),
  /*
   * Tilted 84 degrees to its orbit and inclined 34 to the ecliptic — the
   * most out-of-plane large body in the belt.
   */
  smallBody(
    'Pallas',
    'asteroid',
    [284, 266, 224],
    2.04e20,
    7.813221,
    // 2 Pallas (A802 FA)
    {
      a: 2.76955901,
      e: 0.2307001,
      i: 34.93279,
      node: 172.8866,
      w: 310.9699,
      m: 349.5214,
    },
    0.155,
    { r: 0.5, g: 0.5, b: 0.52 },
    {
      axialTilt: 84 * DEG,
      temperature: 165,
      discoveryYear: 1802,
    },
  ),
  smallBody(
    'Juno',
    'asteroid',
    [160, 130, 111],
    2.67e19,
    7.21,
    // 3 Juno (A804 RA)
    {
      a: 2.67098953,
      e: 0.2557,
      i: 12.98659,
      node: 169.8116,
      w: 247.8951,
      m: 242.6617,
    },
    0.214,
    { r: 0.58, g: 0.52, b: 0.46 },
    {
      axialTilt: 51 * DEG,
      temperature: 167,
      discoveryYear: 1804,
    },
  ),
  /*
   * Round enough that it may be a dwarf planet; nobody has decided.
   */
  smallBody(
    'Hygiea',
    'asteroid',
    [217, 204, 193],
    8.32e19,
    13.8259,
    // 10 Hygiea (A849 GA)
    {
      a: 3.15097403,
      e: 0.1067093,
      i: 3.82953,
      node: 283.1199,
      w: 312.4242,
      m: 350.6141,
    },
    0.0717,
    { r: 0.42, g: 0.42, b: 0.42 },
    {
      temperature: 156,
      discoveryYear: 1849,
    },
  ),
  /*
   * Metal. Half the mass of a planetary core that never finished being one,
   * and a spacecraft is on its way.
   */
  smallBody(
    'Psyche',
    'asteroid',
    [139, 119, 85.5],
    2.29e19,
    4.195948,
    // 16 Psyche (A852 FA)
    {
      a: 2.92572047,
      e: 0.1349325,
      i: 3.098749,
      node: 149.9754,
      w: 230.0327,
      m: 338.1237,
    },
    0.1203,
    { r: 0.55, g: 0.52, b: 0.46 },
    {
      axialTilt: 95 * DEG,
      temperature: 161,
      discoveryYear: 1852,
    },
  ),
  /*
   * A dog bone 217 km long with two moons, and the shape a grid of radii
   * should not have been able to hold: the waist is a saddle rather than an
   * overhang, so it reconstructs to within 0.6% of the radar model's
   * volume.
   */
  smallBody(
    'Kleopatra',
    'asteroid',
    [112.702, 48.3237, 42.7321],
    2.97e18,
    5.385,
    // 216 Kleopatra (A880 GB)
    {
      a: 2.79527275,
      e: 0.2501677,
      i: 13.11553,
      node: 215.3098,
      w: 179.7698,
      m: 23.55299,
    },
    0.1164,
    { r: 0.52, g: 0.48, b: 0.42 },
    {
      temperature: 165,
      figure: {
        intermediateRadius: 48.3237 * KM,
        model: 'kleopatra',
        irregularity: 0,
      },
      discoveryYear: 1880,
      moons: [
        satellite(
          'Alexhelios',
          [4.5, 4.5, 4.5],
          100_000_000_000_000,
          678,
          2.32,
          0,
          0,
          0.12,
          { r: 0.52, g: 0.48, b: 0.42 },
        ),
        satellite(
          'Cleoselene',
          [3.5, 3.5, 3.5],
          50_000_000_000_000,
          454,
          1.24,
          0,
          0,
          0.12,
          { r: 0.52, g: 0.48, b: 0.42 },
        ),
      ],
    },
  ),
  /*
   * The first asteroid found to have two moons.
   */
  smallBody(
    'Sylvia',
    'asteroid',
    [192, 132, 110],
    1.478e19,
    5.183641,
    // 87 Sylvia (A866 KA)
    {
      a: 3.49093082,
      e: 0.09424185,
      i: 10.84931,
      node: 72.94598,
      w: 267.1015,
      m: 104.8807,
    },
    0.046,
    { r: 0.34, g: 0.33, b: 0.32 },
    {
      temperature: 148,
      discoveryYear: 1866,
      moons: [
        satellite(
          'Romulus',
          [12, 12, 12],
          1e16,
          1_356,
          3.6496,
          0.001,
          1.7,
          0.05,
          { r: 0.32, g: 0.31, b: 0.3 },
        ),
        satellite(
          'Remus',
          [3.5, 3.5, 3.5],
          250_000_000_000_000,
          706,
          1.3788,
          0.016,
          2,
          0.05,
          { r: 0.32, g: 0.31, b: 0.3 },
        ),
      ],
    },
  ),
  /*
   * The first asteroid anyone found a moon around, in a Galileo image
   * nobody expected it in.
   */
  smallBody(
    'Ida',
    'asteroid',
    [30.3803, 15.1681, 11.7717],
    4.2e16,
    4.63,
    // 243 Ida (A884 SB)
    {
      a: 2.86334803,
      e: 0.04610963,
      i: 1.130363,
      node: 323.5367,
      w: 113.2572,
      m: 245.5294,
    },
    0.262,
    { r: 0.6, g: 0.5, b: 0.42 },
    {
      temperature: 160,
      figure: {
        intermediateRadius: 15.1681 * KM,
        model: 'ida',
        irregularity: 0,
      },
      discoveryYear: 1884,
      moons: [
        /*
         * 1.4 km across, and the reason anybody believed asteroids could have
         * moons.
         */
        satellite(
          'Dactyl',
          [0.8, 0.7, 0.65],
          42_000_000_000,
          108,
          0.8542,
          0.2,
          8,
          0.2,
          { r: 0.6, g: 0.52, b: 0.44 },
        ),
      ],
    },
  ),
  /*
   * A seventeen-day rotation, which is the slowest of anything NEAR flew
   * past, and five craters each nearly as wide as the body.
   */
  smallBody(
    'Mathilde',
    'asteroid',
    [27.6905, 26.6357, 26.5],
    1.033e17,
    417.7,
    // 253 Mathilde (A885 VA)
    {
      a: 2.64690122,
      e: 0.2643479,
      i: 6.740468,
      node: 179.4942,
      w: 157.564,
      m: 223.6358,
    },
    0.0436,
    { r: 0.3, g: 0.29, b: 0.28 },
    {
      temperature: 170,
      figure: {
        intermediateRadius: 26.6357 * KM,
        model: 'mathilde',
        irregularity: 0,
      },
      discoveryYear: 1885,
    },
  ),
  smallBody(
    'Davida',
    'asteroid',
    [180, 147, 127],
    3.84e19,
    5.1297,
    // 511 Davida (A903 KB)
    {
      a: 3.16179285,
      e: 0.1893733,
      i: 15.9498,
      node: 107.5541,
      w: 336.5299,
      m: 177.741,
    },
    0.076,
    { r: 0.44, g: 0.42, b: 0.4 },
    {
      temperature: 155,
      discoveryYear: 1903,
    },
  ),
  smallBody(
    'Interamnia',
    'asteroid',
    [174.5, 174.5, 143],
    3.5e19,
    8.727,
    // 704 Interamnia (A910 TC)
    {
      a: 3.05681171,
      e: 0.1550587,
      i: 17.31528,
      node: 280.1672,
      w: 94.06173,
      m: 240.5061,
    },
    0.078,
    { r: 0.42, g: 0.42, b: 0.43 },
    {
      temperature: 158,
      discoveryYear: 1910,
    },
  ),
  /*
   * Rosetta's first target, and still an argument: an M-type spectrum on a
   * body with a chondritic density.
   */
  smallBody(
    'Lutetia',
    'asteroid',
    [60.5, 50.5, 37.5],
    1.7e18,
    8.1655,
    // 21 Lutetia (A852 VA)
    {
      a: 2.43443074,
      e: 0.1647704,
      i: 3.064453,
      node: 80.83856,
      w: 249.8803,
      m: 313.3401,
    },
    0.19,
    { r: 0.52, g: 0.5, b: 0.47 },
    {
      temperature: 175,
      discoveryYear: 1852,
    },
  ),
  /*
   * The first asteroid ever resolved by a spacecraft, in 1991.
   */
  smallBody(
    'Gaspra',
    'asteroid',
    [10.7521, 6.6567, 5.5602],
    2.5e15,
    7.042,
    // 951 Gaspra (A916 OJ)
    {
      a: 2.20997835,
      e: 0.1737375,
      i: 4.104655,
      node: 252.9673,
      w: 130.0038,
      m: 96.29561,
    },
    0.246,
    { r: 0.62, g: 0.54, b: 0.44 },
    {
      temperature: 183,
      figure: {
        intermediateRadius: 6.6567 * KM,
        model: 'gaspra',
        irregularity: 0,
      },
      discoveryYear: 1916,
    },
  ),
  /*
   * A diamond, literally in outline: Rosetta photographed a body shaped
   * like a cut gem.
   */
  smallBody(
    'Steins',
    'asteroid',
    [3.24, 2.73, 2.04],
    110_000_000_000_000,
    6.049,
    // 2867 Steins (1969 VC)
    {
      a: 2.36314178,
      e: 0.1467868,
      i: 9.924749,
      node: 55.29362,
      w: 251.4371,
      m: 175.7474,
    },
    0.3,
    { r: 0.66, g: 0.64, b: 0.62 },
    {
      temperature: 175,
      discoveryYear: 1969,
    },
  ),
  smallBody(
    'Annefrank',
    'asteroid',
    [3.3, 2.5, 1.7],
    13_000_000_000_000,
    15.12,
    // 5535 Annefrank (1942 EM)
    {
      a: 2.2123623,
      e: 0.06320478,
      i: 4.247441,
      node: 120.551,
      w: 9.553712,
      m: 248.9069,
    },
    0.311,
    { r: 0.66, g: 0.62, b: 0.56 },
    {
      temperature: 181,
      discoveryYear: 1942,
    },
  ),
  /*
   * A contact binary, photographed by Lucy in April 2025.
   */
  smallBody(
    'Donaldjohanson',
    'asteroid',
    [4, 1.8, 1.7],
    80_000_000_000_000,
    251,
    // 52246 Donaldjohanson (1981 EQ5)
    {
      a: 2.38383583,
      e: 0.1868594,
      i: 4.425205,
      node: 262.7765,
      w: 212.8821,
      m: 82.2348,
    },
    0.103,
    { r: 0.4, g: 0.38, b: 0.36 },
    {
      temperature: 178,
      discoveryYear: 1981,
    },
  ),
  /*
   * Lucy's warm-up target, which turned out to have a contact-binary moon
   * nobody had predicted.
   */
  smallBody(
    'Dinkinesh',
    'asteroid',
    [0.395, 0.36, 0.35],
    460_000_000_000,
    52.67,
    // 152830 Dinkinesh (1999 VD57)
    {
      a: 2.19176875,
      e: 0.1126817,
      i: 2.093117,
      node: 21.35271,
      w: 66.91637,
      m: 336.7785,
    },
    0.27,
    { r: 0.52, g: 0.48, b: 0.44 },
    {
      temperature: 183,
      discoveryYear: 1999,
      moons: [
        /*
         * A contact binary orbiting an asteroid: two touching spheres, going
         * round something 700 m across.
         */
        satellite(
          'Selam',
          [0.1725, 0.1, 0.1],
          600_000_000,
          3.11,
          2.4,
          0,
          0,
          0.24,
          { r: 0.52, g: 0.48, b: 0.44 },
        ),
      ],
    },
  ),

  /* --- Jupiter trojans ----------------------------------------------------- */
  /*
   * Sixty degrees ahead of Jupiter and sixty behind, in the two Lagrange
   * points where a small body can sit forever. There are about as many of
   * them as there are asteroids in the main belt and almost nothing is
   * known about any of them, which is why Lucy is visiting five.
   */
  /*
   * A binary of two nearly equal bodies, and a Lucy target.
   */
  smallBody(
    'Patroclus',
    'asteroid',
    [63.5, 58.5, 49],
    1.36e18,
    102.8,
    // 617 Patroclus (A906 UL)
    {
      a: 5.20597517,
      e: 0.1391468,
      i: 22.06359,
      node: 44.34969,
      w: 308.8377,
      m: 337.5035,
    },
    0.047,
    { r: 0.32, g: 0.28, b: 0.26 },
    {
      temperature: 121,
      discoveryYear: 1906,
      moons: [
        satellite(
          'Menoetius',
          [58.5, 54, 49],
          1.16e18,
          680,
          4.283,
          0.02,
          0,
          0.047,
          { r: 0.32, g: 0.28, b: 0.26 },
        ),
      ],
    },
  ),
  smallBody(
    'Eurybates',
    'asteroid',
    [38, 35, 30],
    1e17,
    8.711,
    // 3548 Eurybates (1973 SO)
    {
      a: 5.21737162,
      e: 0.09059867,
      i: 8.051473,
      node: 43.55873,
      w: 28.69968,
      m: 47.19974,
    },
    0.052,
    { r: 0.32, g: 0.31, b: 0.31 },
    {
      temperature: 121,
      discoveryYear: 1973,
      moons: [
        satellite(
          'Queta',
          [0.6, 0.6, 0.6],
          100_000_000_000,
          2_350,
          82,
          0,
          0,
          0.05,
          { r: 0.32, g: 0.31, b: 0.31 },
        ),
      ],
    },
  ),
  smallBody(
    'Polymele',
    'asteroid',
    [13, 11, 9],
    4e15,
    5.8607,
    // 15094 Polymele (1999 WB2)
    {
      a: 5.19151413,
      e: 0.09592246,
      i: 12.97735,
      node: 50.33106,
      w: 5.865299,
      m: 58.90027,
    },
    0.091,
    { r: 0.38, g: 0.34, b: 0.31 },
    {
      temperature: 121,
      discoveryYear: 1999,
    },
  ),
  /*
   * A 445-hour rotation. Nothing this size should be turning that slowly,
   * and nobody knows why it is.
   */
  smallBody(
    'Leucus',
    'asteroid',
    [20.5, 14.5, 13],
    1.6e16,
    445.924,
    // 11351 Leucus (1997 TS25)
    {
      a: 5.31238283,
      e: 0.0649579,
      i: 11.54342,
      node: 251.0799,
      w: 162.4048,
      m: 81.95069,
    },
    0.079,
    { r: 0.36, g: 0.31, b: 0.28 },
    {
      temperature: 120,
      discoveryYear: 1997,
    },
  ),
  smallBody(
    'Orus',
    'asteroid',
    [28, 25, 22],
    6e16,
    13.45,
    // 21900 Orus (1999 VQ10)
    {
      a: 5.12337424,
      e: 0.03672541,
      i: 8.46858,
      node: 258.5504,
      w: 182.7885,
      m: 356.2977,
    },
    0.075,
    { r: 0.34, g: 0.3, b: 0.28 },
    {
      temperature: 122,
      discoveryYear: 1999,
    },
  ),

  /* --- Near-Earth objects -------------------------------------------------- */
  /*
   * The ones that cross our orbit. Three have been visited and sampled, one
   * has been deliberately hit, and one passes inside geostationary orbit in
   * 2029.
   */
  /*
   * Half-extents measured off the shipped shape model, not JPL's 34.4 x
   * 11.2 x 11.2 km — which is the best-fit ellipsoid of a body bent like a
   * banana, and 40% narrower than the bounding box. The volumes agree to
   * 1%.
   */
  smallBody(
    'Eros',
    'asteroid',
    [17.5561, 8.5856, 6.0727],
    6.687e15,
    5.27,
    // 433 Eros (A898 PA)
    {
      a: 1.45824372,
      e: 0.222878,
      i: 10.82854,
      node: 304.268,
      w: 178.9181,
      m: 58.28335,
    },
    0.25,
    { r: 0.62, g: 0.54, b: 0.44 },
    {
      axialTilt: 89 * DEG,
      temperature: 225,
      figure: {
        intermediateRadius: 8.5856 * KM,
        model: 'eros',
        irregularity: 0,
      },
      discoveryYear: 1898,
    },
  ),
  /*
   * A rubble pile with no craters and two lobes: the first body anyone
   * brought a sample home from.
   */
  smallBody(
    'Itokawa',
    'asteroid',
    [0.3055, 0.155, 0.1239],
    35_100_000_000,
    12.132,
    // 25143 Itokawa (1998 SF36)
    {
      a: 1.32405228,
      e: 0.2801776,
      i: 1.620941,
      node: 69.0745,
      w: 162.8409,
      m: 44.37834,
    },
    0.23,
    { r: 0.56, g: 0.5, b: 0.42 },
    {
      axialTilt: -89 * DEG,
      temperature: 236,
      figure: {
        intermediateRadius: 0.155 * KM,
        model: 'itokawa',
        irregularity: 0,
      },
      discoveryYear: 1998,
    },
  ),
  /*
   * 177.6 degrees of obliquity, carried here as a supplement and a negative
   * period is not needed — its spin is prograde about a pole that points
   * south. The equatorial ridge is centrifugal: the whole body is being
   * slowly spun apart.
   */
  smallBody(
    'Bennu',
    'asteroid',
    [0.2855, 0.2764, 0.2508],
    73_290_000_000,
    4.296061,
    // 101955 Bennu (1999 RQ36)
    {
      a: 1.12639103,
      e: 0.2037451,
      i: 6.034944,
      node: 2.060866,
      w: 66.22306,
      m: 29.43048,
    },
    0.044,
    { r: 0.3, g: 0.29, b: 0.29 },
    {
      axialTilt: 2.4 * DEG,
      temperature: 261,
      texture: 'bennu',
      figure: {
        intermediateRadius: 0.2764 * KM,
        model: 'bennu',
        irregularity: 0,
      },
      discoveryYear: 1999,
    },
  ),
  /*
   * Retrograde, and the same spinning-top shape as Bennu for the same
   * reason. No shape model is vendored: JAXA archives it, and this
   * project's shape ingest only speaks PDS.
   */
  smallBody(
    'Ryugu',
    'asteroid',
    [0.502, 0.502, 0.438],
    450_000_000_000,
    -7.63262,
    // 162173 Ryugu (1999 JU3)
    {
      a: 1.19091893,
      e: 0.191073,
      i: 5.866442,
      node: 251.2897,
      w: 211.609,
      m: 299.9054,
    },
    0.045,
    { r: 0.28, g: 0.27, b: 0.27 },
    {
      axialTilt: 8.4 * DEG,
      temperature: 254,
      discoveryYear: 1999,
    },
  ),
  /*
   * The one orbit in the Solar System a human being has changed on purpose.
   */
  smallBody(
    'Didymos',
    'asteroid',
    [0.4095, 0.4095, 0.3495],
    528_000_000_000,
    2.2593,
    // 65803 Didymos (1996 GT)
    {
      a: 1.64270961,
      e: 0.3831233,
      i: 3.413877,
      node: 72.98582,
      w: 319.5807,
      m: 60.8695,
    },
    0.15,
    { r: 0.48, g: 0.44, b: 0.4 },
    {
      temperature: 214,
      discoveryYear: 1996,
      moons: [
        /*
         * Its period was 11.92 hours until 26 September 2022, when DART hit it
         * and made it 11.37.
         */
        satellite(
          'Dimorphos',
          [0.0895, 0.083, 0.0755],
          4_300_000_000,
          1.189,
          0.4776,
          0,
          0,
          0.15,
          { r: 0.48, g: 0.44, b: 0.4 },
        ),
      ],
    },
  ),
  /*
   * It does not rotate, it tumbles: non-principal-axis motion with two
   * periods, 5.4 days and 7.3, and no fixed pole at all. The single signed
   * period here is the 7.3-day one, which is the least wrong answer a model
   * with one number for the question can give.
   */
  smallBody(
    'Toutatis',
    'asteroid',
    [2.5116, 1.1715, 0.9611],
    16_200_000_000_000,
    176,
    // 4179 Toutatis (1989 AC)
    {
      a: 2.54304716,
      e: 0.6246302,
      i: 0.4480837,
      node: 125.3655,
      w: 277.8615,
      m: 298.8721,
    },
    0.405,
    { r: 0.58, g: 0.52, b: 0.44 },
    {
      temperature: 167,
      figure: {
        intermediateRadius: 1.1715 * KM,
        model: 'toutatis',
        irregularity: 0,
      },
      discoveryYear: 1989,
    },
  ),
  /*
   * Passes inside geostationary orbit on 13 April 2029, which is closer
   * than some of the things people watch television through.
   */
  smallBody(
    'Apophis',
    'asteroid',
    [0.225, 0.14, 0.14],
    61_000_000_000,
    30.56,
    // 99942 Apophis (2004 MN4)
    {
      a: 0.922359221,
      e: 0.1911492,
      i: 3.340997,
      node: 203.8937,
      w: 126.6796,
      m: 232.2531,
    },
    0.35,
    { r: 0.5, g: 0.46, b: 0.42 },
    {
      temperature: 279,
      discoveryYear: 2004,
    },
  ),
  /*
   * An asteroid that behaves like a comet: perihelion at 0.14 AU, where it
   * gets hot enough to shed the dust that becomes the Geminids.
   */
  smallBody(
    'Phaethon',
    'asteroid',
    [3.2, 3, 2.9],
    140_000_000_000_000,
    3.604,
    // 3200 Phaethon (1983 TB)
    {
      a: 1.27146462,
      e: 0.8896723,
      i: 22.31053,
      node: 265.0988,
      w: 322.3002,
      m: 143.7124,
    },
    0.1066,
    { r: 0.44, g: 0.44, b: 0.48 },
    {
      temperature: 244,
      discoveryYear: 1983,
    },
  ),
  /*
   * The largest near-Earth asteroid, and not the moon of Jupiter it is
   * constantly mistaken for.
   */
  smallBody(
    'Ganymed',
    'asteroid',
    [20.5, 18.5, 17],
    3.3e16,
    10.297,
    // 1036 Ganymed (A924 UB)
    {
      a: 2.66406882,
      e: 0.5335007,
      i: 26.68765,
      node: 215.3977,
      w: 132.5073,
      m: 114.3941,
    },
    0.238,
    { r: 0.56, g: 0.5, b: 0.44 },
    {
      temperature: 166,
      discoveryYear: 1924,
    },
  ),
  /*
   * The most elongated body of its size known: 5 km long and 2 wide.
   */
  smallBody(
    'Geographos',
    'asteroid',
    [2.6855, 1.2048, 1.0279],
    4_000_000_000_000,
    5.222,
    // 1620 Geographos (1951 RA)
    {
      a: 1.24580362,
      e: 0.3355178,
      i: 13.33676,
      node: 337.1349,
      w: 277.0291,
      m: 350.7669,
    },
    0.29,
    { r: 0.6, g: 0.54, b: 0.46 },
    {
      temperature: 242,
      figure: {
        intermediateRadius: 1.2048 * KM,
        model: 'geographos',
        irregularity: 0,
      },
      discoveryYear: 1951,
    },
  ),
  /*
   * The first asteroid ever imaged: two touching lobes, resolved by Arecibo
   * radar in 1989.
   */
  smallBody(
    'Castalia',
    'asteroid',
    [0.8562, 0.515, 0.4541],
    500_000_000_000,
    4.095,
    // 4769 Castalia (1989 PB)
    {
      a: 1.06308849,
      e: 0.4831758,
      i: 8.88519,
      node: 325.4991,
      w: 121.4523,
      m: 101.5139,
    },
    0.12,
    { r: 0.5, g: 0.46, b: 0.42 },
    {
      temperature: 267,
      figure: {
        intermediateRadius: 0.515 * KM,
        model: 'castalia',
        irregularity: 0,
      },
      discoveryYear: 1989,
    },
  ),
  /*
   * The body the Yarkovsky effect was first measured on: sunlight had moved
   * it 15 km in twelve years.
   */
  smallBody(
    'Golevka',
    'asteroid',
    [0.374, 0.2962, 0.2728],
    210_000_000_000,
    6.026,
    // 6489 Golevka (1991 JX)
    {
      a: 2.47437847,
      e: 0.6190939,
      i: 2.260612,
      node: 208.5519,
      w: 69.78033,
      m: 17.90107,
    },
    0.151,
    { r: 0.54, g: 0.5, b: 0.46 },
    {
      temperature: 174,
      figure: {
        intermediateRadius: 0.2962 * KM,
        model: 'golevka',
        irregularity: 0,
      },
      discoveryYear: 1991,
    },
  ),
  /*
   * Eleven meters across and turning once every five and a half minutes,
   * which is fast enough that its own surface is very nearly weightless.
   * The 1999 Arecibo radar model made it thirty meters; Hayabusa2's target
   * selection revised it down by a factor of three, so the *shape* here is
   * the radar model's and the *size* is JPL's — the axis ratios survive the
   * rescale and the absolute scale does not. It arrives in 2031.
   */
  smallBody(
    '1998 KY26',
    'asteroid',
    [0.0059, 0.00551, 0.00512],
    500_000,
    0.089193,
    // (1998 KY26)
    {
      a: 1.22885981,
      e: 0.2000498,
      i: 1.491131,
      node: 84.18218,
      w: 210.0033,
      m: 359.7453,
    },
    0.24,
    { r: 0.55, g: 0.52, b: 0.48 },
    {
      temperature: 245,
      figure: {
        intermediateRadius: 0.00551 * KM,
        model: 'ky26',
        irregularity: 0,
      },
    },
  ),
  smallBody(
    'Icarus',
    'asteroid',
    [0.65, 0.6, 0.55],
    2_900_000_000_000,
    2.2726,
    // 1566 Icarus (1949 MA)
    {
      a: 1.07799421,
      e: 0.8270189,
      i: 22.80164,
      node: 87.94856,
      w: 31.44439,
      m: 106.5347,
    },
    0.51,
    { r: 0.7, g: 0.66, b: 0.6 },
    {
      temperature: 253,
      discoveryYear: 1949,
    },
  ),

  /* --- Centaurs and the Kuiper belt ---------------------------------------- */
  /*
   * Between Jupiter and Neptune, on orbits that are not stable for more
   * than a few million years, plus the one Kuiper belt object anyone has
   * photographed up close. Two of the three centaurs here have rings, which
   * nobody expected small bodies to be able to keep.
   */
  /*
   * The first small body anyone found rings around, in a 2013 occultation
   * nobody was looking for rings in.
   */
  smallBody(
    'Chariklo',
    'asteroid',
    [157, 139, 86],
    6.3e18,
    7.004,
    // 10199 Chariklo (1997 CU26)
    {
      a: 15.7343733,
      e: 0.1708196,
      i: 23.4319,
      node: 300.4769,
      w: 241.2066,
      m: 337.612,
    },
    0.045,
    { r: 0.34, g: 0.3, b: 0.28 },
    {
      temperature: 70,
      discoveryYear: 1997,
      /*
       * Two rings 7 and 3 km wide, found in 2013 when the body occulted a
       * star and the star blinked twice on the way in and twice on the way
       * out.
       */ rings: {
        innerRadius: 386_000,
        outerRadius: 405_000,
        opticalDepth: 0.4,
        texture: null,
      },
    },
  ),
  /*
   * Discovered as an asteroid and reclassified when it grew a coma. It has
   * rings too.
   */
  smallBody(
    'Chiron',
    'asteroid',
    [105, 90, 80],
    2.4e18,
    5.918,
    // 2060 Chiron (1977 UB)
    {
      a: 13.6842676,
      e: 0.3797656,
      i: 6.930574,
      node: 209.2961,
      w: 339.2878,
      m: 28.72481,
    },
    0.15,
    { r: 0.36, g: 0.34, b: 0.34 },
    {
      temperature: 74,
      discoveryYear: 1977,
      /*
       * Probably rings; the occultation features are real and the
       * interpretation is still argued.
       */ rings: {
        innerRadius: 300_000,
        outerRadius: 330_000,
        opticalDepth: 0.1,
        texture: null,
      },
    },
  ),
  /*
   * Two flattened lobes touching: the most distant object ever visited, and
   * the least altered thing anyone has photographed. Deep red from
   * irradiated methanol ice.
   */
  smallBody(
    'Arrokoth',
    'asteroid',
    [18, 10, 5],
    748_500_000_000_000,
    15.92,
    // 486958 Arrokoth (2014 MU69)
    {
      a: 44.0525784,
      e: 0.03555718,
      i: 2.450614,
      node: 159.0377,
      w: 188.8507,
      m: 278.4361,
    },
    0.165,
    { r: 0.62, g: 0.36, b: 0.26 },
    {
      axialTilt: 99 * DEG,
      temperature: 41,
      discoveryYear: 2014,
    },
  ),

  /* --- Comets -------------------------------------------------------------- */
  /*
   * Nuclei, not comas. A comet is a few kilometers of ice and dust that is
   * black — Halley's albedo is 0.04, which is darker than charcoal — and
   * everything anyone has ever seen of one is the hundred thousand
   * kilometers of gas coming off it. The nucleus is what is modeled here;
   * the coma is not, and drawing one is a rendering problem rather than a
   * data one.
   */
  /*
   * Albedo 0.04. The Giotto flyby found the darkest surface anyone had ever
   * measured, and it is still near the bottom of the list.
   */
  smallBody(
    'Halley',
    'comet',
    [8.8498, 4.0991, 4.0188],
    220_000_000_000_000,
    52.8,
    // 1P/Halley
    {
      a: 17.928635,
      e: 0.967936,
      i: 162.1905,
      node: 59.09895,
      w: 112.2414,
      m: 65.89031,
    },
    0.04,
    { r: 0.14, g: 0.13, b: 0.12 },
    {
      temperature: 66,
      figure: {
        intermediateRadius: 4.0991 * KM,
        model: 'halley',
        irregularity: 0,
      },
      discoveryYear: 1758,
    },
  ),
  /*
   * A 3.3-year period, the shortest of any known comet, and almost no tail
   * left to show for it.
   */
  smallBody(
    'Encke',
    'comet',
    [2.4, 2.4, 2.4],
    92_000_000_000_000,
    11.083,
    // 2P/Encke
    {
      a: 2.21967135,
      e: 0.8475034,
      i: 11.38681,
      node: 334.1499,
      w: 187.1741,
      m: 288.6233,
    },
    0.046,
    { r: 0.16, g: 0.15, b: 0.14 },
    {
      temperature: 186,
      discoveryYear: 1786,
    },
  ),
  /*
   * Deep Impact put an 800 kg copper slug into it at 10 km/s in 2005, and
   * Stardust went back to photograph the crater.
   */
  smallBody(
    'Tempel 1',
    'comet',
    [3.8, 2.45, 2.45],
    79_000_000_000_000,
    40.7,
    // 9P/Tempel 1
    {
      a: 3.14613376,
      e: 0.5097028,
      i: 10.47343,
      node: 68.75357,
      w: 179.1973,
      m: 10.02744,
    },
    0.05,
    { r: 0.15, g: 0.14, b: 0.13 },
    {
      temperature: 156,
      discoveryYear: 1867,
    },
  ),
  /*
   * A bowling pin, and one of the darkest objects in the Solar System.
   */
  smallBody(
    'Borrelly',
    'comet',
    [4, 1.8, 1.8],
    20_000_000_000_000,
    25,
    // 19P/Borrelly
    {
      a: 3.60696468,
      e: 0.6379143,
      i: 29.31866,
      node: 74.30084,
      w: 351.8616,
      m: 279.3066,
    },
    0.022,
    { r: 0.13, g: 0.12, b: 0.12 },
    {
      temperature: 146,
      discoveryYear: 1904,
    },
  ),
  /*
   * The Leonids come from here, every thirty-three years.
   */
  smallBody(
    'Tempel-Tuttle',
    'comet',
    [1.8, 1.8, 1.8],
    12_000_000_000_000,
    15,
    // 55P/Tempel-Tuttle
    {
      a: 10.3383382,
      e: 0.9055527,
      i: 162.4866,
      node: 235.271,
      w: 172.5003,
      m: 19.93688,
    },
    0.06,
    { r: 0.16, g: 0.15, b: 0.14 },
    {
      temperature: 86,
      discoveryYear: 1866,
    },
  ),
  /*
   * The duck. Two lobes and a neck, 533 kg/m3, and the only comet anyone
   * has landed on. Its shape model is in ESA's archive rather than the PDS,
   * so the figure here is the measured half-extents and a generated
   * surface.
   */
  smallBody(
    'Churyumov-Gerasimenko',
    'comet',
    [2.09, 1.29, 1.03],
    9_982_000_000_000,
    12.76129,
    // 67P/Churyumov-Gerasimenko
    {
      a: 3.46224949,
      e: 0.6409081,
      i: 7.040295,
      node: 50.13557,
      w: 12.79825,
      m: 207.554,
    },
    0.06,
    { r: 0.15, g: 0.14, b: 0.13 },
    {
      axialTilt: 52 * DEG,
      temperature: 149,
      discoveryYear: 1969,
    },
  ),
  /*
   * Stardust flew through its coma and brought the dust back.
   */
  smallBody(
    'Wild 2',
    'comet',
    [2.75, 2, 1.65],
    23_000_000_000_000,
    13.5,
    // 81P/Wild 2
    {
      a: 3.44974558,
      e: 0.5373989,
      i: 3.237004,
      node: 136.1102,
      w: 41.72523,
      m: 150.2977,
    },
    0.03,
    { r: 0.16, g: 0.15, b: 0.14 },
    {
      temperature: 149,
      discoveryYear: 1978,
    },
  ),
  /*
   * A peanut 2.33 km long, spraying carbon dioxide jets out of both ends
   * and nothing out of the middle. The waist is 0.7 km across and the lobes
   * 0.8, so the half-extents here are the ellipsoid of the same volume as
   * EPOXI's 1.16 km effective radius rather than the bounding box of a
   * dumbbell.
   */
  smallBody(
    'Hartley 2',
    'comet',
    [1.165, 0.41, 0.41],
    300_000_000_000,
    18.1,
    // 103P/Hartley 2
    {
      a: 3.47565249,
      e: 0.6935979,
      i: 13.59947,
      node: 219.7422,
      w: 181.3218,
      m: 118.8415,
    },
    0.028,
    { r: 0.16, g: 0.15, b: 0.14 },
    {
      temperature: 149,
      discoveryYear: 1986,
    },
  ),
  /*
   * The Perseids, and the largest object known to make repeated close
   * approaches to Earth.
   */
  smallBody(
    'Swift-Tuttle',
    'comet',
    [13, 13, 13],
    1e16,
    69.4,
    // 109P/Swift-Tuttle
    {
      a: 26.0920695,
      e: 0.9632258,
      i: 113.4538,
      node: 139.3812,
      w: 152.9822,
      m: 19.05336,
    },
    0.04,
    { r: 0.15, g: 0.14, b: 0.13 },
    {
      temperature: 54,
      discoveryYear: 1862,
    },
  ),
  /*
   * Visible to the naked eye for eighteen months in 1996 and 1997, which is
   * longer than any comet in recorded history.
   */
  smallBody(
    'Hale-Bopp',
    'comet',
    [30, 30, 30],
    1.3e17,
    11.35,
    // C/1995 O1 (Hale-Bopp)
    {
      a: 177.433384,
      e: 0.994981,
      i: 89.28759,
      node: 282.7334,
      w: 130.4147,
      m: 0.4202943,
    },
    0.04,
    { r: 0.2, g: 0.19, b: 0.18 },
    {
      temperature: 21,
    },
  ),
  /*
   * The brightest comet of the 2020s from the northern hemisphere, and it
   * will not be back for six thousand years.
   */
  smallBody(
    'NEOWISE',
    'comet',
    [2.5, 2.5, 2.5],
    70_000_000_000_000,
    7.58,
    // C/2020 F3 (NEOWISE)
    {
      a: 358.467957,
      e: 0.999178,
      i: 128.9375,
      node: 61.01043,
      w: 37.27866,
      m: 358.9124,
    },
    0.04,
    { r: 0.18, g: 0.17, b: 0.16 },
    {
      temperature: 15,
    },
  ),
]

/** Every small body and every satellite of one, flattened. */
export function* walkSmallBodies(): Generator<SolarBody> {
  for (const body of SOLAR_SMALL_BODIES) {
    yield body
    for (const moon of body.moons) yield moon
  }
}
