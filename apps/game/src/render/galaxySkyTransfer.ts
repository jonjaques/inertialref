import {
  DataTexture,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Vector3,
  type CubeRenderTarget,
  type WebGPURenderer,
} from 'three/webgpu'
import { invariant } from '@inertialref/shared'

/** Read the six native cube faces, each a tight half-float RGBA array. */
export async function readGalaxyCube(
  renderer: WebGPURenderer,
  target: CubeRenderTarget,
): Promise<readonly Uint16Array[]> {
  const size = target.width
  // Submit each copy before awaiting it. The GPU orders all copies before a
  // later render can reuse this slot; a retired target cannot mix generations.
  const reads = Array.from({ length: 6 }, (_, face) =>
    renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size, 0, face),
  )
  const faces = await Promise.all(reads)
  // three strips WebGPU's 256-byte row alignment from a readback, so a face
  // is tight. The length is checked, not trusted: a padded face is longer
  // whenever a row is not already 256 bytes, which at 8 bytes a texel is
  // every size but a multiple of 32.
  return faces.map((face) => {
    invariant(
      face instanceof Uint16Array,
      'Galaxy archive requires half-float cube faces',
    )
    invariant(
      face.length === size * size * 4,
      'Galaxy archive faces must read back tight',
    )
    return face
  })
}

/** Upload physical half floats into a renderer-owned cube; no shader or exposure. */
export function restoreGalaxyCube(
  renderer: WebGPURenderer,
  target: CubeRenderTarget,
  faces: readonly Uint16Array[],
): void {
  const size = target.width
  invariant(
    faces.length === 6 &&
      faces.every((face) => face.length === size * size * 4),
    'Galaxy archive faces must fit the target',
  )
  renderer.initRenderTarget(target)
  for (let face = 0; face < 6; face++) {
    const source = new DataTexture(
      faces[face]!,
      size,
      size,
      RGBAFormat,
      HalfFloatType,
    )
    source.minFilter = LinearFilter
    source.magFilter = LinearFilter
    source.generateMipmaps = false
    source.needsUpdate = true
    try {
      renderer.copyTextureToTexture(
        source,
        target.texture,
        null,
        new Vector3(0, 0, face),
      )
    } finally {
      source.dispose()
    }
  }
}
