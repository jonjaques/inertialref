import {
  type Node,
  type NodeFrame,
  NodeUpdateType,
  TempNode,
  type WebGPURenderer,
} from 'three/webgpu'
import { float } from 'three/tsl'
import type { CloudPlacement } from './cloudLevers.ts'

/*
 * The node that drives a frame's cloud work. It lives in the composite's
 * material, so its `updateBefore` runs at the composite's draw: inside pass B
 * under placement A, inside the split under B. `compileAsync` runs
 * `updateBefore` while warming (`upscale.ts:205`), so it does nothing outside
 * a frame, and warming the composite runs no cloud work.
 *
 * Here it does nothing inside a frame either.
 */

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

  constructor(_driver: CloudFrameDriver) {
    super('float')
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
   */
  override updateBefore(_frame: NodeFrame): undefined {
    return undefined
  }
}
