import type { Node } from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { enhancedSky } from './radiance.ts'

/** The field retains nW m^-2 sr^-1. Only the composed view spends this gain. */
export const ENHANCED_SKY_GAIN = 2 ** 24
export const ENHANCED_SKY_CEILING = 0.35

/** Compress extended emission by luminance, retaining zero and chromaticity. */
export function composeSky(physical: Node<'vec3'>): Node<'vec3'> {
  const lifted = physical.mul(ENHANCED_SKY_GAIN)
  const y = lifted.dot(vec3(0.2126, 0.7152, 0.0722))
  const composed = lifted.div(y.div(ENHANCED_SKY_CEILING).add(1))
  return enhancedSky.greaterThan(0.5).select(composed, physical)
}
