import type { DataTexture, Node } from 'three/webgpu'
import { float, select, texture } from 'three/tsl'
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

  /** The genus's profile at `h01`, 0 at its layer's base and 1 at its top; 0 outside (0, 1). */
  profile(_genus: Node<'float'>, h01: Node<'float'>): Node<'float'> {
    // Strict at both ends, as `genusProfile` is: `step` is inclusive, and
    // would draw a sample standing exactly on a base or a top at full density.
    const inside = select(
      h01.greaterThan(0).and(h01.lessThan(1)),
      float(1),
      float(0),
    )
    return inside.add(cloudStandInBinding(this.#table, '2d'))
  }

  dispose(): void {
    this.texture.dispose()
  }
}
