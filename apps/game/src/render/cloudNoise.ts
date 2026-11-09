import type { Node, Texture } from 'three/webgpu'
import { texture, texture3D, vec2, vec4 } from 'three/tsl'
import {
  type CloudResource,
  cloudStandInBinding,
  cloudStandInTexture,
} from './cloudNodes.ts'

/*
 * The noises the field reads every step: a tiling Perlin–Worley base shape, a
 * Worley detail and a 2D curl, baked once at warm into `RenderTarget3D`
 * slices and read at level 0. Held texel by texel to `weatherNoise.ts`.
 *
 * Neutral here: each node reads a 1 × 1 stand-in of its texture's format and
 * kind and returns zero, so a kernel compiled against it binds the baked
 * noise's bindings.
 */

/** Perlin–Worley, R8 (and an RGBA8 sweep variant). */
export const CLOUD_BASE_TEXELS = 128
/** Worley cells a period: one cell = 16 texels. */
export const CLOUD_BASE_CELLS = 8
/** Worley, R8, 4 cells a period. */
export const CLOUD_DETAIL_TEXELS = 32
/** 2D curl, RG8. */
export const CLOUD_CURL_TEXELS = 128

export interface CloudNoiseNodes {
  /** The base shape at a point in base-cell units (the period is CLOUD_BASE_CELLS). Level 0. */
  base(cells: Node<'vec3'>): Node<'float'>
  /** The same texel's four channels (base, and three octaves): the sweep's RGBA8 read. */
  baseWide(cells: Node<'vec3'>): Node<'vec4'>
  detail(cells: Node<'vec3'>): Node<'float'>
  curl(uv: Node<'vec2'>): Node<'vec2'>
}

export class CloudNoise implements CloudResource {
  readonly name = 'noise'
  readonly bytes = 0
  readonly pending = false
  readonly nodes: CloudNoiseNodes

  constructor() {
    // One binding for both base reads: `setFormat` is a value swap between
    // two textures of one binding type.
    const base = texture3D(cloudStandInTexture('3d', 'r8'))
    const detail = texture3D(cloudStandInTexture('3d', 'r8'))
    const curl = texture(cloudStandInTexture('2d', 'rg8'))
    this.nodes = {
      base: () => cloudStandInBinding(base, '3d'),
      baseWide: () => vec4(cloudStandInBinding(base, '3d')),
      detail: () => cloudStandInBinding(detail, '3d'),
      curl: () => vec2(cloudStandInBinding(curl, '2d')),
    }
  }

  /** A value swap between two textures of one binding type. */
  setFormat(_format: 'r8' | 'rgba8'): void {}

  textures(): readonly Texture[] {
    return []
  }

  warm(): Promise<void> {
    return Promise.resolve()
  }

  render(): void {}

  dispose(): void {}
}
