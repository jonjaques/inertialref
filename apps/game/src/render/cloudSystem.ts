import type {
  Camera,
  Node,
  PassNode,
  Scene,
  WebGPURenderer,
} from 'three/webgpu'
import { vec4 } from 'three/tsl'
import type { CloudRenderReport } from '@inertialref/devtools'
import type { CloudFrameInputs } from './cloudFrame.ts'
import type { SceneLayout } from './sceneLayout.ts'

/*
 * The cloud system: owns every cloud resource, builds the frame's state
 * inside `sensor.render()`, runs the frame's passes in §4.2's order through
 * the composite's frame node, and reports. Built only under `?clouds=1`, and
 * only on WebGPU; with its levers off it draws nothing and adds no pass.
 *
 * Inert here: it builds nothing, draws nothing, and reports that it exists
 * and is off.
 */

export interface CloudSystemDeps {
  readonly renderer: WebGPURenderer
  readonly scene: Scene
  readonly camera: Camera
  readonly layout: SceneLayout
  readonly scenePass: PassNode
}

export interface CloudSensorState {
  readonly processing: 'enhanced' | 'photographic' | string
}

export interface CloudSystem {
  /** Placement A's pass in the sensor's dependency sum: vec4(0) in the post program. */
  readonly overPass: Node
  beginFrame(inputs: CloudFrameInputs | null, sensor: CloudSensorState): void
  endFrame(): void
  /** After `post.render`: the residual meter under composite 'residual'; stats readbacks. */
  afterFrame(renderer: WebGPURenderer): void
  resetHistory(): void
  warm(): Promise<void>
  readonly report: CloudRenderReport
  dispose(): void
}

const OFF: CloudRenderReport = Object.freeze<CloudRenderReport>({
  available: true,
  reason: null,
  on: false,
  levers: {},
  served: null,
  second: null,
  regime: 'off',
  reset: 'none',
  extents: {
    render: [0, 0],
    css: [0, 0],
    trace: [0, 0],
    history: [0, 0],
  },
  frames: 0,
  resets: 0,
  sinceReset: 0,
  pending: {
    maps: false,
    clipmap: false,
    volume: false,
    sunDepth: false,
    far: false,
    history: false,
  },
  settle: null,
  bytes: { total: 0 },
  pipelines: { render: 0, compute: 0 },
  steps: null,
  residual: null,
})

export function createCloudSystem(_deps: CloudSystemDeps): CloudSystem {
  return {
    overPass: vec4(0),
    beginFrame() {},
    endFrame() {},
    afterFrame() {},
    resetHistory() {},
    warm: () => Promise.resolve(),
    report: OFF,
    dispose() {},
  }
}
