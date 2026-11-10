import type { AtmosphereRecipe, ScatteringLut } from './atmosphere.ts'

/*
 * The sky's light on a cloud, as a table a body's air bakes beside its
 * transmittance and its multiple scattering: for a sun's cosine and a
 * height, the sky's mean radiance and the difference between the irradiance
 * of its two sides, up against down and sunward against away.
 *
 * Three blocks of 34 columns over the sun's cosine, a guard column each side
 * of a block's 32 so a bilinear read never blends two blocks, and 16 rows
 * over height from the datum to the air's top:
 *
 *   block 0  ln L̄        the sky's mean radiance per band
 *   block 1  Δ           the upper side's irradiance less the lower's, over π·L̄
 *   block 2  Δ_s         the sunward side's less the far side's, over π·L̄
 *
 * **The bake holds the layout and no sky.** Every texel is zero: a mean
 * radiance whose logarithm is zero under a reader that draws no sky light,
 * and no difference between any two sides.
 */

/** Columns a block holds, and the guard column each side of it. */
export const SKY_BLOCK_COLUMNS = 32
export const SKY_BLOCK_GUARD = 1
export const SKY_BLOCKS = 3
export const SKY_TABLE_WIDTH =
  SKY_BLOCKS * (SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD)
export const SKY_TABLE_HEIGHT = 16

/**
 * The ground the sky is lit over: a Lambert albedo, one for every body. The
 * air's bake carries a haze, a ratio and heights and no albedo.
 */
export const SKY_GROUND_ALBEDO = 0.15

/** The sky's moments for an air, from its own two tables: RGBA32F, sized for upload. */
export function bakeSkyMoments(
  _recipe: AtmosphereRecipe,
  _transmittance: ScatteringLut,
  _multiScatter: ScatteringLut,
): ScatteringLut {
  return {
    width: SKY_TABLE_WIDTH,
    height: SKY_TABLE_HEIGHT,
    data: new Float32Array(SKY_TABLE_WIDTH * SKY_TABLE_HEIGHT * 4),
  }
}
