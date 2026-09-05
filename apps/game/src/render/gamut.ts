import {
  ColorManagement,
  LinearTransfer,
  Matrix3,
  SRGBTransfer,
  type WebGPURenderer,
} from 'three/webgpu'

export const DISPLAY_P3 = 'display-p3'
export const LINEAR_P3 = 'display-p3-linear'

// The definitions shipped in three's ColorSpaces addon, imported through the
// WebGPU graph so the addon cannot pull a second renderer into this bundle.
const primaries: [number, number, number, number, number, number] = [
  0.68, 0.32, 0.265, 0.69, 0.15, 0.06,
]
const common = {
  primaries,
  whitePoint: [0.3127, 0.329] as [number, number],
  toXYZ: new Matrix3().set(
    0.4865709,
    0.2656677,
    0.1982173,
    0.2289746,
    0.6917385,
    0.0792869,
    0,
    0.0451134,
    1.0439444,
  ),
  fromXYZ: new Matrix3().set(
    2.4934969,
    -0.9313836,
    -0.4027108,
    -0.829489,
    1.7626641,
    0.0236247,
    0.0358458,
    -0.0761724,
    0.9568845,
  ),
  luminanceCoefficients: [0.2289, 0.6917, 0.0793] as [number, number, number],
}
ColorManagement.define({
  [DISPLAY_P3]: {
    ...common,
    transfer: SRGBTransfer,
    outputColorSpaceConfig: { drawingBufferColorSpace: DISPLAY_P3 },
  },
  [LINEAR_P3]: {
    ...common,
    transfer: LinearTransfer,
    outputColorSpaceConfig: { drawingBufferColorSpace: DISPLAY_P3 },
    workingColorSpaceConfig: { unpackColorSpace: DISPLAY_P3 },
  },
})

/** A declared canvas and its encoder must use the same primaries. */
export function configureGamut(
  renderer: WebGPURenderer,
  extended: boolean,
): boolean {
  if (
    !extended ||
    !('isWebGPUBackend' in renderer.backend) ||
    !matchMedia('(color-gamut: p3)').matches
  )
    return false
  const context = (
    renderer.backend as unknown as { getContext(): GPUCanvasContext }
  ).getContext()
  if (typeof context.getConfiguration !== 'function') return false
  const original = context.getConfiguration()
  if (original === null) return false
  try {
    context.configure({ ...original, colorSpace: DISPLAY_P3 })
    if (context.getConfiguration()?.colorSpace !== DISPLAY_P3) {
      context.configure(original)
      return false
    }
    return true
  } catch {
    context.configure(original)
    return false
  }
}
