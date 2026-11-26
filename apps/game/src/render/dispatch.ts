import type { ComputeNode, WebGPURenderer } from 'three/webgpu'

/** Threads, or workgroups on each axis: what three's backend dispatches. */
export type DispatchSize = number | number[]

/**
 * Dispatch a kernel at a size other than the one it was built with.
 *
 * A kernel made by `compute(count)` carries a bounds guard, `instanceIndex >=
 * count` returns, and r187's `renderer.compute(kernel, size)` refuses a size
 * for it, pointing at `computeKernel()` instead. That would drop the guard
 * the terrain and star kernels rely on. The WebGPU backend dispatches the
 * node's own `dispatchSize` ahead of its `count`, and the guard reads
 * `count`, so the size is lent to the node for this one call and given back:
 * a later `renderer.compute(kernel)` dispatches `count` again, as it does for
 * a node nothing lent a size to.
 *
 * A size of zero is lent as no workgroups. The backend takes the node's size
 * as `dispatchSize || count`, so a bare 0 would dispatch the whole `count`.
 *
 * The renderer must be initialized, and WebGPU's. On one that is not
 * initialized, `compute` defers to `computeAsync`, which reads the size after
 * this has given it back. The WebGL backend reads `count` alone, so there the
 * lent size is ignored and the whole `count` runs; every caller is a
 * WebGPU-only producer.
 */
export function dispatch(
  renderer: WebGPURenderer,
  kernel: ComputeNode,
  size: DispatchSize,
): void {
  const held = kernel.dispatchSize
  kernel.dispatchSize = lent(size)
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
  kernel.dispatchSize = lent(size)
  try {
    await renderer.computeAsync(kernel)
  } finally {
    kernel.dispatchSize = held
  }
}

/** The size as the node carries it: zero threads as zero workgroups. */
const lent = (size: DispatchSize): DispatchSize =>
  size === 0 ? [0, 1, 1] : size
