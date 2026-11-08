import {
  type Camera,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type RenderTarget,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import type { CloudRenderReport } from '@inertialref/devtools'
import type { CloudHistoryTextures } from './cloudHistory.ts'
import { OVER_CLOUDS_LAYER } from './cloudLayers.ts'
import type { CloudCompositeMode, CloudPlacement } from './cloudLevers.ts'
import type { CloudFarFn, CloudPhaseNodes } from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import type { SceneLayout } from './sceneLayout.ts'

/*
 * The composite: a full-screen scene object that lays the history over the
 * scene by §5.11's identity, premultiplied, writing the radiance, `reactive`,
 * `motion` and `meterMask`, with a mesh for each placement. Its material holds
 * the frame node, so the frame's cloud work runs at its draw.
 *
 * Neutral here: both meshes hidden, drawing nothing, and no residual.
 */

export interface CloudCompositeDeps {
  readonly uniforms: CloudUniforms
  readonly history: () => CloudHistoryTextures
  /** R16F km, render resolution. */
  readonly depth: () => Texture
  /** The second body's: atlas. */
  readonly far: CloudFarFn
  readonly phase: CloudPhaseNodes
  /** `CloudFrameNode`: in the graph, so its `updateBefore` runs here. */
  readonly frameNode: Node
}

/** Placement A's mesh draws first among the over-cloud opaques. */
const PASSES_ORDER = -1e6
/** Placement B's: after the sea sheets (0) and the decks (1), before the rings (2). */
const SPLIT_ORDER = 1.5

export class CloudComposite {
  /** Placement A: opaque list, OVER layer, `renderOrder` −1e6. */
  readonly passes: Mesh
  /** Placement B: transparent list, layer 0, `renderOrder` 1.5. */
  readonly split: Mesh
  /** The residual meter's histograms, under composite 'residual'. */
  readonly residual: CloudRenderReport['residual'] = null
  readonly #geometry = new PlaneGeometry(2, 2)
  readonly #material = new MeshBasicNodeMaterial()

  constructor(_deps: CloudCompositeDeps) {
    this.passes = new Mesh(this.#geometry, this.#material)
    this.passes.layers.set(OVER_CLOUDS_LAYER)
    this.passes.renderOrder = PASSES_ORDER
    this.split = new Mesh(this.#geometry, this.#material)
    this.split.renderOrder = SPLIT_ORDER
    for (const mesh of [this.passes, this.split]) {
      mesh.visible = false
      mesh.frustumCulled = false
    }
  }

  /** A uniform: identity, thin, or inert (residual). */
  setMode(_mode: CloudCompositeMode): void {}

  /** At most one mesh visible. */
  show(_placement: CloudPlacement | null): void {}

  /** The residual meter: after the frame, under composite 'residual'. */
  measureResidual(
    _renderer: WebGPURenderer,
    _sceneTarget: RenderTarget,
  ): void {}

  warm(
    _renderer: WebGPURenderer,
    _layout: SceneLayout,
    _camera: Camera,
    _scene: Scene,
  ): Promise<void> {
    return Promise.resolve()
  }

  dispose(): void {
    this.#geometry.dispose()
    this.#material.dispose()
  }
}
