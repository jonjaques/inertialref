import { getLogger } from '@inertialref/shared'
import {
  type Node,
  type NodeFrame,
  NodeUpdateType,
  TempNode,
  type WebGPURenderer,
} from 'three/webgpu'
import { float } from 'three/tsl'
import type { CloudPlacement } from './cloudLevers.ts'
import { keepRenderer, splitScenePass } from './cloudSplit.ts'

/*
 * The node that drives a frame's cloud work. It lives in the composite's
 * material, so its `updateBefore` runs at the composite's draw: inside pass B
 * under placement A, inside the split under B. Either way the cloud passes are
 * issued from inside an open render, each its own encoder submitted as it
 * finishes, and the outer render's context and target are intact after them
 * (the premise spike, `cloudPremises.gpu.test.ts`).
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

const NOTHING = (): void => {}

export interface CloudFrameDriver {
  /** True only between `beginFrame` and `endFrame`: `compileAsync` runs `updateBefore` while warming. */
  readonly inFrame: boolean
  readonly placement: CloudPlacement
  /** The frame's cloud passes, in §4.2's order. */
  run(renderer: WebGPURenderer): void
}

export class CloudFrameNode extends TempNode<'float'> {
  static get type(): string {
    return 'CloudFrameNode'
  }

  readonly #driver: CloudFrameDriver
  #reported = false
  #declined = false

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
   * Under 'split', `splitScenePass(renderer, run)`; under 'passes', `run()`;
   * under 'empty-split', `splitScenePass(renderer, () => {})`. Nothing
   * outside a frame.
   *
   * A throw in the cloud work is the clouds', not the frame's: the renderer
   * is put back and the scene pass draws on without them. Left to escape, it
   * would leave the render it is nested in — the scene pass or pass B, and
   * the post chain around it — with no `finishRender`, its pass open and
   * three's render tree pointing into it, and every later frame drawing
   * through that.
   *
   * A split that declines ran nothing: under 'split' the composite reads
   * targets no pass wrote this frame, and under 'empty-split' a measurement
   * prices a split that was never made. So that is reported too.
   */
  override updateBefore(frame: NodeFrame): undefined {
    const driver = this.#driver
    if (!driver.inFrame) return undefined
    const renderer = frame.renderer as WebGPURenderer | null
    if (renderer === null) return undefined
    const restore = keepRenderer(renderer)
    try {
      const placement = driver.placement
      if (placement === 'passes') driver.run(renderer)
      else if (
        !splitScenePass(
          renderer,
          placement === 'split' ? () => driver.run(renderer) : NOTHING,
        )
      )
        this.#decline(placement)
    } catch (cause) {
      restore()
      this.#report(cause)
    }
    return undefined
  }

  /** Once, as a throw is: a split that declines one frame declines the next. */
  #decline(placement: CloudPlacement): void {
    if (this.#declined) return
    this.#declined = true
    log.warn('the scene pass did not split; nothing ran between its halves', {
      placement,
    })
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
      placement: this.#driver.placement,
      cause: String(cause),
      stack: cause instanceof Error ? (cause.stack ?? null) : null,
    })
  }
}
