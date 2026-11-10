import type { Texture, WebGPURenderer } from 'three/webgpu'
import { vec3 } from 'three/tsl'
import type { CloudResource, CloudSourceNodes } from './cloudNodes.ts'

/*
 * The higher orders' source function on the GPU: the slab's source table as
 * a 3D texture, and its read. A sample's light past first order is rebuilt
 * from three terms the table holds for its transport depths to the slab's
 * two faces and the sun's cosine.
 *
 * **It holds no table and draws no source.** The read answers zero in every
 * term, which is a march with first-order light and the sky's alone.
 */

/** The source as the field holds it: its node, and the table it uploads. */
export interface CloudSource extends CloudResource, CloudSourceNodes {}

export function createCloudSource(): CloudSource {
  return {
    name: 'source',
    bytes: 0,
    pending: false,
    source: () => vec3(0),
    textures: (): readonly Texture[] => [],
    warm: (_renderer: WebGPURenderer): Promise<void> => Promise.resolve(),
    render: (): void => {},
    dispose: (): void => {},
  }
}
