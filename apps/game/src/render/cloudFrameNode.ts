import { getLogger } from '@inertialref/shared'
import {
  type Node,
  type NodeFrame,
  NodeUpdateType,
  type Renderer,
  type RenderTarget,
  TempNode,
  type WebGPURenderer,
} from 'three/webgpu'
import { float } from 'three/tsl'

/*
 * The node that drives a frame's cloud work. It lives in the composite's
 * material, so its `updateBefore` runs at the composite's draw, inside pass B.
 * The cloud passes are issued from inside that open render, each its own
 * encoder submitted as it finishes, and the outer render's context and target
 * are intact after them (the premise spike, `cloudPremises.gpu.test.ts`).
 *
 * `compileAsync` runs `updateBefore` while warming (`upscale.ts:205`), so it
 * does nothing outside a frame, and warming the composite runs no cloud work.
 * A compile reaches the node once the node has drawn: three runs a
 * render-scoped node once per render id, and a compile from the top level
 * runs at id 0, which is where a fresh node's record starts. So a warm-up
 * before the composite's first frame passes it by, and any compile after
 * that frame would run the frame's work inside the compile without the
 * guard.
 */

const log = getLogger('game.clouds')

/*
 * The render tree, which three puts back at the end of a render and not in a
 * `finally`: a nested render that throws leaves its context current, its call
 * depth and render id raised, its object handlers installed and its lights on
 * the lighting stack, and the render it was nested in then draws through all
 * of them into a pass that has ended.
 */
interface RenderTree {
  _currentRenderContext: { readonly renderTarget: RenderTarget | null } | null
  _currentRenderObjectFunction: unknown
  _handleObjectFunction: unknown
  _callDepth: number
  readonly _nodes: { readonly nodeFrame: { renderId: number } } | null
  readonly lighting?: { readonly _cache?: unknown[] }
}

/**
 * The renderer as nested work finds it, and the function that puts it back:
 * the render tree, and the target, MRT, clear, tone mapping, color space and
 * scissor test a pass sets. What a throw inside that work leaves behind is
 * whatever it had changed by then, three's own bookkeeping included.
 */
function keepRenderer(renderer: Renderer): () => void {
  const tree = renderer as unknown as RenderTree
  const context = tree._currentRenderContext
  const objectFunction = tree._currentRenderObjectFunction
  const handleObject = tree._handleObjectFunction
  const depth = tree._callDepth
  const nodeFrame = tree._nodes?.nodeFrame ?? null
  const renderId = nodeFrame?.renderId ?? 0
  // Through `?.`: this is taken outside the `try`, inside an open render, so
  // a three that moves its lighting stack costs the lights their restore and
  // not the frame its scene pass.
  const cache = tree.lighting?._cache
  const lights = cache?.length ?? 0
  const target = renderer.getRenderTarget()
  const face = renderer.getActiveCubeFace()
  const mip = renderer.getActiveMipmapLevel()
  const mrt = renderer.getMRT()
  const autoClear = renderer.autoClear
  const toneMapping = renderer.toneMapping
  const colorSpace = renderer.outputColorSpace
  const scissor = renderer.getScissorTest()
  return () => {
    tree._currentRenderContext = context
    tree._currentRenderObjectFunction = objectFunction
    tree._handleObjectFunction = handleObject
    tree._callDepth = depth
    if (nodeFrame !== null) nodeFrame.renderId = renderId
    // Only pushes go unmatched, so the stack is never shorter than it was.
    if (cache !== undefined && cache.length > lights) cache.length = lights
    renderer.setRenderTarget(target, face, mip)
    renderer.setMRT(mrt)
    renderer.autoClear = autoClear
    renderer.toneMapping = toneMapping
    renderer.outputColorSpace = colorSpace
    renderer.setScissorTest(scissor)
  }
}

export interface CloudFrameDriver {
  /** True only between `beginFrame` and `endFrame`: `compileAsync` runs `updateBefore` while warming. */
  readonly inFrame: boolean
  /** The frame's cloud passes, in §4.2's order. */
  run(renderer: WebGPURenderer): void
  /**
   * `run` threw this frame: whatever it wrote is partial, and the composite
   * drawing next in this same render would read it. Called before pass B
   * draws on, so what it changes holds for this frame's composite.
   */
  failed(): void
}

export class CloudFrameNode extends TempNode<'float'> {
  static get type(): string {
    return 'CloudFrameNode'
  }

  readonly #driver: CloudFrameDriver
  #reported = false

  constructor(driver: CloudFrameDriver) {
    super('float')
    this.#driver = driver
    this.updateBeforeType = NodeUpdateType.RENDER
  }

  /** float(0), added to the composite's opacity so the node is in its graph. */
  override setup(): Node {
    return float(0)
  }

  /**
   * The driver's `run`, in a frame; nothing outside one.
   *
   * A throw in the cloud work is the clouds', not the frame's: the renderer
   * is put back, the driver is told, and pass B draws on without them. The
   * renderer alone is not enough: the composite this node sits in draws
   * next, from a history that holds the last good frame's cloud or part of
   * this one's, so the driver makes it inert. Left to escape, the throw would
   * leave the render it is nested in — pass B, and the post chain around it —
   * with no `finishRender`, its pass open and three's render tree pointing
   * into it, and every later frame drawing through that.
   */
  override updateBefore(frame: NodeFrame): undefined {
    const driver = this.#driver
    if (!driver.inFrame) return undefined
    const renderer = frame.renderer as WebGPURenderer | null
    if (renderer === null) return undefined
    const restore = keepRenderer(renderer)
    try {
      driver.run(renderer)
    } catch (cause) {
      restore()
      driver.failed()
      this.#report(cause)
    }
    return undefined
  }

  /*
   * Once: a throw in the cloud work repeats every frame, and the log's ring
   * is 512 records, so a report a frame would push out everything a bug
   * report wants beside it within nine seconds.
   */
  #report(cause: unknown): void {
    if (this.#reported) return
    this.#reported = true
    log.warn('a frame’s cloud work failed; the frame draws without it', {
      cause: String(cause),
      stack: cause instanceof Error ? (cause.stack ?? null) : null,
    })
  }
}
