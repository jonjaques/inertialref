import type { DataTexture, Node } from 'three/webgpu'
import { step, texture } from 'three/tsl'
import { cloudStandInBinding, cloudStandInTexture } from './cloudNodes.ts'

/*
 * Each genus's density over its layer's height: `genusProfile` baked into
 * 64 heights × 8 genera, RGBA8, linear, no mips, read once a step.
 *
 * Here a 1 × 1 stand-in of the table's format: the layer's whole height at
 * full density, as `genusProfile` draws it.
 */
export class CloudProfile {
  readonly texture: DataTexture = cloudStandInTexture('2d', 'rgba8', {
    value: 1,
  }) as DataTexture
  readonly #table = texture(this.texture)

  /** The genus's profile at `h01`, 0 at its layer's base and 1 at its top; 0 outside. */
  profile(_genus: Node<'float'>, h01: Node<'float'>): Node<'float'> {
    const inside = step(0, h01).mul(step(h01, 1))
    return inside.add(cloudStandInBinding(this.#table, '2d'))
  }

  dispose(): void {
    this.texture.dispose()
  }
}
