import { Layers, type Object3D } from 'three/webgpu'

/*
 * The camera layer placement A splits the scene on: everything drawn over the
 * clouds — rings, traces, plumes, the flare, the warp, the sheath, pad dust —
 * on layer 1, and everything under them on layer 0, so a second scene pass
 * can draw the first half's complement over the composite.
 *
 * Nothing is marked without `?clouds=1`, and the camera tests layer 1 from
 * its creation whenever anything is. `compileAsync` drops an object whose
 * layers the camera's do not test (`Renderer.js:3081–3087`), so a mark the
 * camera learns of later leaves every boot warm-up compiling nothing on the
 * marked object, and its pipelines build on its first drawn frame.
 */

/** Everything drawn over the clouds lives on this camera layer; layer 0 is everything under them. */
export const OVER_CLOUDS_LAYER = 1

function only(layer: number): Layers {
  const layers = new Layers()
  layers.set(layer)
  // Shared by every pass that names it: a pass that enabled a layer on it
  // would move every other pass's split with it.
  return Object.freeze(layers)
}

/** Only layer 0: what the scene pass draws under placement A. */
export const UNDER_CLOUDS_LAYERS: Layers = /*@__PURE__*/ only(0)
/** Only layer 1: what the over pass draws. */
export const OVER_CLOUDS_LAYERS: Layers = /*@__PURE__*/ only(OVER_CLOUDS_LAYER)

/**
 * Every layer, for the lights: three keeps a light in a render's set only
 * when its layers pass the camera's, so a light on layer 0 alone lights pass
 * A and leaves pass B dark, and every overlay builds a second, unlit
 * pipeline on its first pass-B frame.
 */
export const ALL_LAYERS: Layers = /*@__PURE__*/ (() => {
  const layers = new Layers()
  layers.enableAll()
  return Object.freeze(layers)
})()

/**
 * The object and every descendant, a Group included: a Group that fails the
 * layer test sets no groupOrder for its children (`Renderer.js:3084–3092`),
 * so marking only the meshes reorders them within the pass.
 */
export function markOverClouds(object: Object3D): void {
  object.traverse((node) => node.layers.set(OVER_CLOUDS_LAYER))
}
