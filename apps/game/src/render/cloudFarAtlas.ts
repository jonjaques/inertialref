import type { Texture } from 'three/webgpu'
import type { CloudFarDeps, CloudFarField } from './cloudFar.ts'
import { CLOUD_STAND_INS, type CloudFarFn } from './cloudNodes.ts'

/*
 * The layer atlas: 6 faces × 3 layers × 258² texels of (fraction, log
 * in-cloud τ, base, top), RGBA8, a 1548 × 774 2D atlas, baked from the field
 * over 4 × 4 sub-columns and marched as slabs, one texel a step, with
 * per-column mixing and depth moments.
 *
 * Neutral here: holds no cloud, read through a 1 × 1 stand-in of the atlas.
 */
export class CloudFarAtlas implements CloudFarField {
  readonly name = 'farAtlas'
  readonly bytes = 0
  readonly pending = false
  readonly far: CloudFarFn = CLOUD_STAND_INS.far()

  constructor(_deps: CloudFarDeps) {}

  textures(): readonly Texture[] {
    return []
  }

  warm(): Promise<void> {
    return Promise.resolve()
  }

  render(): void {}

  dispose(): void {}
}
