import type { Node, Texture } from 'three/webgpu'
import { float, int, select, texture, vec4 } from 'three/tsl'
import { cubeAtlasUv } from './cloudGeometry.ts'
import { type CloudResource, cloudStandInTexture } from './cloudNodes.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The weather cube: a 2D atlas of six tangent-warped face tiles, 3 × 2, each
 * 512² with a one-texel gutter, four RGBA8 targets drawn by one MRT quad,
 * baked from the placeholder's coverage function one face a frame. The bakes
 * read it — the clipmap's levels, the far atlas, the sphere caches — and the
 * fine march does not, which keeps the trace kernel inside the binding limit.
 *
 * Neutral here: the coverage node is each layer's mean, which is what a
 * uniform scenario draws, and the map nodes read 1 × 1 stand-ins of the four
 * targets' format at the atlas uv a direction has.
 */

/** Interior texels a face tile has. */
export const CLOUD_CUBE_TILE = 512
/** Texels of neighbor a tile carries on each side. */
export const CLOUD_CUBE_GUTTER = 1

/**
 * The placeholder's coverage of `layer` at a body-fixed direction, for
 * `body`'s frame and the shared scenario uniforms: the cube bake's source,
 * and the second body's far bake's (§3.13).
 */
export function scenarioCoverageNode(
  uniforms: CloudUniforms,
  _body: CloudBodyUniforms,
  layer: Node<'int'>,
  _direction: Node<'vec3'>,
): Node<'float'> {
  const coverage = uniforms.layers.coverage
  return select(
    layer.equal(int(0)),
    coverage.x,
    select(
      layer.equal(int(1)),
      coverage.y,
      select(layer.equal(int(2)), coverage.z, float(0)),
    ),
  )
}

export interface CloudMapNodes {
  /** Texture 0 at a body-fixed direction (gutter-safe bilinear in its face tile, level 0). */
  synoptic(direction: Node<'vec3'>): Node<'vec4'>
  /** Texture k (1, 2, 3) at a direction. */
  channel(direction: Node<'vec3'>, texture: 1 | 2 | 3): Node<'vec4'>
}

export class CloudMaps implements CloudResource {
  readonly name = 'maps'
  readonly bytes = 0
  readonly pending = false
  readonly nodes: CloudMapNodes

  constructor(_uniforms: CloudUniforms) {
    const maps = [0, 1, 2, 3].map(() =>
      texture(cloudStandInTexture('2d', 'rgba8')),
    )
    const read = (direction: Node<'vec3'>, k: number): Node<'vec4'> =>
      vec4(
        maps[k]!.sample(
          cubeAtlasUv(direction, CLOUD_CUBE_TILE, CLOUD_CUBE_GUTTER, 3, 2),
        ).level(float(0)),
      ).mul(0)
    this.nodes = {
      synoptic: (direction) => read(direction, 0),
      channel: (direction, k) => read(direction, k),
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
