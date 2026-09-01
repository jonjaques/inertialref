import type { Brand } from './brand.ts'

/*
 * Canonical units are SI, always, everywhere inside the simulation:
 * meters, seconds, kilograms, radians, and their derivatives.
 *
 * The aliases below are documentation, not enforcement. Branding every scalar
 * means casting at every arithmetic operation, which buys noise rather than
 * safety. What *does* get branded is the small set of quantities that are
 * genuinely mixed up in this codebase: presentation units (a parsec figure
 * reaching a function that wants meters is a real bug we would otherwise ship)
 * and integer tick counts (which are not seconds and must never be added to
 * one). Everything else is a plain number whose unit is stated in its type
 * alias and in the API name.
 */

/** SI base and derived units. Plain numbers — the alias states the unit. */
export type Meters = number
export type Seconds = number
export type Kilograms = number
export type MetersPerSecond = number
export type MetersPerSecondSquared = number
export type Radians = number
export type RadiansPerSecond = number
export type Kelvin = number
/** Standard gravitational parameter, m³/s². */
export type Mu = number

/** Integer simulation tick index. Branded: a tick is not a second. */
export type Tick = Brand<number, 'tick'>

export function tick(n: number): Tick {
  return n as Tick
}

/* Presentation units. Branded, because these only ever exist to be shown to a
   human and must not leak back into simulation math. */
export type AstronomicalUnits = Brand<number, 'au'>
export type LightYears = Brand<number, 'ly'>
export type Parsecs = Brand<number, 'pc'>
export type Kilometers = Brand<number, 'km'>
export type Feet = Brand<number, 'ft'>
export type Inches = Brand<number, 'in'>
export type Degrees = Brand<number, 'deg'>

/* ------------------------------------------------------------------------- */
/* Constants                                                                  */
/* ------------------------------------------------------------------------- */

/** Astronomical unit (exact, IAU 2012 definition). */
export const AU: Meters = 1.495978707e11
/** Julian light-year (exact: c × 365.25 days). */
export const LIGHT_YEAR: Meters = 9.4607304725808e15
/** Parsec: 648000/π AU. Written to the digits a double actually holds. */
export const PARSEC: Meters = 3.085677581491367e16
export const KILOMETER: Meters = 1e3
/** International foot / inch (exact). */
export const FOOT: Meters = 0.3048
export const INCH: Meters = 0.0254

export const SECONDS_PER_DAY: Seconds = 86_400
/** Julian year, the astronomical convention. */
export const SECONDS_PER_YEAR: Seconds = 31_557_600

/** Newtonian constant of gravitation, CODATA 2018. */
export const GRAVITATIONAL_CONSTANT = 6.674_3e-11
/** IAU nominal solar values. */
export const SOLAR_MASS: Kilograms = 1.988_47e30
export const SOLAR_RADIUS: Meters = 6.957e8
export const SOLAR_LUMINOSITY = 3.828e26
/** Sun's standard gravitational parameter — known far more precisely than G·M☉. */
export const SUN_MU: Mu = 1.327_124_400_18e20
export const EARTH_MASS: Kilograms = 5.972_2e24
export const EARTH_RADIUS: Meters = 6.371e6
export const JUPITER_MASS: Kilograms = 1.898e27
export const JUPITER_RADIUS: Meters = 6.9911e7
export const SPEED_OF_LIGHT: MetersPerSecond = 299_792_458

/**
 * Stefan–Boltzmann, W m⁻² K⁻⁴. Exact since the 2019 SI redefinition.
 *
 * The bridge between a star's luminosity and a temperature at a distance, which
 * is what sets a frost line, a sublimation radius and an equilibrium
 * temperature — three different places in the generator that were each about to
 * write it down separately.
 */
export const STEFAN_BOLTZMANN = 5.670_374_419e-8

/* ------------------------------------------------------------------------- */
/* Conversions — presentation layer only                                      */
/* ------------------------------------------------------------------------- */

export const metersToAu = (m: Meters): AstronomicalUnits =>
  (m / AU) as AstronomicalUnits
export const auToMeters = (au: AstronomicalUnits): Meters => au * AU
export const metersToLightYears = (m: Meters): LightYears =>
  (m / LIGHT_YEAR) as LightYears
export const lightYearsToMeters = (ly: LightYears): Meters => ly * LIGHT_YEAR
export const metersToParsecs = (m: Meters): Parsecs => (m / PARSEC) as Parsecs
export const parsecsToMeters = (pc: Parsecs): Meters => pc * PARSEC
export const metersToKilometers = (m: Meters): Kilometers =>
  (m / KILOMETER) as Kilometers
export const metersToFeet = (m: Meters): Feet => (m / FOOT) as Feet
export const metersToInches = (m: Meters): Inches => (m / INCH) as Inches
export const radiansToDegrees = (r: Radians): Degrees =>
  ((r * 180) / Math.PI) as Degrees
export const degreesToRadians = (d: Degrees): Radians => (d * Math.PI) / 180

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
 *
 * Grouped by hand rather than through `toLocaleString`, for the reason
 * `dossier.ts` states: the browser's locale would choose the decimal separator,
 * so the same body would render "6.371,0 km" on one machine and "6,371.0 km" on
 * another. Every readout in this interface is an instrument reading, and
 * instruments do not translate.
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

/** Thousands separators, on the integer part only. */
function group(fixed: string): string {
  const sign = fixed.startsWith('-') ? '−' : ''
  const [digits = '', fraction] = (sign === '' ? fixed : fixed.slice(1)).split(
    '.',
  )
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === undefined
    ? `${sign}${grouped}`
    : `${sign}${grouped}.${fraction}`
}

/*
 * What the simulation clock's zero actually is.
 *
 * Every orbit in the build is solved from elements published for **J2000.0**
 * with `epoch: 0` — see `universe/src/solar/bodies.ts` — so simulation time is
 * seconds after that instant, and has been since the first Kepler solve. The
 * clock has simply never been able to *say* so: `world.clock.time` is a
 * duration, and a readout of "15.23 s" is a stopwatch reading in a game whose
 * subject is where the planets are.
 *
 * J2000.0 is 2000-01-01 12:00:00 **TT**, which was 11:58:55.816 UTC. This uses
 * noon UTC and does not pretend otherwise: nothing in this simulation models
 * the TT−UTC offset, and carrying 64 seconds of precision through a clock that
 * has none is a more expensive lie than being a minute out. Anything that ever
 * needs the real offset needs a leap-second table first.
 */
export const SIMULATION_EPOCH_UTC_MS = Date.UTC(2000, 0, 1, 12, 0, 0)

/**
 * The instant a simulation time names, as milliseconds since the Unix epoch.
 *
 * Milliseconds rather than a `Date`, because that is the currency every
 * formatter and every date picker already speaks, and because a `Date` handed
 * across a module boundary is a mutable object nobody owns.
 */
export const instantMillis = (s: Seconds): number =>
  SIMULATION_EPOCH_UTC_MS + s * 1000

/** Human-readable duration for HUD/debug output. Input is simulation seconds. */
export function formatDuration(s: Seconds): string {
  const a = Math.abs(s)
  if (a >= SECONDS_PER_YEAR) return `${(s / SECONDS_PER_YEAR).toFixed(2)} yr`
  if (a >= SECONDS_PER_DAY) return `${(s / SECONDS_PER_DAY).toFixed(2)} d`
  if (a >= 3600) return `${(s / 3600).toFixed(2)} h`
  if (a >= 60) return `${(s / 60).toFixed(2)} min`
  return `${s.toFixed(2)} s`
}
