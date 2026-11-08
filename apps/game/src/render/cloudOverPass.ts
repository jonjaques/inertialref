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

/*
 * Placement A's second scene pass: the OVER layer drawn into the scene
 * target with load ops, after the pass under the clouds and before the
 * upscaler, from the sensor's dependency sum. It binds nothing in the post
 * program: its node is `vec4(0)`, there only for its order.
 *
 * Here it draws nothing whatever `active` says.
 */
export class CloudOverPassNode extends TempNode<'vec4'> {
  static get type(): string {
    return 'CloudOverPassNode'
  }

  /** Set with the scene pass's UNDER layers, and only on a frame drawn under placement A. */
  active = false

  constructor(
    _scene: Scene,
    _camera: Camera,
    _target: RenderTarget,
    _mrt: MRTNode,
  ) {
    super('vec4')
    this.updateBeforeType = NodeUpdateType.RENDER
  }

  /** vec4(0): in the sensor's dependency sum for its order, binding nothing in the post program. */
  override setup(): Node {
    return vec4(0)
  }

  /** Renders the OVER layer into the scene target with load ops, the target named `SPLIT_LABEL` meanwhile. */
  override updateBefore(_frame: NodeFrame): undefined {
    return undefined
  }
}
