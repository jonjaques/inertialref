import type { Texture } from 'three/webgpu'
import type { CloudFarDeps, CloudFarField } from './cloudFar.ts'
import { CLOUD_STAND_INS, type CloudFarFn } from './cloudNodes.ts'

/*
 * The sphere caches: per layer, a 6 × 258² RGBA16F cube atlas at the layer's
 * mid-height holding (fraction, column τ, cached sun transmittance), met at
 * most twice a ray, with no column mixing along a grazing chord.
 *
 * Neutral here: holds no cloud, read through a 1 × 1 stand-in of the atlas.
 */
export class CloudFarSpheres implements CloudFarField {
  readonly name = 'farSpheres'
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
