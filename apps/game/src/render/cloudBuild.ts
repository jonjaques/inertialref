/*
 * Whether the newest canvas build draws clouds.
 *
 * The warm-up compiles a two-sided transparent mesh as one single-pass draw
 * while this holds, and as two faces, the warm-up `main` has, otherwise. On
 * a page with clouds the sensor installs the cloud providers while the
 * landing effects are still compiling, and a second queued face then builds
 * against another shader key: a single-output program for an MRT pipeline,
 * which WebGPU rejects and the renderer does not survive. A page without
 * clouds installs nothing.
 *
 * Set by the canvas factory as it is invoked (`canvasClouds.ts`), before the
 * renderer exists. A preload keyed on the renderer's output starts warming
 * while the factory still awaits the cloud load, so a mark made when the
 * load lands is too late for it. One flag for the page, not one per
 * renderer: a build superseded mid-load is retired with its canvas, and a
 * clouds build on WebGL, or one whose load fails, pays only the single pass,
 * the one node build a frame later that the flag exists to keep off pages
 * with no clouds at all.
 */

let clouds = false

/** The canvas build starting now draws clouds, or does not. */
export const buildingClouds = (on: boolean): void => {
  clouds = on
}

/** Whether the newest canvas build draws clouds. */
export const buildsClouds = (): boolean => clouds
