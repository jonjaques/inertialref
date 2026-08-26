import type { Kilograms, Meters } from '@inertialref/shared'
import { SECONDS_PER_DAY } from '@inertialref/shared'
import type { LinearRgb } from '../catalog/photometry.ts'
import type { SolarBody } from './bodies.ts'

/*
 * The moons that are rocks.
 *
 * `bodies.ts` carries the twenty satellites large enough for gravity to have
 * pulled them round. This carries twenty-one that it did not: the inner
 * shepherds, the co-orbitals, the captured irregulars, and Hyperion, which is
 * forty percent empty space and tumbling.
 *
 * They were left out originally for a defensible reason — "irregular captured
 * rubble a kilometer or two across, invisible from anywhere you would fly" —
 * and that reason was measured against a renderer that could only draw
 * spheres. It stopped being true twice over. Half of these are a hundred
 * kilometers and more across, nine of them have published shape models in
 * `data/shapes/`, and the ones that make the Solar System *look* like a system
 * are exactly these: Prometheus cutting a channel through the F ring,
 * Amalthea red with Io's sulfur, Pan and Atlas with ridges of ring material
 * swept onto their own equators.
 *
 * Elements and masses are the JPL satellite tables, the same source the
 * originals use. Half-extents come from the shipped shape model where there is
 * one — measured off the model rather than transcribed, so the number and the
 * geometry cannot disagree — and from the published tri-axial fit where there
 * is not. Albedos are transcribed.
 */

const KM: Meters = 1_000
const DEG = Math.PI / 180
const DAY = SECONDS_PER_DAY

/**
 * Brightness from measured albedo, on the class hue: the Lambert reflectance
 * `1.5 p`, on a hue normalized to carry color and nothing else. The same
 * mapping `smallBodies.ts` uses, and the reasoning is in its header.
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

const minorMoon = (
  name: string,
  /** Half-extents a >= b >= c, kilometers. */
  axes: readonly [number, number, number],
  mass: Kilograms,
  axisKm: number,
  periodDays: number,
  eccentricity: number,
  inclinationDeg: number,
  albedo: number,
  hue: LinearRgb,
  figure: { readonly model?: string } = {},
): SolarBody => {
  const [a, b, c] = axes
  return {
    name,
    kind: 'moon',
    radius: a * KM,
    polarRadius: c * KM,
    figure: {
      intermediateRadius: b * KM,
      model: figure.model ?? null,
      // Zero where a model carries the relief; the measured median otherwise.
      // See `irregularFigure` in `system.ts` for where 0.09 comes from.
      irregularity: figure.model === undefined ? 0.09 : 0,
    },
    mass,
    // Tidally locked, every one of them, except Hyperion — which is not
    // locked, not free, and not predictable: it tumbles. There is no rotation
    // period to give it, and the synchronous one is the least wrong answer
    // available to a model that has one number for the whole question.
    rotationPeriod: periodDays * DAY,
    axialTilt: 0,
    semiMajorAxis: axisKm * KM,
    eccentricity,
    inclination: inclinationDeg * DEG,
    argumentOfPeriapsis: 0,
    geometricAlbedo: albedo,
    temperature: 80,
    texture: null,
    tint: surfaceColour(albedo, hue),
    // The figure is the relief; see `smallBodies.ts`.
    relief: 0,
    roughness: 0.95,
    atmosphere: null,
    haze: null,
    clouds: null,
    rings: null,
    discoveryYear: 0,
    moons: [],
  }
}

/* --- Jupiter's inner shepherds and its largest irregular. ------------------ */
/*
 * The four inner moons orbit inside Io and inside the ring system they supply:
 * Metis and Adrastea are the source of the main ring, and Amalthea and Thebe
 * of the two gossamer rings named after them. Himalia is 11 million km out
 * and was captured.
 */
export const JOVIAN_MINOR: readonly SolarBody[] = [
  minorMoon('Metis', [30, 20, 17], 3.7457e16, 128_000, 0.294779, 0, 0, 0.061, {
    r: 0.36,
    g: 0.3,
    b: 0.26,
  }),
  /*
   * Eight kilometers across, and it is what keeps the outer edge of
   * Jupiter's main ring where it is.
   */
  minorMoon('Adrastea', [10, 8, 7], 2.0976e15, 129_000, 0.29826, 0, 0, 0.1, {
    r: 0.4,
    g: 0.36,
    b: 0.32,
  }),
  /*
   * The reddest object in the Solar System — sulfur blown off Io and
   * painted onto it — and less dense than water, so it is a pile of rubble
   * rather than a rock.
   */
  minorMoon(
    'Amalthea',
    [144.999, 83.0837, 69.5865],
    2.4656e18,
    181_400,
    0.499918,
    0.003,
    0.4,
    0.09,
    { r: 0.62, g: 0.28, b: 0.2 },
    { model: 'amalthea' },
  ),
  minorMoon(
    'Thebe',
    [53.1884, 47.2543, 42],
    4.5173e17,
    221_900,
    0.676105,
    0.018,
    1.1,
    0.047,
    { r: 0.45, g: 0.3, b: 0.25 },
    { model: 'thebe' },
  ),
  /*
   * The largest of Jupiter's seventy-odd captured irregulars, 11 million km
   * out and going the wrong way round nothing in particular.
   */
  minorMoon(
    'Himalia',
    [85, 85, 85],
    2.2707e18,
    11_439_000,
    249.909,
    0.16,
    28.4,
    0.057,
    { r: 0.32, g: 0.31, b: 0.3 },
  ),
]

/* --- Saturn's ring moons, co-orbitals and captures. ------------------------ */
/*
 * Every one of these is doing something to the rings or standing in a Lagrange
 * point. Saturn has 274 known moons; these are the nine that are *structural*.
 */
export const SATURNIAN_MINOR: readonly SolarBody[] = [
  /*
   * A ravioli: it sweeps the Encke Gap and has swept a ridge of ring
   * material onto its own equator.
   */
  minorMoon(
    'Pan',
    [17.2, 15.4, 10.4],
    4.1952e15,
    133_600,
    0.575051,
    0,
    0,
    0.5,
    { r: 0.9, g: 0.88, b: 0.84 },
  ),
  /*
   * The other ravioli, at the outer edge of the A ring.
   */
  minorMoon(
    'Atlas',
    [20.5, 17.8, 9.4],
    5.5437e15,
    137_700,
    0.604602,
    0.001,
    0,
    0.4,
    { r: 0.9, g: 0.88, b: 0.84 },
  ),
  /*
   * Steals material out of the F ring every 14.7 hours and leaves a dark
   * channel where it passed.
   */
  minorMoon(
    'Prometheus',
    [75, 47.2828, 36.8641],
    1.6047e17,
    139_400,
    0.615878,
    0.002,
    0,
    0.6,
    { r: 0.88, g: 0.86, b: 0.83 },
    { model: 'prometheus' },
  ),
  minorMoon(
    'Pandora',
    [57.7, 42.6915, 34.3574],
    1.3874e17,
    141_700,
    0.631369,
    0.004,
    0,
    0.5,
    { r: 0.88, g: 0.86, b: 0.83 },
    { model: 'pandora' },
  ),
  /*
   * Swaps orbits with Janus every four years. They are 50 km apart at
   * closest and have never collided.
   */
  minorMoon(
    'Epimetheus',
    [71.88, 55.09, 55.0194],
    5.265e17,
    151_400,
    0.697012,
    0.02,
    0.3,
    0.73,
    { r: 0.85, g: 0.83, b: 0.8 },
    { model: 'epimetheus' },
  ),
  minorMoon(
    'Janus',
    [106.953, 96.0332, 77.0326],
    1.8971e18,
    151_500,
    0.697353,
    0.007,
    0.2,
    0.71,
    { r: 0.85, g: 0.83, b: 0.8 },
    { model: 'janus' },
  ),
  /*
   * Sits in Dione's leading Lagrange point, and is coated in something so
   * smooth that Cassini could not find a crater rim on it.
   */
  minorMoon(
    'Helene',
    [22.5, 19.6, 13.3],
    7.1918e15,
    377_600,
    2.73692,
    0.007,
    0.2,
    1.67,
    { r: 0.95, g: 0.94, b: 0.92 },
  ),
  /*
   * A sponge. 40% empty space, tumbling chaotically rather than rotating —
   * the first body in the Solar System shown to have no predictable
   * orientation at all.
   */
  minorMoon(
    'Hyperion',
    [187.758, 134.937, 126.681],
    5.551e18,
    1_481_500,
    21.2767,
    0.105,
    0.6,
    0.3,
    { r: 0.66, g: 0.56, b: 0.44 },
    { model: 'hyperion' },
  ),
  /*
   * Retrograde, captured, and the source of the dark material on one face
   * of Iapetus — it sheds dust into a ring 13 million km across that nobody
   * saw until 2009.
   */
  minorMoon(
    'Phoebe',
    [109.4, 108.5, 101.8],
    8.3123e18,
    12_929_400,
    550.304,
    0.164,
    175.2,
    0.081,
    { r: 0.24, g: 0.23, b: 0.22 },
  ),
]

/* --- Neptune's inner moons, and Nereid. ------------------------------------ */
/*
 * Voyager 2 found six moons inside Triton's orbit in 1989 and nobody has been
 * back. Proteus is larger than Nereid and was missed from Earth for a century
 * because it orbits so close to a planet thirty times brighter than it.
 */
export const NEPTUNIAN_MINOR: readonly SolarBody[] = [
  minorMoon('Naiad', [48, 30, 26], 1.278e17, 48_200, 0.29398, 0, 4.7, 0.072, {
    r: 0.3,
    g: 0.29,
    b: 0.28,
  }),
  minorMoon(
    'Thalassa',
    [54, 50, 26],
    3.5345e17,
    50_100,
    0.311078,
    0,
    0.2,
    0.091,
    { r: 0.3, g: 0.29, b: 0.28 },
  ),
  minorMoon('Despina', [90, 74, 64], 1.7489e18, 52_500, 0.334656, 0, 0, 0.09, {
    r: 0.3,
    g: 0.29,
    b: 0.28,
  }),
  /*
   * Shepherds the Adams ring, which is not a ring but five arcs that should
   * have spread out long ago and have not.
   */
  minorMoon(
    'Galatea',
    [102, 92, 72],
    2.8452e18,
    62_000,
    0.428744,
    0,
    0,
    0.079,
    { r: 0.3, g: 0.29, b: 0.28 },
  ),
  minorMoon(
    'Larissa',
    [105.107, 96.6277, 89],
    3.8182e18,
    73_500,
    0.554989,
    0.001,
    0.2,
    0.091,
    { r: 0.3, g: 0.29, b: 0.28 },
    { model: 'larissa' },
  ),
  /*
   * As large as a body can be and still not be round — 420 km across, and
   * Voyager found it with a flat face.
   */
  minorMoon(
    'Proteus',
    [222.989, 205.493, 204.329],
    3.8707e19,
    117_600,
    1.12231,
    0,
    0,
    0.096,
    { r: 0.3, g: 0.29, b: 0.28 },
    { model: 'proteus' },
  ),
  /*
   * The most eccentric orbit of any moon anywhere: 1.4 million km at
   * closest and 9.6 million at furthest, which takes it a year to go round.
   */
  minorMoon(
    'Nereid',
    [178, 178, 170],
    2.9331e19,
    5_513_900,
    360.133,
    0.751,
    5.1,
    0.155,
    { r: 0.42, g: 0.41, b: 0.4 },
  ),
]
