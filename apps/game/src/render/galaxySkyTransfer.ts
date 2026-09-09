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

/** Read the six native cube faces without keeping backend row padding. */
export async function readGalaxyCube(
  renderer: WebGPURenderer,
  target: CubeRenderTarget,
): Promise<readonly Uint16Array[]> {
  const size = target.width
  const stride = Math.ceil((size * 8) / 256) * 128
  const faces = []
  // Submit each copy before awaiting it. The GPU orders all copies before a
  // later render can reuse this slot; a retired target cannot mix generations.
  const reads = Array.from({ length: 6 }, (_, face) =>
    renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size, 0, face),
  )
  for (const padded of await Promise.all(reads)) {
    invariant(
      padded instanceof Uint16Array,
      'Galaxy archive requires half-float cube faces',
    )
    const face = new Uint16Array(size * size * 4)
    for (let y = 0; y < size; y++)
      face.set(padded.subarray(y * stride, y * stride + size * 4), y * size * 4)
    faces.push(face)
  }
  return faces
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
