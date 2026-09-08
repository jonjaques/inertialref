import type { CameraPolicy } from '@inertialref/rendering'

const PHOTOGRAPHIC = { ambient: 0, fill: 0 } as const
const ENHANCED = { ambient: 0.16, fill: 0.35 } as const
const STAGING = { ambient: 0.16, fill: 1.6 } as const

/** Camera-side illumination reaches the hull and props, not planetary shaders. */
export function nearFieldLighting(
  policy: CameraPolicy,
  calibratedLight: boolean,
): { readonly ambient: number; readonly fill: number } {
  return calibratedLight
    ? STAGING
    : policy.processing === 'enhanced'
      ? ENHANCED
      : PHOTOGRAPHIC
}
