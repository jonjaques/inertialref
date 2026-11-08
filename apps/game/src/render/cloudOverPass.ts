import {
  type Camera,
  type MRTNode,
  type Node,
  type NodeFrame,
  NodeUpdateType,
  type RenderTarget,
  type Scene,
  TempNode,
} from 'three/webgpu'
import { vec4 } from 'three/tsl'
import { OVER_CLOUDS_LAYERS } from './cloudLayers.ts'
import { SPLIT_LABEL } from './cloudSplit.ts'
import { namePass, passName } from './passTimeline.ts'

/*
 * Placement A's second scene pass, pass B: the OVER layer drawn into the scene
 * target with load ops, after the pass under the clouds and before the
 * upscaler, from the sensor's dependency sum. It binds nothing in the post
 * program: its node is `vec4(0)`, there only for its order, since three runs
 * the graph's `updateBefore` nodes children first, left to right.
 *
 * The target and the MRT object are the scene pass's own, so pass B is one
 * render context with pass A and every overlay draws with the pipeline its
 * boot warm-up built against the scene's layout. Load ops for color and depth
 * come from `autoClear` off: the overlays land on what pass A drew, and are
 * depth-tested against it. The scene carries no background — three clears for
 * a color one whatever `autoClear` says (`Background.js`), and draws a node
 * one as the first opaque without a depth test — so nothing of pass A is
 * drawn over.
 *
 * The camera tests layer 1 alone for the pass, and the lights must test every
 * layer: three keeps a light in a render's set only when its layers pass the
 * camera's, so a light on layer 0 alone would light pass A and leave pass B
 * dark, and every overlay would build a second, unlit pipeline on its first
 * pass-B frame.
 */

export class CloudOverPassNode extends TempNode<'vec4'> {
  static get type(): string {
    return 'CloudOverPassNode'
  }

  /** Set with the scene pass's UNDER layers, and only on a frame drawn under placement A. */
  active = false

  readonly #scene: Scene
  readonly #camera: Camera
  readonly #target: RenderTarget
  readonly #mrt: MRTNode

  constructor(
    scene: Scene,
    camera: Camera,
    target: RenderTarget,
    mrt: MRTNode,
  ) {
    super('vec4')
    this.#scene = scene
    this.#camera = camera
    this.#target = target
    this.#mrt = mrt
    this.updateBeforeType = NodeUpdateType.RENDER
  }

  /** vec4(0): in the sensor's dependency sum for its order, binding nothing in the post program. */
  override setup(): Node {
    return vec4(0)
  }

  /** Renders the OVER layer into the scene target with load ops, the target named `SPLIT_LABEL` meanwhile. */
  override updateBefore(frame: NodeFrame): undefined {
    if (!this.active) return undefined
    const renderer = frame.renderer
    if (renderer === null) return undefined
    const camera = this.#camera
    const target = renderer.getRenderTarget()
    const face = renderer.getActiveCubeFace()
    const mip = renderer.getActiveMipmapLevel()
    const mrt = renderer.getMRT()
    const autoClear = renderer.autoClear
    const mask = camera.layers.mask
    // Pass B takes the target's name for its own render and hands back
    // whatever pass A is called: the sensor's 'scene', or a test's own.
    const named = passName(this.#target) ?? null
    namePass(this.#target, SPLIT_LABEL)
    try {
      camera.layers.mask = OVER_CLOUDS_LAYERS.mask
      renderer.setRenderTarget(this.#target)
      renderer.setMRT(this.#mrt)
      renderer.autoClear = false
      renderer.render(this.#scene, camera)
    } finally {
      camera.layers.mask = mask
      renderer.autoClear = autoClear
      renderer.setMRT(mrt)
      renderer.setRenderTarget(target, face, mip)
      namePass(this.#target, named)
    }
    return undefined
  }
}
