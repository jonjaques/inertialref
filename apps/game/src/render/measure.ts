import type { Camera, Object3D, WebGPURenderer } from 'three/webgpu'

/*
 * GPU frame cost, measured the one way that is known to be honest.
 *
 * [Spike 2](../../../../docs/spikes.md#2--tsl-and-the-atmosphere-integral)
 * established that the obvious instrument lies:
 * `renderer.info.render.timestamp` reported **14.615 ms** for a frame whose true
 * cost was **7.274 ms**, because it double-counts when there is a canvas output
 * pass — and there always is one here. The first run of that spike concluded
 * "TSL is 2× slower" on the strength of it, which was false. The spike's own
 * warning says this will bite the benchmark harness; this file is the benchmark
 * harness not being bitten.
 *
 * What is honest is wall clock across a drained queue: submit N frames, wait for
 * `queue.onSubmittedWorkDone()`, divide. Spike 2 cross-checked that method
 * against a raw `timestamp-query` and they agree; the canvas output pass it
 * includes is a real 0.11 ms, 1.5% of the frame.
 *
 * It cannot be sampled per frame, and that is inherent rather than a limitation
 * of this implementation — draining the queue means awaiting in the middle of a
 * frame, which is precisely the stall being measured. So it is a measurement
 * somebody asks for, not a number on a plot.
 */

/** How many frames to submit. Enough to swamp the two queue drains at either end. */
const DEFAULT_FRAMES = 40

/**
 * The backend's device, if this renderer has one.
 *
 * `WebGPUBackend` carries `device` at runtime; `@types/three` declares it only on
 * the backend's *parameters*, not on the class. One cast, here, rather than at
 * the call site — and `null` on the WebGL backend, which has no queue to drain
 * and therefore no honest answer to give.
 */
function deviceOf(renderer: WebGPURenderer): GPUDevice | null {
  const backend = renderer.backend as { device?: GPUDevice | null }
  return backend.device ?? null
}

export function canMeasureGpu(renderer: WebGPURenderer): boolean {
  return deviceOf(renderer) !== null
}

/**
 * Milliseconds of wall clock per frame, averaged over `frames` submissions.
 *
 * Blocks the render loop for roughly `frames × frame time` — a third of a second
 * at 8 ms a frame — which is why it is a button and not a subscription. Returns
 * `NaN` on the WebGL backend.
 */
export async function measureGpuFrameMs(
  renderer: WebGPURenderer,
  scene: Object3D,
  camera: Camera,
  frames: number = DEFAULT_FRAMES,
): Promise<number> {
  const device = deviceOf(renderer)
  if (device === null) return Number.NaN

  // Start from an empty queue, so the timing covers this batch and not whatever
  // the render loop had in flight when the button was pressed.
  await device.queue.onSubmittedWorkDone()
  const started = performance.now()
  for (let i = 0; i < frames; i += 1) renderer.render(scene, camera)
  await device.queue.onSubmittedWorkDone()
  return (performance.now() - started) / frames
}
