import type { Node, Texture } from 'three/webgpu'
import { texture, vec3 } from 'three/tsl'
import type { CloudResource, CloudSample } from './cloudNodes.ts'
import { cloudStandInBinding, cloudStandInTexture } from './cloudNodes.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * What the fine march reads a step: six eye-anchored levels of 256² texels,
 * 250 m × 2^k, in a toroidally addressed 2D array of four RGBA8 targets,
 * baked from the weather cube in the strips the window's move exposes.
 *
 * Neutral here: no cover anywhere, read through 1 × 1 stand-ins of the three
 * targets the field reads, so a kernel compiled against it binds them.
 */

export interface CloudClipmapNodes {
  /**
   * Each layer's coverage at the sample, from the finest level whose window
   * holds it, faded over the outer fifth into the next (the fade band reads
   * both levels). Level 0.
   */
  coverage(sample: CloudSample, body: CloudBodyUniforms): Node<'vec3'>
  /** (log τ, convective share, ice) of one layer: read once a segment. */
  column(
    sample: CloudSample,
    body: CloudBodyUniforms,
    layer: Node<'int'>,
  ): Node<'vec3'>
  /** The texel size of the level `coverage` reads: the column a segment may span. */
  columnMeters(sample: CloudSample, body: CloudBodyUniforms): Node<'float'>
}

export class CloudClipmap implements CloudResource {
  readonly name = 'clipmap'
  readonly bytes = 0
  readonly pending = false
  readonly nodes: CloudClipmapNodes

  constructor(_uniforms: CloudUniforms) {
    const [cover, depth, convective] = [0, 1, 2].map(() =>
      texture(cloudStandInTexture('2d-array', 'rgba8', { layers: 6 })),
    ) as [
      ReturnType<typeof texture>,
      ReturnType<typeof texture>,
      ReturnType<typeof texture>,
    ]
    this.nodes = {
      coverage: () => vec3(cloudStandInBinding(cover, '2d-array')),
      column: () =>
        vec3(
          cloudStandInBinding(depth, '2d-array'),
          cloudStandInBinding(convective, '2d-array'),
          cloudStandInBinding(cover, '2d-array'),
        ),
      columnMeters: (_sample, body) => body.clipmap[0]!.texel,
    }
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
