import type { Node, Texture } from 'three/webgpu'
import {
  CLOUD_STAND_INS,
  type CloudMediumFn,
  type CloudResource,
  type CloudSunDepthNodes,
} from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * The sun's optical depth as three sun-space Beer shadow maps (UE5's form):
 * front depth as a pair of half floats, mean extinction and maximum optical
 * depth, scrolled toroidally as the eye moves and rebuilt a cascade a frame
 * when the sun turns or the field jumps, under the cap both candidates share.
 *
 * Neutral here: no depth anywhere, read through a 1 × 1 stand-in of the
 * cascades' 2D array.
 */

/** Meters; texels of 25, 100 and 400 m. */
export const SUN_CASCADE_EXTENTS = [12_800, 51_200, 204_800] as const
export const SUN_CASCADE_SIZE = 512
/** 64 rows a slice. */
export const SUN_CASCADE_SLICES = 8
/** The per-frame cap both candidates share, in texel-steps: one grid rebuild (128² × 32 cells × 32 steps); a cascade rebuild is 512² × 48. */
export const SUN_DEPTH_FRAME_CAP = 16_777_216

export class CloudSunCascades implements CloudResource, CloudSunDepthNodes {
  readonly name = 'sunCascades'
  readonly bytes = 0
  readonly pending = false
  readonly #standIn = CLOUD_STAND_INS.sunDepth('cascades')

  constructor(_uniforms: CloudUniforms, _field: CloudMediumFn) {}

  opticalDepth(offset: Node<'vec3'>): Node<'float'> {
    return this.#standIn.opticalDepth(offset)
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
