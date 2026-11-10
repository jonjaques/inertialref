import { Layers, type Material, type Object3D } from 'three/webgpu'

/*
 * The camera layer the clouds split the scene on: everything drawn over the
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

/** Only layer 0: what the scene pass draws on a frame the clouds draw. */
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

/*
 * What the marks hold, for the frame's count of what draws over the clouds.
 * Only what three draws: a marked Group that stays visible over meshes that
 * hide themselves — the plumes, until a valve opens — would otherwise read as
 * something over the clouds on every frame of a flight.
 *
 * Held weakly. A mark has no unmark: an orbit's line is dropped by its
 * component when its path goes, and a strong set would keep every one of
 * them for the page's life.
 */
const MARKED = new Set<WeakRef<Object3D>>()

interface Drawn {
  readonly isMesh?: boolean
  readonly isLine?: boolean
  readonly isPoints?: boolean
  readonly isSprite?: boolean
  readonly material?: Material | readonly Material[]
}

const draws = (node: Object3D): boolean => {
  const kind = node as Drawn
  return (
    kind.isMesh === true ||
    kind.isLine === true ||
    kind.isPoints === true ||
    kind.isSprite === true
  )
}

/**
 * The object and every descendant, a Group included: a Group that fails the
 * layer test sets no groupOrder for its children (`Renderer.js:3084–3092`),
 * so marking only the meshes reorders them within the pass.
 */
export function markOverClouds(object: Object3D): void {
  object.traverse((node) => {
    node.layers.set(OVER_CLOUDS_LAYER)
    if (draws(node)) MARKED.add(new WeakRef(node))
  })
}

/** Whether three would reach `node` from `scene`: its own flag and every ancestor's, up to the scene. */
function reached(node: Object3D, scene: Object3D): boolean {
  for (let at: Object3D | null = node; at !== null; at = at.parent) {
    if (!at.visible) return false
    if (at === scene) return true
  }
  return false
}

function writesDepth(node: Object3D): boolean {
  const material = (node as Drawn).material
  if (material === undefined) return false
  return Array.isArray(material)
    ? material.some((one: Material) => one.depthWrite)
    : (material as Material).depthWrite
}

/**
 * What the marks put over the clouds in `scene` this frame: nothing, something
 * none of which writes depth, or something that does.
 */
export type OverClouds = 'nothing' | 'drawn' | 'depth'

/**
 * The frame's count, from the marks alone and by visibility alone.
 *
 * The frustum is not tested: an overlay behind the camera reads as drawn,
 * which keeps the second scene pass on a frame that could have gone without
 * it, where the other error draws an overlay under the clouds it stands in
 * front of. An object put on the layer by hand is not counted at all, which
 * is rule 69's reason for the one way to mark.
 */
export function overClouds(scene: Object3D): OverClouds {
  let found: OverClouds = 'nothing'
  for (const held of MARKED) {
    const node = held.deref()
    if (node === undefined) {
      MARKED.delete(held)
      continue
    }
    if (!reached(node, scene)) continue
    if (writesDepth(node)) return 'depth'
    found = 'drawn'
  }
  return found
}
