import type { WebGPURenderer } from 'three/webgpu'

type SceneCompare = NonNullable<Parameters<WebGPURenderer['setOpaqueSort']>[0]>

/**
 * Three r185 reverses the whole list for reversed Z, including authored layer
 * order and stable IDs. Compensate those keys before its reversal; only the
 * projected depth key changes meaning when the depth convention changes.
 */
export function installSceneOrder(renderer: WebGPURenderer): void {
  const compare =
    (transparent: boolean): SceneCompare =>
    (a, b) => {
      const order = renderer.reversedDepthBuffer ? -1 : 1
      return (
        ((a.groupOrder ?? 0) - (b.groupOrder ?? 0)) * order ||
        ((a.renderOrder ?? 0) - (b.renderOrder ?? 0)) * order ||
        (transparent ? (b.z ?? 0) - (a.z ?? 0) : (a.z ?? 0) - (b.z ?? 0)) ||
        ((a.id ?? 0) - (b.id ?? 0)) * order
      )
    }
  renderer.setOpaqueSort(compare(false))
  renderer.setTransparentSort(compare(true))
}
