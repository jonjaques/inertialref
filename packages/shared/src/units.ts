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

/**
 * An angle written in degrees, where a call site writes one down.
 *
 * `Radians` is a bare `number`, so a degree field that took a number would
 * take a radian too, silently; the brand makes the caller say which it means.
 */
export function deg(n: number): Degrees {
  return n as Degrees
}

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
/** Whole degrees, which is every angle a panel prints or puts on a slider. */
export const wholeDegrees = (r: Radians): Degrees =>
  Math.round(radiansToDegrees(r)) as Degrees
export const degreesToRadians = (d: Degrees): Radians => (d * Math.PI) / 180

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
