import {
  HalfFloatType,
  RedFormat,
  RenderTarget,
  type Texture,
} from 'three/webgpu'
import type { CloudResource } from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import type { SceneLayout } from './sceneLayout.ts'

/*
 * The scene's distance for the clouds: view distance along each pixel's ray
 * in render meters ÷ 1000, R16F at render resolution, clamped at 60,000 km so
 * far depth reads as sky, drawn as `cloud depth` inside the frame node's run
 * from this frame's multisampled depth — tied as the sea's frame read ties
 * its copy, so the binding layout a warm-up compiles is the frame's.
 *
 * Neutral here: a 1 × 1 target of the real format, never drawn.
 */
export class CloudDepth implements CloudResource {
  readonly name = 'depth'
  readonly bytes = 0
  readonly pending = false
  readonly #target = new RenderTarget(1, 1, {
    type: HalfFloatType,
    format: RedFormat,
    depthBuffer: false,
  })

  constructor(_uniforms: CloudUniforms, _layout: SceneLayout) {}

  /**
   * View distance (along the ray) in render meters ÷ 1000, R16F, render
   * resolution, clamped at 60,000 km; far depth stores the clamp. Row 0 is
   * the top of the image.
   */
  get texture(): Texture {
    return this.#target.texture
  }

  /**
   * Ties the copy's source to the scene target's (multisampled) depth, as
   * `SeaFrameNode.#tie` does, so the binding layout matches the frame's.
   */
  tie(_sceneTarget: RenderTarget): void {}

  textures(): readonly Texture[] {
    return []
  }

  warm(): Promise<void> {
    return Promise.resolve()
  }

  render(): void {}

  dispose(): void {
    this.#target.dispose()
  }
}
