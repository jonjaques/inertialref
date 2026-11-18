/*
 * The renderers a canvas built a cloud system for.
 *
 * The warm-up compiles a two-sided transparent mesh as one single-pass draw
 * on these and on no others. On a renderer with clouds, the sensor installs
 * the cloud providers while the landing effects are still compiling, and a
 * second queued face then builds against another shader key, a
 * single-output program for an MRT pipeline that WebGPU rejects and the
 * renderer does not survive. A page without clouds installs nothing, so its
 * warm-up stays the one `main` has, both faces queued.
 *
 * Marked by the canvas factory as it publishes the system
 * (`canvasClouds.ts`), before R3F mounts anything that warms. A weak set:
 * a renderer a rebuild retires leaves with its canvas.
 */

const marked = new WeakSet<object>()

/** The canvas built a cloud system for this renderer. */
export const markCloudRenderer = (renderer: object): void => {
  marked.add(renderer)
}

/** Whether a canvas built a cloud system for this renderer. */
export const buildsClouds = (renderer: object): boolean => marked.has(renderer)
