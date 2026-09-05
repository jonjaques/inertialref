import type { Kelvin } from '@inertialref/shared'
import {
  isGiant,
  isWhiteDwarf,
  ladderIndex,
  type SpectralType,
} from './spectral.ts'

/*
 * Turning what a catalog measures into what a renderer needs.
 *
 * A star catalog records what a telescope can see: a distance, an apparent
 * magnitude in one band, a color index, a spectral classification. A renderer
 * needs radiant power, an emission temperature and an angular size. Nothing in
 * the first list is any of the second, and the conversion is the whole of this
 * file.
 *
 * The rule the packed catalog depends on: **store measurements, derive the
 * rest.** HYG ships a `lum` column, and it is exactly 10^((4.85 − absmag)/2.5)
 * — a restatement of `absmag`, in V band, labeled as if it were bolometric.
 * Storing it would cost two bytes per star to say something the file already
 * says, and would enshrine the V-band error. So `absmag` and `ci` are stored and
 * everything here runs at load time.
 *
 * These functions are a generation input: a system's planets are laid out from
 * its star's luminosity, so changing one of these changes the universe. That is
 * what `PHOTOMETRY_ALGORITHM` is for.
 */

/** Bolometric magnitude of the Sun, IAU 2015 Resolution B2. */
export const SOLAR_BOLOMETRIC_MAGNITUDE = 4.74
export const SOLAR_TEMPERATURE: Kelvin = 5772

/**
 * Effective temperature from the B−V color index (Ballesteros 2012).
 *
 * Derived by treating the star as a blackbody seen through the two Johnson
 * filters, so it needs no calibration table and it is monotonic — which matters
 * more here than the last hundred kelvin, because it is applied to 6,675 stars
 * whose classifications came from a dozen different observers.
 *
 * Outside roughly −0.3 < B−V < 2.0 it stops being meaningful, so the input is
 * clamped rather than extrapolated: an unclamped B−V of 2.5 turns the
 * denominator negative and returns a *negative* temperature.
 */
export function temperatureFromColourIndex(colourIndex: number): Kelvin {
  const bv = Math.min(2.0, Math.max(-0.3, colourIndex))
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))
}

/*
 * Effective temperature by spectral class, for the 8% of the catalog with no
 * usable color index — and, as it turns out, for most of the rest as well.
 *
 * The obvious source is the B−V color index, which 89% of the catalog
 * carries. Measured against seventeen stars with published temperatures, the
 * classification beats it: 2.8% mean absolute error against 4.7%, and 5% at the
 * worst case against 18%. B−V is a *photometric* proxy that Ballesteros' fit
 * bends badly at the red end, where most of the neighborhood lives; the
 * spectral type is a direct classification by somebody who looked at the lines.
 * See `effectiveTemperature` for where B−V still wins.
 *
 * Keyed by the OBAFGKM ladder index (O0 = 0, M9 = 69) so a subclass interpolates
 * between neighbors instead of snapping to its class. Three ladders, because a
 * K0III is 350 K cooler than a K0V and a K0I is 400 K cooler again — same
 * absorption lines, progressively larger and cooler stars. One ladder with a
 * scalar giant correction was tried first and left Arcturus 9% too hot.
 *
 * The dwarf ladder is Pecaut & Mamajek (2013) — deliberately the *same* source
 * as the bolometric corrections below. An earlier version mixed an older
 * temperature scale with those corrections, and the disagreement between the two
 * calibrations put Proxima Centauri at a third of its real luminosity. Two
 * tables that are each individually defensible are not interchangeable inputs to
 * the same calculation.
 */
const DWARF_TEMPERATURES: readonly (readonly [number, Kelvin])[] = [
  [5, 41_500], // O5V
  [9, 33_000], // O9V
  [10, 31_400], // B0V
  [15, 15_700], // B5V
  [19, 10_700], // B9V
  [20, 9_700], // A0V
  [25, 8_080], // A5V
  [29, 7_440], // A9V
  [30, 7_220], // F0V
  [35, 6_510], // F5V
  [39, 6_050], // F9V
  [40, 5_930], // G0V
  [42, 5_770], // G2V — the Sun
  [45, 5_660], // G5V
  [49, 5_380], // G9V
  [50, 5_270], // K0V
  [52, 5_030], // K2V
  [55, 4_440], // K5V
  [57, 4_070], // K7V
  [60, 3_870], // M0V
  [61, 3_700], // M1V
  [62, 3_550], // M2V
  [63, 3_410], // M3V
  [64, 3_200], // M4V
  [65, 3_030], // M5V
  [66, 2_850], // M6V
  [67, 2_650], // M7V
  [68, 2_500], // M8V
  [69, 2_400], // M9V
]

const GIANT_TEMPERATURES: readonly (readonly [number, Kelvin])[] = [
  [10, 29_000], // B0III
  [20, 10_100], // A0III
  [30, 7_150], // F0III
  [40, 5_850], // G0III
  [45, 5_050], // G5III
  [50, 4_810], // K0III
  [52, 4_500], // K2III
  [55, 3_980], // K5III
  [60, 3_800], // M0III
  [65, 3_330], // M5III
  [69, 3_000], // M9III
]

const SUPERGIANT_TEMPERATURES: readonly (readonly [number, Kelvin])[] = [
  [0, 40_000], // O0I
  [10, 21_000], // B0I
  [20, 9_730], // A0I
  [30, 7_700], // F0I
  [40, 5_550], // G0I
  [50, 4_420], // K0I
  [60, 3_620], // M0I
  [69, 2_900], // M9I
]

/** Class-typical temperatures for the classes that are not on the ladder. */
const OFF_LADDER_TEMPERATURES: Readonly<Record<string, Kelvin>> = {
  L: 2_250, // L0, same source
  T: 1_300, // T0
  Y: 450, // Y0
  W: 60_000, // Wolf-Rayet; no sequence, and none are anywhere near
  C: 3_000, // carbon star
  S: 3_200,
  D: 10_000, // white dwarfs span 4,000–100,000 K; this is the peak of the field
}

function interpolate(
  table: readonly (readonly [number, number])[],
  at: number,
): number {
  const first = table[0] as readonly [number, number]
  const last = table[table.length - 1] as readonly [number, number]
  if (at <= first[0]) return first[1]
  if (at >= last[0]) return last[1]
  for (let i = 1; i < table.length; i += 1) {
    const [x1, y1] = table[i] as readonly [number, number]
    if (at <= x1) {
      const [x0, y0] = table[i - 1] as readonly [number, number]
      const t = (at - x0) / (x1 - x0)
      return y0 + t * (y1 - y0)
    }
  }
  return last[1]
}

/** Effective temperature from a classification alone, or null if it has none. */
export function temperatureFromSpectralType(type: SpectralType): Kelvin | null {
  if (type.spectralClass === null) return null
  const rung = ladderIndex(type)
  if (rung === null) return OFF_LADDER_TEMPERATURES[type.spectralClass] ?? null
  const ladder =
    type.luminosity === 'I' || type.luminosity === 'II'
      ? SUPERGIANT_TEMPERATURES
      : type.luminosity === 'III'
        ? GIANT_TEMPERATURES
        : DWARF_TEMPERATURES
  return interpolate(ladder, rung)
}

/**
 * The temperature the rest of the pipeline uses, from everything the catalog
 * knows about one star.
 *
 * The classification leads and B−V is the fallback, for the reason recorded
 * above the ladders — with one exception, measured rather than assumed: for
 * giants the color index is the better of the two, because the ladder has one
 * rung per five subclasses across a range where a giant's temperature moves
 * fast, and B−V does not care about the coarseness of the grid it is not on.
 * Blending the two geometrically was tried: it gives the best luminosity of any
 * policy and the second-worst temperature, and temperature is what the color
 * of every star in the sky comes from.
 */
export function effectiveTemperature(
  type: SpectralType,
  colourIndex: number | null,
): Kelvin | null {
  const fromColour =
    colourIndex === null ? null : temperatureFromColourIndex(colourIndex)
  const fromClass = temperatureFromSpectralType(type)
  if (isGiant(type) && fromColour !== null) return fromColour
  return fromClass ?? fromColour
}

/*
 * Bolometric corrections, Pecaut & Mamajek (2013), "Intrinsic Colors,
 * Temperatures and Bolometric Corrections of Pre-main-sequence Stars",
 * ApJS 208, 9 — the BC_V column of the dwarf sequence, keyed by temperature.
 *
 * The correction is what V-band misses: the infrared of a cool star and the
 * ultraviolet of a hot one. It is near zero around F5 and runs to −4 at both
 * ends, so a luminosity computed without it is not slightly wrong, it is wrong
 * by a factor of forty for an M8.
 *
 * The first implementation used the Flower (1996) polynomial with Torres'
 * (2010) corrected coefficients, which is the usual reference and is fine above
 * ~4,000 K. Below that it is extrapolating past its calibrators: it returned
 * −3.11 for Barnard's Star where the published luminosity implies −2.36, and
 * that 0.75 mag put the star at **twice** its real luminosity. M dwarfs are
 * three quarters of the solar neighborhood, so the polynomial was wrong about
 * most of the sky. This table is measured out to 2,400 K instead.
 *
 * M5 and later are set from the V−Ks colors and K-band corrections rather than
 * the published BC_V column, which is shallower there than the colors imply and
 * left Proxima Centauri at 40% of its cataloged luminosity. Late M is where the
 * scatter is genuinely large — two cataloged M4 dwarfs six light-years apart
 * imply corrections 0.3 mag apart — so this end is fitted to the trend and not
 * to any one star. `photometry.test.ts` states the residual.
 */
const DWARF_BOLOMETRIC_CORRECTIONS: readonly (readonly [Kelvin, number])[] = [
  [2_400, -5.0], // M9V
  [2_500, -4.6], // M8V
  [2_650, -4.2], // M7V
  [2_850, -3.7], // M6V
  [3_030, -3.0], // M5V
  [3_200, -2.34], // M4V
  [3_410, -1.95], // M3V
  [3_550, -1.66], // M2V
  [3_700, -1.4], // M1V
  [3_870, -1.17], // M0V
  [4_070, -0.93], // K7V
  [4_440, -0.66], // K5V
  [5_270, -0.2], // K0V
  [5_660, -0.1], // G5V
  [5_770, -0.08], // G2V — the Sun
  [5_930, -0.06], // G0V
  [6_510, -0.02], // F5V
  [7_220, -0.01], // F0V
  [8_080, -0.1], // A5V
  [9_700, -0.21], // A0V
  [15_700, -1.24], // B5V
  [31_400, -3.16], // B0V
  [41_500, -4.05], // O5V
]

/**
 * At a given temperature a giant's correction is smaller than a dwarf's, because
 * its lower surface gravity weakens the molecular bands that swallow the V band
 * in the first place. Applying the dwarf value to Arcturus overstates its
 * luminosity by about a third.
 */
const GIANT_BC_OFFSET = 0.23

/** Bolometric correction to a V-band absolute magnitude. */
export function bolometricCorrection(
  temperature: Kelvin,
  evolved = false,
): number {
  const bc = interpolate(DWARF_BOLOMETRIC_CORRECTIONS, temperature)
  return evolved ? bc + GIANT_BC_OFFSET : bc
}

/**
 * Bolometric luminosity in solar units, from a V-band absolute magnitude.
 *
 * The temperature is needed because the bolometric correction depends on it —
 * which is why this cannot be the one-liner HYG's `lum` column implies.
 */
export function luminosityFromAbsoluteMagnitude(
  absoluteMagnitudeV: number,
  temperature: Kelvin,
  evolved = false,
): number {
  const bolometric =
    absoluteMagnitudeV + bolometricCorrection(temperature, evolved)
  return 10 ** ((SOLAR_BOLOMETRIC_MAGNITUDE - bolometric) / 2.5)
}

/** Stefan-Boltzmann, in solar units: R/R☉ = √(L/L☉) · (T☉/T)². */
export const radiusFromLuminosity = (
  solarLuminosities: number,
  temperature: Kelvin,
): number =>
  Math.sqrt(solarLuminosities) * (SOLAR_TEMPERATURE / temperature) ** 2

/**
 * Main-sequence mass from luminosity, the standard piecewise mass-luminosity
 * relation inverted.
 *
 * Only valid on the main sequence, which is why `estimateMass` gates it on the
 * luminosity class. Applied to a red giant it reads the star's inflated
 * envelope as mass and returns several times the truth; applied to a white dwarf
 * it returns roughly a Jupiter.
 */
export function mainSequenceMass(solarLuminosities: number): number {
  const l = Math.max(1e-6, solarLuminosities)
  if (l < 0.033) return (l / 0.23) ** (1 / 2.3) // below ~0.43 M☉
  if (l < 16) return l ** (1 / 4) // 0.43–2 M☉
  return (l / 1.4) ** (1 / 3.5) // above ~2 M☉
}

/** Class-typical masses for stars the mass-luminosity relation does not describe. */
const EVOLVED_MASSES: Readonly<Record<string, number>> = {
  I: 12, // supergiant
  II: 6, // bright giant
  III: 1.8, // giant — the red clump, where most of them are
  VII: 0.6, // white dwarf; the Chandrasekhar-peak value
}

export interface MassEstimate {
  readonly solarMasses: number
  /**
   * `derived` means it follows from the measurements; `typical` means the
   * measurements do not determine it and this is a class-representative value.
   * The distinction is shown in the system panel rather than hidden, because a
   * red giant's mass genuinely is not knowable from its light alone.
   */
  readonly basis: 'derived' | 'typical'
}

export function estimateMass(
  type: SpectralType,
  solarLuminosities: number,
): MassEstimate {
  if (isWhiteDwarf(type))
    return { solarMasses: EVOLVED_MASSES['VII'] as number, basis: 'typical' }
  if (isGiant(type)) {
    const typical = EVOLVED_MASSES[type.luminosity as string]
    if (typical !== undefined) return { solarMasses: typical, basis: 'typical' }
  }
  return {
    solarMasses: Math.min(
      80,
      Math.max(0.05, mainSequenceMass(solarLuminosities)),
    ),
    basis: 'derived',
  }
}

/* ------------------------------------------------------------------------- */
/* Blackbody color                                                           */
/* ------------------------------------------------------------------------- */

export interface LinearRgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/**
 * Chromaticity on the Planckian locus (Kim et al. 2002), valid 1,667–25,000 K.
 *
 * Two cubics in 1/T rather than one, because a single fit across that range is
 * visibly wrong in the middle — which is where nearly every star is.
 */
function planckianChromaticity(temperature: Kelvin): { x: number; y: number } {
  const t = Math.min(25_000, Math.max(1_667, temperature))
  const x =
    t <= 4_000
      ? -0.266_123_9e9 / t ** 3 -
        0.234_358_9e6 / t ** 2 +
        0.877_695_6e3 / t +
        0.179_910
      : -3.025_846_9e9 / t ** 3 +
        2.107_037_9e6 / t ** 2 +
        0.222_634_7e3 / t +
        0.240_390

  const y =
    t <= 2_222
      ? -1.106_381_4 * x ** 3 -
        1.348_110_20 * x ** 2 +
        2.185_558_32 * x -
        0.202_196_83
      : t <= 4_000
        ? -0.954_947_6 * x ** 3 -
          1.374_185_93 * x ** 2 +
          2.091_370_15 * x -
          0.167_488_67
        : 3.081_758_0 * x ** 3 -
          5.873_386_70 * x ** 2 +
          3.751_129_97 * x -
          0.370_014_83
  return { x, y }
}

/**
 * Linear sRGB for a blackbody at `temperature`, normalized so the brightest
 * channel is 1.
 *
 * Normalized rather than absolute because brightness is the renderer's business
 * — it comes from luminosity and distance, and multiplying it into the color
 * here would make a distant O star and a nearby M star indistinguishable after
 * exposure. Values can leave [0,1] before normalization: the Planckian locus
 * runs outside the sRGB gamut at both ends, and clamping is a gamut mapping the
 * tone mapper should own, not this function.
 */
export function blackbodyColour(temperature: Kelvin): LinearRgb {
  const { x: bigX, y: bigY, z: bigZ } = blackbodyXyz(temperature)

  // CIE XYZ (D65) → linear sRGB; negative channels retain out-of-gamut light.
  const r = 3.240_479 * bigX - 1.537_150 * bigY - 0.498_535 * bigZ
  const g = -0.969_256 * bigX + 1.875_992 * bigY + 0.041_556 * bigZ
  const b = 0.055_648 * bigX - 0.204_043 * bigY + 1.057_311 * bigZ
  const peak = Math.max(r, g, b, 1e-6)
  return { r: r / peak, g: g / peak, b: b / peak }
}

/** The temperature's tristimulus colour, independent of a display's primaries. */
export function blackbodyXyz(temperature: Kelvin): {
  readonly x: number
  readonly y: number
  readonly z: number
} {
  const { x, y } = planckianChromaticity(temperature)
  const bigY = 1
  const bigX = (x / y) * bigY
  const bigZ = ((1 - x - y) / y) * bigY

  return { x: bigX, y: bigY, z: bigZ }
}
