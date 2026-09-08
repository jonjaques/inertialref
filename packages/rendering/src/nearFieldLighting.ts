import type { CameraPolicy } from './exposure.ts'

const PHOTOGRAPHIC = { ambient: 0, fill: 0 } as const
// Ambient has no direction, so 0.16 stays confined to the hull and props.
// A 0.35 camera fill against a key of 4 reveals faces the star does not reach;
// CameraRig's off-axis aim suppresses it on already lit faces.
const ENHANCED = { ambient: 0.16, fill: 0.35 } as const
// Across tng-intro frames 2100–2360, a fill of 1.6 gives mean-luminance
// error 8.0 against the reference. Fills of 2.6 and 4.2 give 21.0 and 22.3.
// The skim fills the frame, so a small excess there outweighs darker wipe entries.
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
