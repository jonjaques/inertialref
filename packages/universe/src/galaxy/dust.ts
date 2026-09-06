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
  maxScale: 8,
})

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

/** Positive log-density texture; the seed is already owned by the dust label. */
export function galaxyDustModulation(
  seed: Seed,
  x: number,
  y: number,
  z: number,
): number {
  let logarithm = 0
  for (const octave of GALAXY_DUST.octaves)
    logarithm +=
      octave.logAmplitude *
      noise3(
        seed,
        x / octave.scaleParsecs,
        y / octave.scaleParsecs,
        z / octave.scaleParsecs,
      )
  return Math.exp(logarithm)
}
