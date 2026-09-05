import {
  ColorManagement,
  LinearTransfer,
  Matrix3,
  SRGBTransfer,
  SRGBColorSpace,
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

export interface CanvasGamut {
  readonly colorSpace: typeof DISPLAY_P3 | typeof SRGBColorSpace
  /** Reapply the current negotiation after the renderer host configures output. */
  commit(): void
  dispose(): void
}

/** Own the canvas declaration and its encoder for this renderer's lifetime. */
export function createCanvasGamut(
  renderer: WebGPURenderer,
  extended: boolean,
): CanvasGamut {
  let colorSpace: CanvasGamut['colorSpace'] = SRGBColorSpace
  const target = renderer.getCanvasTarget()
  const commit = (): void => {
    renderer.outputColorSpace = colorSpace
  }
  const refresh = (): void => {
    colorSpace = negotiateGamut(renderer, extended)
    commit()
  }
  // three's listener drops the canvas configuration first. Resolving it here
  // opens the new configuration before the encoder chooses its primaries.
  target.addEventListener('resize', refresh)
  refresh()
  return {
    get colorSpace() {
      return colorSpace
    },
    commit,
    dispose: () => target.removeEventListener('resize', refresh),
  }
}

function negotiateGamut(
  renderer: WebGPURenderer,
  extended: boolean,
): CanvasGamut['colorSpace'] {
  if (!('isWebGPUBackend' in renderer.backend)) return SRGBColorSpace
  const context = (
    renderer.backend as unknown as { getContext(): GPUCanvasContext }
  ).getContext()
  if (typeof context.getConfiguration !== 'function') return SRGBColorSpace
  const original = context.getConfiguration()
  if (original === null) return SRGBColorSpace
  const wanted =
    extended && matchMedia('(color-gamut: p3)').matches
      ? DISPLAY_P3
      : SRGBColorSpace
  // `configure` replaces the configuration and destroys the canvas's current
  // texture, so it is not free to call for an answer already on the canvas —
  // which is every resize of a standard-output session, where `wanted` can
  // only ever be the sRGB three just re-declared.
  if (original.colorSpace === wanted) return wanted
  try {
    context.configure({ ...original, colorSpace: wanted })
    if (context.getConfiguration()?.colorSpace === wanted) return wanted
  } catch {
    // The original declaration is still the encoder's only verified choice.
  }
  context.configure(original)
  return original.colorSpace === DISPLAY_P3 ? DISPLAY_P3 : SRGBColorSpace
}
