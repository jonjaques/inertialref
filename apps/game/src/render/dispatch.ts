import type { ComputeNode, WebGPURenderer } from 'three/webgpu'

/** Threads, or workgroups on each axis: what three's backend dispatches. */
export type DispatchSize = number | number[]

/**
 * Dispatch a kernel at a size other than the one it was built with.
 *
 * A kernel made by `compute(count)` carries a bounds guard, `instanceIndex >=
 * count` returns, and r187's `renderer.compute(kernel, size)` refuses a size
 * for it, pointing at `computeKernel()` instead. That would drop the guard
 * the terrain and star kernels rely on. The backend dispatches the node's own
 * `dispatchSize` ahead of its `count`, and the guard reads `count`, so the
 * size is lent to the node for this one call and given back: a later
 * `renderer.compute(kernel)` dispatches `count` again, as it does for a node
 * nothing lent a size to.
 *
 * The renderer must be initialized. On one that is not, `compute` defers to
 * `computeAsync`, which reads the size after this has given it back.
 */
export function dispatch(
  renderer: WebGPURenderer,
  kernel: ComputeNode,
  size: DispatchSize,
): void {
  const held = kernel.dispatchSize
  kernel.dispatchSize = size
  try {
    void renderer.compute(kernel)
  } finally {
    kernel.dispatchSize = held
  }
}

/** `dispatch` for a renderer that may still be initializing. */
export async function dispatchAsync(
  renderer: WebGPURenderer,
  kernel: ComputeNode,
  size: DispatchSize,
): Promise<void> {
  const held = kernel.dispatchSize
  kernel.dispatchSize = size
  try {
    await renderer.computeAsync(kernel)
  } finally {
    kernel.dispatchSize = held
  }
}
