import { SURFACE_LUMINANCE } from '@inertialref/rendering'
import type { NodeMaterial, Renderer } from 'three/webgpu'
import { Fn, output, uniform, vec4 } from 'three/tsl'
import { motionOverlay } from './sensorMrt.ts'

/** Offscreen reflectance bakes remain reflectance; only the scene collects light. */
const gains = new WeakMap<Renderer, number>()
const integratedGains = new WeakMap<Renderer, number>()
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
): void {
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
): T {
  const radiance = vec4(output.rgb.mul(sceneRadianceGain).min(65_504), output.a)
  material.outputNode = overlay
    ? Fn(() => {
        motionOverlay.assign(1)
        return radiance
      })()
    : radiance
  return material
}
