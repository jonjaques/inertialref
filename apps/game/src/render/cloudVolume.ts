import type { Node, Texture } from 'three/webgpu'
import {
  CLOUD_STAND_INS,
  type CloudMediumFn,
  type CloudRay,
  type CloudResource,
  type CloudSample,
} from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The local volume: the field cached in three eye-anchored levels of
 * 256² × 32 RG8 texels, stacked with guard slices in one `RenderTarget3D`,
 * baked a few slices a frame, and a max-mip bound of 4³ bricks dilated by a
 * texel so a step through empty space can jump to its brick's exit.
 *
 * Neutral here: what it caches is a vacuum, read through 1 × 1 stand-ins of
 * the volume's and the bound's formats, and no brick is ever skipped.
 */

export const CLOUD_VOLUME_SIZE = 256
/** Plus 2 guard slices a level, stacked in z. */
export const CLOUD_VOLUME_SLICES = 32
export const CLOUD_VOLUME_TEXELS = [50, 200, 800] as const

export interface CloudVolumeDeps {
  readonly uniforms: CloudUniforms
  /** What it caches: the field. */
  readonly bake: CloudMediumFn
  readonly detail: CloudNoiseNodes
}

export class CloudVolume implements CloudResource {
  readonly name = 'volume'
  readonly bytes = 0
  readonly pending = false
  /**
   * One read a step: R = √(σ/σ_scale), G = fraction, at the finest level
   * holding the sample, plus detail-noise erosion where the footprint is finer
   * than the level's texel. Level 0.
   */
  readonly medium: CloudMediumFn
  readonly #standIn: ReturnType<typeof CLOUD_STAND_INS.volume>

  constructor(_deps: CloudVolumeDeps) {
    this.#standIn = CLOUD_STAND_INS.volume()
    this.medium = this.#standIn.medium
  }

  /**
   * The largest R over the sample's 4³ brick and one texel around it: zero
   * means no trilinear read anywhere in the brick can see cloud.
   */
  bound(sample: CloudSample, body: CloudBodyUniforms): Node<'float'> {
    return this.#standIn.bound(sample, body)
  }

  /** The distance along the ray at which it leaves the brick holding the sample. */
  brickExit(
    sample: CloudSample,
    ray: CloudRay,
    body: CloudBodyUniforms,
  ): Node<'float'> {
    return this.#standIn.brickExit(sample, ray, body)
  }

  textures(): readonly Texture[] {
    return []
  }

  warm(): Promise<void> {
    return Promise.resolve()
  }

  render(): void {}

  dispose(): void {}
}
