import { loadCatalog, type StarCatalog } from './starCatalog.ts'
import {
  NO_INDEX,
  type PackedCatalog,
  type PackedPlanet,
  type PackedStar,
} from './format.ts'

/*
 * A five-star catalog for tests.
 *
 * Not a mock: these are the same records the packed file holds, run through the
 * same decoder and the same photometry, with values transcribed from HYG v4.4.
 * What it is not is the 460 KB asset — a test that reads that has to find a file,
 * which `packages/*` has no way to do and no business doing.
 *
 * Values here are load-bearing. `catalog.test.ts` checks the derived
 * temperatures and luminosities against published ones, so changing a magnitude
 * to make a test pass changes what the test is measuring.
 */

const star = (
  overrides: Partial<PackedStar> & Pick<PackedStar, 'id' | 'commonName'>,
): PackedStar => ({
  x: 0,
  y: 0,
  z: 0,
  absoluteMagnitude: null,
  colourIndex: null,
  spectralType: '',
  components: 1,
  provenance: 'observed',
  hip: 0,
  hd: 0,
  hr: 0,
  constellation: NO_INDEX,
  bayer: NO_INDEX,
  bayerSuperscript: 0,
  flamsteed: 0,
  proper: '',
  gliese: '',
  ...overrides,
})

/*
 * Heliocentric galactic cartesian meters. Computed once from each star's
 * published right ascension, declination and parallax through
 * `equatorialToGalactic` — written out rather than computed here so that a
 * change to that conversion shows up as a failing distance test instead of
 * silently moving the fixture along with the code under test.
 */
const LY = 9.4607304725808e15

const STARS: readonly PackedStar[] = [
  star({
    id: 'SOL',
    commonName: 'Sol',
    proper: 'Sol',
    spectralType: 'G2V',
    absoluteMagnitude: 4.85,
    colourIndex: 0.656,
  }),
  star({
    id: 'HIP70890',
    commonName: 'Proxima Centauri',
    proper: 'Proxima Centauri',
    gliese: 'Gl 551',
    hip: 70_890,
    spectralType: 'M5Ve',
    absoluteMagnitude: 15.447,
    colourIndex: 1.807,
    constellation: 18, // Cen
    x: 2.9315 * LY,
    y: -3.0415 * LY,
    z: -0.1423 * LY,
  }),
  star({
    id: 'HIP71683',
    commonName: 'Alpha Centauri',
    proper: 'Rigil Kentaurus',
    gliese: 'Gl 559A',
    hip: 71_683,
    hd: 128_620,
    hr: 5_459,
    components: 2,
    spectralType: 'G2V',
    absoluteMagnitude: 4.379,
    colourIndex: 0.71,
    constellation: 18, // Cen
    bayer: 0, // Alp
    bayerSuperscript: 1,
    x: 3.0943 * LY,
    y: -3.0155 * LY,
    z: -0.0514 * LY,
  }),
  star({
    id: 'HIP87937',
    commonName: "Barnard's Star",
    proper: "Barnard's Star",
    gliese: 'Gl 699',
    hip: 87_937,
    spectralType: 'sdM4',
    absoluteMagnitude: 13.235,
    colourIndex: 1.57,
    constellation: 58, // Oph
    x: 4.9455 * LY,
    y: 2.9726 * LY,
    z: 1.4454 * LY,
  }),
  star({
    id: 'HIP32349',
    commonName: 'Sirius',
    proper: 'Sirius',
    gliese: 'Gl 244A',
    hip: 32_349,
    hd: 48_915,
    hr: 2_491,
    components: 2,
    spectralType: 'A0m...',
    absoluteMagnitude: 1.454,
    colourIndex: 0.009,
    constellation: 13, // CMa
    bayer: 0, // Alp
    flamsteed: 9,
    x: -5.7704 * LY,
    y: -6.2381 * LY,
    z: -1.3292 * LY,
  }),
]

/** Two of Barnard's Star's confirmed planets, as the archive publishes them. */
const PLANETS: readonly PackedPlanet[] = [
  {
    host: 3,
    letter: 'b',
    name: '',
    semiMajorAxisAu: 0.022_9,
    orbitalPeriodDays: 3.154,
    eccentricity: 0,
    inclinationDeg: null,
    argumentOfPeriapsisDeg: null,
    massEarths: 0.3,
    massIsLowerBound: true,
    radiusEarths: null,
    equilibriumTemperature: 400,
    insolation: null,
    discoveryYear: 2024,
    discoveryMethod: 'Radial Velocity',
    circumbinary: false,
  },
  {
    host: 3,
    letter: 'c',
    name: '',
    semiMajorAxisAu: 0.028_1,
    orbitalPeriodDays: 4.124,
    eccentricity: 0,
    inclinationDeg: null,
    argumentOfPeriapsisDeg: null,
    massEarths: 0.335,
    massIsLowerBound: true,
    radiusEarths: null,
    equilibriumTemperature: 370,
    insolation: null,
    discoveryYear: 2025,
    discoveryMethod: 'Radial Velocity',
    circumbinary: false,
  },
]

/**
 * The fixture catalog.
 *
 * `completeRadiusLightYears` is zero on purpose: procedural fill stays on, so a
 * test that generates a cell near Sol still gets stars to generate. The real
 * asset sets it to 25 and `apps/ingest` tests that side.
 */
export const TEST_VOLUME: PackedCatalog = {
  metadata: {
    version: 'fixture-1',
    radiusLightYears: 10,
    completeRadiusLightYears: 0,
    attribution: [],
    sources: [],
  },
  stars: STARS,
  planets: PLANETS,
}

export const TEST_CATALOG: StarCatalog = loadCatalog(TEST_VOLUME)

/*
 * Two of Orion's stars as the sky asset holds them: far beyond the volume,
 * naked-eye bright, at their HYG v4.4 positions through the same projection
 * as the five above. Betelgeuse is the brightest red supergiant in the sky
 * and Rigel the brightest blue one, which is what makes the pair useful — a
 * colour test needs both ends of the ramp.
 */
const SKY_STARS: readonly PackedStar[] = [
  star({
    id: 'HIP27989',
    commonName: 'Betelgeuse',
    proper: 'Betelgeuse',
    hip: 27_989,
    hd: 39_801,
    hr: 2_061,
    spectralType: 'M2Ib',
    absoluteMagnitude: -5.469,
    colourIndex: 1.5,
    constellation: 59, // Ori
    bayer: 0, // Alp
    flamsteed: 58,
    x: -462.8323 * LY,
    y: -166.5133 * LY,
    z: -77.541 * LY,
  }),
  star({
    id: 'HIP24436',
    commonName: 'Rigel',
    proper: 'Rigel',
    hip: 24_436,
    hd: 34_085,
    hr: 1_713,
    spectralType: 'B8Ia',
    absoluteMagnitude: -6.933,
    colourIndex: -0.03,
    constellation: 59, // Ori
    bayer: 1, // Bet
    flamsteed: 19,
    x: -680.9868 * LY,
    y: -381.2333 * LY,
    z: -368.0005 * LY,
  }),
]

/**
 * The sky asset's shape: no volume, a stated selection, no planets. The
 * selection begins where the fixture volume ends, as the real pair does.
 */
export const TEST_SKY: PackedCatalog = {
  metadata: {
    version: 'sky-fixture-1',
    radiusLightYears: 0,
    completeRadiusLightYears: 0,
    attribution: [],
    sources: [],
    sky: { beyondLightYears: 10, apparentMagnitudeLimit: 6.5 },
  },
  stars: SKY_STARS,
  planets: [],
}

/** The five-star volume and the two-star sky, indexed together as a host does. */
export const TEST_CATALOG_WITH_SKY: StarCatalog = loadCatalog(
  TEST_VOLUME,
  TEST_SKY,
)
