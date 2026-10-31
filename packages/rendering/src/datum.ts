/*
 * The datum sphere.
 *
 * A body's radius is its datum — mean sea level, for a planet that has a sea.
 * Terrain dips below that datum as often as it rises above it, so a sphere
 * drawn at exactly the datum radius hides every valley on the planet, which
 * with only a few patches streamed means hiding most of the terrain. The
 * renderer therefore draws the sphere a full relief *below* the datum, and
 * every ratio measured against the drawn body — the atmosphere shell, the ring
 * spans — is measured against that sunk radius rather than the true one.
 *
 * This file exists because that arithmetic used to be written twice: once in
 * `buildScene`, and once in the boot preloader's plan, which recomputed it to
 * predict the cache keys the scene would ask for. The two agreed only through
 * a three-hop identity nothing asserted, and the guard was a test that built a
 * whole engine to compare two six-line formulas. A drift of one rounding step
 * is silent: the prebake still runs, every key misses, and the 50 ms bake it
 * exists to remove happens on first sight anyway.
 *
 * One definition, and it lives in `packages/rendering` because that is already
 * the Three-free, Node-testable home for render arithmetic.
 */

/**
 * The clamp on how far the sphere may sink.
 *
 * Relief is a fraction of a percent of the radius on every real body, so this
 * bites only on generated ones with implausible terrain — where an unclamped
 * sink would put the drawn surface inside the body, or at a negative radius.
 * It is the reason `sunkSphereRadius` is a function rather than a subtraction.
 */
const MAX_SINK = 0.1

/**
 * The radius the renderer actually draws a body at.
 *
 * `relief` is peak-to-datum, in the same units as `radius`. A negative or
 * absent relief cannot raise the sphere above the datum — sinking is the whole
 * point, and a sphere drawn *above* the datum would hide the peaks instead of
 * the valleys.
 */
export function sunkSphereRadius(radius: number, relief: number): number {
  return Math.max(radius * (1 - MAX_SINK), radius - Math.max(0, relief))
}

/**
 * How far out to draw the atmosphere shell, as a multiple of the drawn sphere.
 *
 * `hazeHeight` comes from the *haze*, not from `atmosphereCeiling`. That
 * ceiling is where the drag model stops integrating, which for a gas giant is
 * a thousand kilometers of "there is no surface" — drawn as a shell it put a
 * halo on Saturn 3% of its own radius wide.
 */
export function atmosphereShellRatio(
  radius: number,
  relief: number,
  hazeHeight: number,
): number {
  return (radius + hazeHeight) / sunkSphereRadius(radius, relief)
}

/** The air's two scale heights, in radii of the datum: sea level. */
export interface AirHeights {
  /** The gas's: Rayleigh scattering. */
  readonly rayleigh: number
  /** The aerosol's: the haze that whitens the air and rings the sun. */
  readonly aerosol: number
}

/**
 * Where the scattering tables put the gas and the aerosol, as multiples of
 * the datum — the unit they are baked in, with sea level at 1.
 *
 * The datum and not the drawn sphere, which is sunk under it: the air is
 * measured from sea level however deep the renderer draws the sphere under
 * the terrain. Baked over the sunk sphere, an observer on a beach stood
 * 10 km up in the air — half of it over their head, a slate-gray zenith,
 * and a setting sun that never reddened. The shell stops a ray at the drawn
 * sphere and measures its air from the datum, and both radii scale together
 * under distance compression, so each ratio survives the tier moving.
 *
 * `scaleHeight` is the atmosphere's own and `aerosolHeight` the haze's, both
 * in meters. A haze with no atmosphere record under it — none in Sol or the
 * generator has one — takes 0.22 of its shell as the gas's height, which
 * leaves e^−4.5 of the density at the ceiling, and mixes its aerosol with it.
 */
export function airHeights(
  radius: number,
  hazeHeight: number,
  scaleHeight: number,
  aerosolHeight: number,
): AirHeights {
  const gas = scaleHeight > 0 ? scaleHeight : hazeHeight * 0.22
  return {
    rayleigh: gas / radius,
    aerosol: (aerosolHeight > 0 ? aerosolHeight : gas) / radius,
  }
}

/**
 * The top of the air as a multiple of the datum: the ceiling the tables are
 * baked to, in the unit `airHeights` is in. The shell mesh is drawn to
 * `atmosphereShellRatio` of the sunk sphere, the same height over the body.
 */
export function airTopRatio(radius: number, hazeHeight: number): number {
  return (radius + hazeHeight) / radius
}

/** Ring radii as they are authored: meters from the body's center. */
export interface RingSpan {
  readonly innerRadius: number
  readonly outerRadius: number
}

/**
 * Ring radii as the renderer needs them: multiples of the drawn sphere.
 *
 * Converted here rather than in the renderer because the drawn sphere is not
 * the body's radius, and this is the one place that knows by how much.
 */
export function ringScales(
  radius: number,
  relief: number,
  ring: RingSpan,
): { readonly inner: number; readonly outer: number } {
  const sphere = sunkSphereRadius(radius, relief)
  return { inner: ring.innerRadius / sphere, outer: ring.outerRadius / sphere }
}
