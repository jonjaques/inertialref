import { noise3, type Seed } from '@inertialref/procedural'
import { armStrength } from './arms.ts'

/**
 * Heights follow Guo et al. 2025; the radial length follows Drimmel & Spergel
 * 2001. Their combination, layer fractions, arm profile, solar normalization,
 * texture and effective RGB wavelengths are explicit preview assumptions.
 */
export const GALAXY_DUST = Object.freeze({
  thinHeightParsecs: 81,
  thickHeightParsecs: 152,
  thinFraction: 0.65,
  thickFraction: 0.35,
  radialScaleParsecs: 2260,
  armOffsetParsecs: -200,
  armWidthScale: 0.5,
  armContrast: 2,
  solarExtinctionPerParsec: Math.LN10 / 2500,
  // An illustrative λ⁻¹ law at 650, 550 and 450 nm, pending M6 bandpasses.
  extinctionRgb: Object.freeze({ r: 550 / 650, g: 1, b: 550 / 450 }),
  octaves: Object.freeze([
    Object.freeze({ scaleParsecs: 64, logAmplitude: 0.8 }),
    Object.freeze({ scaleParsecs: 16, logAmplitude: 0.4 }),
    Object.freeze({ scaleParsecs: 4, logAmplitude: 0.2 }),
    Object.freeze({ scaleParsecs: 1, logAmplitude: 0.1 }),
  ]),
  /**
   * The variance of `noise3` over its lattice, measured on two seeds over
   * 96³ points at irrational spacing: 0.0729 on both. It is what an
   * unresolved octave leaves behind — see `galaxyDustOctaveMean`.
   */
  noiseVariance: 0.0729,
  maxScale: 8,
})

/**
 * The mean of an octave's factor, exp(a·n), over the lattice.
 *
 * Dropping an octave a pixel cannot resolve is not free: exp is convex, so
 * the mean of exp(a·n) over zero-mean noise sits above one, and a lane
 * rendered without its fine texture would be 2.4% thinner at the 0.8
 * octave and 3.1% over all four. The lognormal form exp(a²σ²/2) matches
 * the mean measured over the lattice to five decimals at every amplitude
 * here, so one measured variance gives every factor.
 */
export const galaxyDustOctaveMean = (logAmplitude: number): number =>
  Math.exp((logAmplitude * logAmplitude * GALAXY_DUST.noiseVariance) / 2)

/**
 * How much of an octave a footprint resolves: all of it within one lattice
 * cell, none of it beyond two, linear between so nothing pops along a ray.
 */
export const galaxyDustOctaveWeight = (
  scaleParsecs: number,
  footprintParsecs: number,
): number => Math.min(1, Math.max(0, 2 - footprintParsecs / scaleParsecs))

/** A common arm sum keeps every overlapping lane continuous. */
export function galaxyDustProfile(
  radius: number,
  beta: number,
  height: number,
  edge: number,
): { density: number; arms: number } {
  const arms = armStrength(radius, beta, {
    radiusOffsetParsecs: GALAXY_DUST.armOffsetParsecs,
    widthScale: GALAXY_DUST.armWidthScale,
  })
  const vertical =
    GALAXY_DUST.thinFraction *
      Math.exp(-height / GALAXY_DUST.thinHeightParsecs) +
    GALAXY_DUST.thickFraction *
      Math.exp(-height / GALAXY_DUST.thickHeightParsecs)
  return {
    density:
      Math.exp((8178 - radius) / GALAXY_DUST.radialScaleParsecs) *
      edge *
      vertical *
      (1 + GALAXY_DUST.armContrast * arms),
    arms,
  }
}

/**
 * Positive log-density texture; the seed is already owned by the dust label.
 *
 * `footprintParsecs` is the width of the pixel asking, at this point, and
 * zero is the exact field. An octave the footprint cannot resolve is
 * replaced by its mean rather than evaluated: the four octaves are 87% of a
 * live volume draw, and from outside the disk a texel spans over a hundred
 * parsecs, so every one of them is sub-pixel there. Blended in log space
 * with the weight squared on the mean term, so that the mean of the blend
 * equals the octave's mean at every weight, not only at the ends.
 */
export function galaxyDustModulation(
  seed: Seed,
  x: number,
  y: number,
  z: number,
  footprintParsecs = 0,
): number {
  let logarithm = 0
  for (const octave of GALAXY_DUST.octaves) {
    const weight =
      footprintParsecs > 0
        ? galaxyDustOctaveWeight(octave.scaleParsecs, footprintParsecs)
        : 1
    if (weight > 0)
      logarithm +=
        weight *
        octave.logAmplitude *
        noise3(
          seed,
          x / octave.scaleParsecs,
          y / octave.scaleParsecs,
          z / octave.scaleParsecs,
        )
    if (weight < 1)
      logarithm +=
        (1 - weight * weight) *
        Math.log(galaxyDustOctaveMean(octave.logAmplitude))
  }
  return Math.exp(logarithm)
}
