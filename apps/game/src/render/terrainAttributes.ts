import {
  type BufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type Mesh,
} from 'three/webgpu'
import { COVER_CHANNELS } from '@inertialref/universe'

/*
 * The cover, as the vertex attributes the ground material reads.
 *
 * `packCover` writes `COVER_CHANNELS` bytes a vertex and the material reads
 * them as two `vec4`s — `terrainCover` and `terrainCover2` — because a vertex
 * attribute is at most four lanes wide. One `InterleavedBuffer` over the
 * eight-byte record, with an attribute *object* per name at its own offset,
 * is the layout that keeps the bytes where `packCover` put them: a plain
 * `BufferAttribute` has no stride, so two of them over an eight-byte array
 * would each read the other's lanes as their own second vertex.
 *
 * Two attribute objects, never one under two names, for the reason
 * [ADR-0021](../../../../docs/adr/0021-the-ground.md) gives; and the morph
 * twin is a second buffer over its own array, because the morph cover is a
 * different array. Every geometry that wears the material — a patch, a rock,
 * the warm-up dummies that compile the pipelines — goes through here, so the
 * layout the boot warm-up freezes is the layout the real draw uses.
 */

/** The attribute names, in the order `packCover` fills the record. */
export const COVER_ATTRIBUTES = ['terrainCover', 'terrainCover2'] as const
export const MORPH_COVER_ATTRIBUTES = [
  'terrainMorphCover',
  'terrainMorphCover2',
] as const

/** Both buffers a geometry's cover lives in, for the writer that updates them. */
export interface CoverBuffers {
  readonly cover: InterleavedBuffer
  readonly morphCover: InterleavedBuffer
}

/**
 * Attach a cover record and its morph twin to `geometry`, per vertex or per
 * instance, and hand back the buffers so a writer can flag its own ranges.
 */
export function attachCover(
  geometry: BufferGeometry,
  cover: Uint8Array,
  morphCover: Uint8Array,
  instanced = false,
): CoverBuffers {
  const buffer = (bytes: Uint8Array): InterleavedBuffer =>
    instanced
      ? new InstancedInterleavedBuffer(bytes, COVER_CHANNELS, 1)
      : new InterleavedBuffer(bytes, COVER_CHANNELS)
  const coverBuffer = buffer(cover)
  const morphBuffer = buffer(morphCover)
  COVER_ATTRIBUTES.forEach((name, i) => {
    geometry.setAttribute(
      name,
      new InterleavedBufferAttribute(coverBuffer, 4, i * 4, true),
    )
  })
  MORPH_COVER_ATTRIBUTES.forEach((name, i) => {
    geometry.setAttribute(
      name,
      new InterleavedBufferAttribute(morphBuffer, 4, i * 4, true),
    )
  })
  return { cover: coverBuffer, morphCover: morphBuffer }
}

/**
 * Dispose a patch's geometry without taking the shared index down with it.
 *
 * Every patch geometry holds the one session-wide index attribute, and the
 * renderer's dispose path destroys the GPU buffer of every attribute the
 * geometry references — the index included, with no reference count. Disposing
 * one evicted mesh would destroy the index buffer under every patch still
 * drawn, which re-uploads it next frame: the exact per-patch churn the shared
 * attribute exists to avoid. Detaching the index first limits the dispose to
 * the buffers this mesh actually owns. The ground and the sheet both evict
 * through this, since both hold the same index.
 */
export function disposeKeepingSharedIndex(mesh: Mesh): void {
  mesh.geometry.setIndex(null)
  mesh.geometry.dispose()
}
