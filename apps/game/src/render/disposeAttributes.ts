import type { BufferAttribute, WebGPURenderer } from 'three/webgpu'

/** Release owned attributes that are not retired with their geometry. */
export function disposeAttributes(
  renderer: WebGPURenderer | null,
  buffers: Iterable<BufferAttribute>,
): void {
  // Three r185 does not listen to BufferAttribute.dispose. Its attribute
  // manager owns both the GPU allocation and the memory record retaining it.
  const attributes = (
    renderer as unknown as {
      _attributes?: { delete(attribute: BufferAttribute): unknown }
    } | null
  )?._attributes
  for (const buffer of buffers) {
    buffer.dispose()
    attributes?.delete(buffer)
  }
}
