import {
  AU,
  LIGHT_YEAR,
  type Meters,
  metersToAu,
  metersToInches,
  metersToKilometers,
  metersToLightYears,
  PARSEC,
  radiansToDegrees,
  type Seconds,
  SECONDS_PER_DAY,
  SECONDS_PER_YEAR,
} from './units.ts'

/*
 * A number the way an instrument prints it.
 *
 * Written out rather than handed to `Intl`. `toLocaleString` would group the
 * digits and would also decide the decimal separator from whatever locale the
 * browser is in — so the same body would render "6.371,0 km" on one machine
 * and "6,371.0 km" on another, and a test asserting either would pass exactly
 * where it was written. Every readout in this interface is an instrument
 * reading; instruments do not translate.
 */

/**
 * Pick the unit a human would use at this magnitude and format it.
 *
 * Deliberately spans the whole range the game does — an inch-scale readout and
 * a kiloparsec readout come out of the same call, because the HUD shows one
 * distance field whether you are docking or crossing the galaxy.
 */
export function formatDistance(m: Meters, digits = 3): string {
  const a = Math.abs(m)
  if (!Number.isFinite(m)) return `${m}`
  // Light-years rather than parsecs below a kiloparsec: astronomers prefer pc,
  // but the HUD is read by pilots, and every catalog name the player sees
  // ("4.24 ly to Proxima") is quoted in light-years.
  if (a >= 1e3 * PARSEC) return `${(m / (1e3 * PARSEC)).toFixed(digits)} kpc`
  if (a >= 0.05 * LIGHT_YEAR)
    return `${metersToLightYears(m).toFixed(digits)} ly`
  if (a >= 0.001 * AU) return `${metersToAu(m).toFixed(digits)} AU`
  if (a >= 1e5) return `${metersToKilometers(m).toFixed(digits)} km`
  if (a >= 1) return `${m.toFixed(digits)} m`
  if (a >= 0.01) return `${metersToInches(m).toFixed(digits)} in`
  return `${(m * 1e3).toFixed(digits)} mm`
}

/**
 * The same distance, written the way a panel is read rather than logged.
 *
 * `formatDistance` carries three decimals at every magnitude, which is right
 * for a log line and wrong on screen: a camera 20,780 km out reads
 * "20779.659 km", where the last four digits move every frame and none of them
 * is a fact anyone is using. The rule is decimals by magnitude within the unit
 * band — none at 100 and above, one above 10, two below — so what prints is
 * never finer than about a thousandth of the reading itself, which is the
 * resolution at which a digit stops moving every frame. It is not a
 * significant-figure rule and does not read as one at the top of a band:
 * `123,456,789 m` is `123,457 km`, six figures, because the band runs to
 * an AU and cutting it to three would round a camera position to the nearest
 * thousand kilometers.
 *
 * The thousands separator is what makes five digits scannable at a glance —
 * the difference between "20780" and "20,780" is the difference between
 * counting and reading.
 */
export function formatReading(m: Meters): string {
  if (!Number.isFinite(m)) return '—'
  const [value, unit] = scaled(m)
  const a = Math.abs(value)
  return `${group(value.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2))} ${unit}`
}

/** The same unit ladder `formatDistance` walks, without the formatting. */
function scaled(m: Meters): readonly [number, string] {
  const a = Math.abs(m)
  if (a >= 1e3 * PARSEC) return [m / (1e3 * PARSEC), 'kpc']
  if (a >= 0.05 * LIGHT_YEAR) return [metersToLightYears(m), 'ly']
  if (a >= 0.001 * AU) return [metersToAu(m), 'AU']
  if (a >= 1e5) return [metersToKilometers(m), 'km']
  if (a >= 1) return [m, 'm']
  if (a >= 0.01) return [metersToInches(m), 'in']
  return [m * 1e3, 'mm']
}

/**
 * Human-readable duration for HUD and debug output. Input is simulation
 * seconds.
 *
 * One of two ladders over seconds, and the one a clock or a countdown is read
 * in: it breaks at one of each unit with two decimals, so Mars's year is
 * `1.88 yr`. `period` is the other.
 */
export function formatDuration(s: Seconds): string {
  const a = Math.abs(s)
  if (a >= SECONDS_PER_YEAR) return `${(s / SECONDS_PER_YEAR).toFixed(2)} yr`
  if (a >= SECONDS_PER_DAY) return `${(s / SECONDS_PER_DAY).toFixed(2)} d`
  if (a >= 3600) return `${(s / 3600).toFixed(2)} h`
  if (a >= 60) return `${(s / 60).toFixed(2)} min`
  return `${s.toFixed(2)} s`
}

/**
 * Thousands separators on the integer part of a `toFixed` string, and U+2212
 * for its sign.
 *
 * U+2212, not the hyphen `toFixed` produces. In a tabular column a hyphen is
 * two thirds the width of a digit and sits above the numerals' midline, so a
 * negative reading is visibly narrower than the positive one under it, and two
 * glyphs for one sign in one panel.
 */
export function group(fixed: string): string {
  const sign = fixed.startsWith('-') ? '−' : ''
  const [digits = '', fraction] = (sign === '' ? fixed : fixed.slice(1)).split(
    '.',
  )
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === undefined
    ? `${sign}${grouped}`
    : `${sign}${grouped}.${fraction}`
}

/** A fixed number of decimals, grouped. */
export function round(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—'
  return group(value.toFixed(digits))
}

/**
 * Three significant figures, which is what a reading of this kind is worth.
 *
 * A non-finite value is the em dash every other formatter here gives it, and
 * never `'0'`: a zero radius or a zero period sends a surface gravity, an
 * escape velocity and a flux to infinity, and printing those as `0 m/s²` is a
 * confident measurement of the opposite of the truth. `0` stays the answer for
 * an actual zero.
 */
export function significant(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e5 || magnitude < 1e-3) return exponential(value)
  const digits = Math.max(0, 3 - Math.ceil(Math.log10(magnitude)))
  return group(value.toFixed(digits))
}

/** Scientific notation as it is typeset — `1.989×10³⁰`, never `1.989e+30`. */
export function exponential(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const [mantissa = '', power = ''] = value.toExponential(3).split('e')
  const sign = power.startsWith('-') ? '−' : ''
  return `${mantissa}×10${superscript(sign + power.replace(/^[+-]/, ''))}`
}

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '−': '⁻',
}

/** Digits and U+2212 raised; any other character passes through. */
export const superscript = (text: string): string =>
  [...text].map((char) => SUPERSCRIPTS[char] ?? char).join('')

/** A distance in km; in million km past ten million, in m under one. */
export function kilometers(meters: Meters): string {
  const km = meters / 1000
  if (!Number.isFinite(km)) return '—'
  if (Math.abs(km) >= 1e7) return `${round(km / 1e6, 3)} million km`
  if (Math.abs(km) >= 100) return `${round(km, 0)} km`
  if (Math.abs(km) >= 1) return `${round(km, 2)} km`
  return `${round(meters, 0)} m`
}

/**
 * A period the way an almanac prints it.
 *
 * The second ladder over seconds, beside `formatDuration`, and the two break
 * at different rungs on purpose. This one steps up at two years, two days, two
 * hours and two minutes, with decimals by band, so Mars's year is `686.98 d` —
 * the figure every table quotes — where `formatDuration` prints `1.88 yr`.
 */
export function period(seconds: Seconds): string {
  const s = Math.abs(seconds)
  if (!Number.isFinite(s)) return '—'
  if (s >= 2 * SECONDS_PER_YEAR) return `${round(s / SECONDS_PER_YEAR, 2)} yr`
  if (s >= 2 * SECONDS_PER_DAY) return `${round(s / SECONDS_PER_DAY, 2)} d`
  if (s >= 7200) return `${round(s / 3600, 2)} h`
  if (s >= 120) return `${round(s / 60, 1)} min`
  return `${round(s, 1)} s`
}

/** A pressure in bar, kPa or Pa, three significant figures. */
export function pressurized(pascals: number): string {
  if (pascals >= 1e5) return `${significant(pascals / 1e5)} bar`
  if (pascals >= 100) return `${significant(pascals / 1000)} kPa`
  return `${significant(pascals)} Pa`
}

/**
 * Degrees, arcminutes or arcseconds — whichever the angle is actually read in.
 *
 * The break is at a twentieth of a degree rather than at one, because the
 * reference every reader has is the Sun from Earth and that is half a degree.
 * Rendered in arcminutes it comes out "32.0′", which is correct, is what an
 * almanac prints, and is not the number anybody is carrying around.
 */
export function arcs(radians: number): string {
  const deg = radiansToDegrees(radians)
  if (deg >= 0.05) return `${round(deg, 3)}°`
  if (deg >= 1 / 60) return `${round(deg * 60, 2)}′`
  return `${round(deg * 3600, 1)}″`
}

/** Mean density in g/cm³ of a sphere of this mass and radius. */
export function density(mass: number, radius: Meters): string {
  const volume = (4 / 3) * Math.PI * radius * radius * radius
  return `${round(mass / volume / 1000, 3)} g/cm³`
}
