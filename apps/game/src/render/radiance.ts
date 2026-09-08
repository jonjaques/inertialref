import { SURFACE_LUMINANCE } from '@inertialref/rendering'
import type { NodeMaterial, Renderer } from 'three/webgpu'
import { Fn, output, uniform, vec4 } from 'three/tsl'
import { meterOverlay, motionOverlay } from './sensorMrt.ts'

/** Offscreen reflectance bakes remain reflectance; only the scene collects light. */
const gains = new WeakMap<Renderer, number>()
const integratedGains = new WeakMap<Renderer, number>()
const enhanced = new WeakMap<Renderer, boolean>()
/** Visibility processing happens before the scene's half-float conversion. */
export const enhancedSky = uniform(0).onRenderUpdate(({ renderer }) =>
  renderer !== null && enhanced.get(renderer) === true ? 1 : 0,
)
/**
 * Enhanced's three-percent night-side fill is legibility, not measured light.
 * Ground and water share the resolved processing gate; photographic views and
 * reflectance bakes receive none. Atmospheric scattering remains independent.
 * Earthshine on Luna is about 2.6 × 10⁻⁴ of sunlight; three percent is an
 * authored floor that lets a night limb read against space at daylight exposure.
 * The scene's 0.16 ambient reaches hulls and props through different materials.
 */
export const visibilityAmbient = enhancedSky.mul(0.03)
export const sceneRadianceGain = uniform(1).onRenderUpdate(({ renderer }) =>
  renderer === null ? 1 : (gains.get(renderer) ?? 1),
)

export const integratedSkyGain = uniform(1).onRenderUpdate(({ renderer }) =>
  renderer === null ? 1 : (integratedGains.get(renderer) ?? 1),
)

export function setSceneExposure(
  renderer: Renderer,
  pre: number | null,
  total = pre,
  processing: 'enhanced' | 'photographic' = 'photographic',
): void {
  enhanced.set(renderer, pre !== null && processing === 'enhanced')
  gains.set(renderer, pre === null ? 1 : SURFACE_LUMINANCE * pre)
  integratedGains.set(
    renderer,
    total === null ? 1 : 1 / (SURFACE_LUMINANCE * total),
  )
}

/**
 * One output seam covers unlit shaders and the hull's standard lighting alike.
 *
 * `overlay` marks a draw that is light without a surface — a flare quad, a
 * warp streak — so the sensor's motion attachment keeps the velocity and
 * depth of whatever it covers rather than the quad's own; see `sensorMrt`.
 */
export function sensorRadiance<T extends NodeMaterial>(
  material: T,
  overlay = false,
  instrument = false,
): T {
  const radiance = vec4(output.rgb.mul(sceneRadianceGain).min(65_504), output.a)
  material.outputNode =
    overlay || instrument
      ? Fn(() => {
          if (overlay) motionOverlay.assign(1)
          if (instrument) meterOverlay.assign(1)
          return radiance
        })()
      : radiance
  return material
}
