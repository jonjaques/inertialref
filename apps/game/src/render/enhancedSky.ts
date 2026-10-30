import type { Node } from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { airLuminance, enhancedSky, stagedLight } from './radiance.ts'

/**
 * The field retains nW m^-2 sr^-1. Only the composed view spends this gain.
 * A lower gain and a wider shoulder keep dark lanes separated from bright
 * star clouds instead of compressing both into the same luminous veil.
 */
export const ENHANCED_SKY_GAIN = 2 ** 23
export const ENHANCED_SKY_CEILING = 0.5

/**
 * Compress extended emission by luminance, retaining zero and chromaticity.
 *
 * The compression counts the air in front of the field as part of the sky
 * it compresses. Lifting the galaxy alone measured it against nothing, so a
 * noon sky on Earth — about a million times the bulge's brightness — drew
 * the bulge and its dust lanes through the blue near the ceiling, brighter
 * than the air itself. With the air in the denominator the field
 * keeps its share of the total: all of it in a vacuum, a vanishing fraction
 * by day, and it returns through twilight in the order the air dims.
 */
export function composeSky(physical: Node<'vec3'>): Node<'vec3'> {
  const lifted = physical.mul(ENHANCED_SKY_GAIN)
  const y = lifted.dot(vec3(0.2126, 0.7152, 0.0722))
  const veil = airLuminance.mul(ENHANCED_SKY_GAIN)
  // Staged: composed at the calibration, and held there when the exposure
  // opens up for a darkening sky.
  const composed = lifted
    .div(y.add(veil).div(ENHANCED_SKY_CEILING).add(1))
    .mul(stagedLight)
  return enhancedSky.greaterThan(0.5).select(composed, physical)
}
