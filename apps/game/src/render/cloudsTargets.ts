import type { CloudsPassNode } from 'three-clouds-webgpu'
import type { RenderTarget } from 'three/webgpu'

/** All six port targets use single-sampled RGBA16F attachments without mips. */
function bytes(target: RenderTarget | null): number {
  if (!target) return 0
  return (
    target.width * target.height * target.depth * target.textures.length * 8
  )
}

/** Texture storage that the pass owns, including histories kept across a preset change. */
export function cloudsTargetBytes(pass: CloudsPassNode, depth: number) {
  const march = bytes(pass.layerRT)
  const resolve = bytes(pass.resolveRT)
  const history = bytes(pass.historyRT)
  // alpha.9 exposes the sampled shadow map, but can also retain two inactive
  // history targets at the previous quality's dimensions. Read the allocated
  // targets for this instrument. https://github.com/johnfewell/three-clouds-webgpu
  const shadows =
    bytes(pass['shadowRT']) +
    bytes(pass['shadowResolveRT']) +
    bytes(pass['shadowHistoryRT'])
  return {
    depth,
    march,
    resolve,
    history,
    shadows,
    total: depth + march + resolve + history + shadows,
  }
}
