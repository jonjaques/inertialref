import type {
  Node,
  StorageTexture,
  Texture,
  WebGPURenderer,
} from 'three/webgpu'
import type { Extent } from '@inertialref/rendering'
import type { CloudFrame } from './cloudFrame.ts'
import type { CloudFarKind, CloudSunDepth } from './cloudLevers.ts'
import {
  type CloudBudget,
  cloudStorageTexture,
  type CloudFarFn,
  type CloudMediumFn,
  type CloudPhaseNodes,
  type CloudRay,
  type CloudResource,
  type CloudSample,
  type CloudSunFn,
} from './cloudNodes.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The trace: one compute kernel a (cache, sun depth, far) triple, and the
 * sweep's, each named `cloud trace`, at a quarter of the display's axes. A
 * converging frame dispatches once at this frame's interleave phase; the
 * immediate regime dispatches four times at the same extent, a quarter of
 * the step budget each, so every store stays inside its texture (§5.14).
 *
 * Neutral here: four storage textures of the real format at 1 × 1, and no
 * dispatch.
 */

export interface CloudTraceTextures {
  /** (L_c.rgb, T_c): the cloud's light reaching t₀ per unit sun irradiance, and its transmittance over the span. w × h. */
  readonly light: StorageTexture
  /** 2w × h. [2i, j]: (B.rgb, d_reproj km). [2i+1, j]: (d_end km, d_front km, deviation km, knots). */
  readonly aux: StorageTexture
  /** 2w × h. [2i, j]: (entry₀, exit₀, entry₁, exit₁) km. [2i+1, j]: (entry₂, exit₂, entry₃, exit₃) km. */
  readonly knotDepth: StorageTexture
  /** 2w × 2h. Knot k of texel (i, j) at (2i + (k & 1), 2j + (k >> 1)): (L.rgb, T) at the knot's exit. */
  readonly knotLight: StorageTexture
  /** The trace's extent, which every dispatch writes within, the immediate regime's included. */
  readonly extent: Extent
}

export interface CloudTraceDeps {
  readonly uniforms: CloudUniforms
  readonly media: {
    readonly field: CloudMediumFn
    readonly volume: CloudMediumFn | null
    readonly bound:
      ((s: CloudSample, b: CloudBodyUniforms) => Node<'float'>) | null
    readonly brickExit:
      | ((s: CloudSample, r: CloudRay, b: CloudBodyUniforms) => Node<'float'>)
      | null
    readonly sweep: CloudMediumFn
  }
  readonly sun: Readonly<Record<CloudSunDepth, CloudSunFn>>
  readonly phase: CloudPhaseNodes
  readonly far: Readonly<Record<CloudFarKind, CloudFarFn>>
  /** The render-resolution scene distance, km (R16F), from the depth copy. */
  readonly depth: () => Texture
}

export class CloudTrace implements CloudResource {
  readonly name = 'trace'
  readonly bytes = 0
  readonly pending = false
  /**
   * What the trace writes. `outputs` and not `textures`, which every resource
   * answers with what it holds for the census.
   */
  readonly outputs: CloudTraceTextures
  /** Mean and largest steps a ray when `levers.stats`, read back a few frames late; null otherwise. */
  readonly steps: {
    readonly mean: number
    readonly max: number
    readonly exhausted: number
  } | null = null

  constructor(_deps: CloudTraceDeps) {
    this.outputs = {
      light: cloudStorageTexture(1, 1, 'rgba16float', 'cloud trace light'),
      aux: cloudStorageTexture(1, 1, 'rgba16float', 'cloud trace aux'),
      knotDepth: cloudStorageTexture(1, 1, 'rgba16float', 'cloud knot depth'),
      knotLight: cloudStorageTexture(1, 1, 'rgba16float', 'cloud knot light'),
      extent: { width: 1, height: 1 },
    }
  }

  textures(): readonly Texture[] {
    return []
  }

  warm(): Promise<void> {
    return Promise.resolve()
  }

  /** The converging regime: one dispatch of the selected kernel at this frame's interleave phase. */
  render(
    _renderer: WebGPURenderer,
    _frame: CloudFrame,
    _budget: CloudBudget,
  ): void {}

  /**
   * The immediate regime's k-th dispatch (k = 0…3, Bayer order), at
   * maxSteps/4; the system follows each with the history's immediate kernel
   * (§5.14).
   */
  dispatchPhase(
    _renderer: WebGPURenderer,
    _frame: CloudFrame,
    _k: number,
  ): void {}

  dispose(): void {}
}
