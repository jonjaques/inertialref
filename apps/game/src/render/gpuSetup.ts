import { create, globals } from 'webgpu'

/*
 * The globals `three/webgpu` needs to exist before it is imported.
 *
 * This is a vitest setup file (`apps/game/vitest.gpu.config.ts`), not a module
 * the harness imports, and the distinction is load-bearing: a module's imports
 * evaluate before its body, so a `gpuHarness.ts` that installed these and then
 * imported `three/webgpu` would import it first and install them second. The
 * setup file runs before any test file's imports do.
 *
 * Three things, and none of them is guessable from the error it produces.
 */

/*
 * 1. `navigator.gpu`, defined onto the object that is already there.
 *
 * `navigator` is a read-only global from Node 21 on, so the assignment every
 * WebGPU-in-Node example prints — `globalThis.navigator = { gpu }` — throws
 * `TypeError: Cannot set property navigator`. The property goes on the existing
 * object. Dawn's `globals` are the enum objects three reads as bare names —
 * `GPUBufferUsage`, `GPUTextureUsage`, `GPUMapMode`, `GPUShaderStage` — which a
 * browser has and Node does not.
 *
 * `create([])` takes Dawn toggles; none are needed. The adapter it picks is the
 * physical one — `gpuHarness.gpu.test.ts` asserts that, because a software
 * adapter is not the thing under test.
 */
Object.assign(globalThis, globals)
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: create([]),
  configurable: true,
})

/*
 * 2. `self`, carrying an animation frame that never fires.
 *
 * `WebGPURenderer`'s constructor binds its animation loop to `self`, and
 * `init()` starts that loop — so without one, allocating a device dies with
 * `Cannot read properties of null (reading 'requestAnimationFrame')`, an error
 * about frames thrown by a call about devices. The loop's `start()` runs one
 * update synchronously and then asks for the next frame; returning 0 here is
 * the whole of "no next frame". A `setTimeout` stand-in would run the loop for
 * real, and a test that unknowingly depended on that would pass here and hang
 * on the day the stub changed. Every frame in this suite is an explicit
 * `render()`.
 */
const noFrame = (): number => 0
const noCancel = (): void => {}
Object.defineProperty(globalThis, 'self', {
  value: Object.assign(globalThis, {
    requestAnimationFrame: noFrame,
    cancelAnimationFrame: noCancel,
  }),
  configurable: true,
})

/*
 * 3. There is deliberately no `document`. The renderer reaches for
 * `document.createElementNS` only when it is not handed a canvas, and
 * `gpuHarness.ts` always hands it one — a stub whose `getCurrentTexture` throws,
 * so a test that forgets `setRenderTarget` fails loudly rather than drawing
 * into a plausible-looking dummy. A `document` here would let a material module
 * that reads the DOM at import time pass in this suite and fail in the worker
 * it is meant to run in.
 */
