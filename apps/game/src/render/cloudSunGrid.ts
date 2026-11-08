import type { Node, Texture } from 'three/webgpu'
import {
  CLOUD_STAND_INS,
  type CloudResource,
  type CloudSunDepthNodes,
} from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import type { CloudVolume } from './cloudVolume.ts'

/*
 * The sun's optical depth as a grid around the eye (Nubis³): τ from each
 * cell's center to the union's top along the sun, summed through the local
 * volume, a few slices a frame and whole on a sun move or a jump.
 *
 * Neutral here: no depth anywhere, read through a 1 × 1 stand-in of the
 * grid's 3D format.
 */

/** Over the volume's level-1 window and the union's height. */
export const SUN_GRID_SIZE = [128, 128, 32] as const

export class CloudSunGrid implements CloudResource, CloudSunDepthNodes {
  readonly name = 'sunGrid'
  readonly bytes = 0
  readonly pending = false
  readonly #standIn = CLOUD_STAND_INS.sunDepth('grid')

  constructor(_uniforms: CloudUniforms, _volume: CloudVolume) {}

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
