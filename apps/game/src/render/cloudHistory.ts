import type { StorageTexture, Texture, WebGPURenderer } from 'three/webgpu'
import type { Extent } from '@inertialref/rendering'
import type { CloudFrame } from './cloudFrame.ts'
import {
  type CloudBudget,
  type CloudResource,
  cloudStorageTexture,
} from './cloudNodes.ts'
import type { CloudTraceTextures } from './cloudTrace.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * The history: the trace's quarter-resolution samples accumulated at half
 * resolution, a stride-2 interleave in Bayer order, reprojected in
 * body-fixed axes with the wind applied first, clipped to the current
 * neighborhood's variance and guarded against NaN on both ends (§5.14). Four
 * kernels, each named `cloud history`: a converging kernel and an immediate
 * one into each parity.
 *
 * Neutral here: three storage textures of the real format at 1 × 1, and no
 * dispatch.
 */

export interface CloudHistoryTextures {
  /** (L_c.rgb, T_c). */
  readonly light: StorageTexture
  /** (B.rgb, d_reproj km). */
  readonly air: StorageTexture
  /** (d_end km, d_front km, deviation km, age frames). */
  readonly depth: StorageTexture
  readonly extent: Extent
}

export class CloudHistory implements CloudResource {
  readonly name = 'history'
  readonly bytes = 0
  readonly pending = false
  /**
   * The newest history: what the composite and the next frame read.
   * `outputs` and not `textures`, which every resource answers with what it
   * holds for the census.
   */
  readonly outputs: CloudHistoryTextures
  readonly report: {
    readonly resets: number
    readonly sinceReset: number
    readonly phase: number
    readonly rejected: number | null
  } = { resets: 0, sinceReset: 0, phase: 0, rejected: null }

  constructor(_uniforms: CloudUniforms, _trace: () => CloudTraceTextures) {
    this.outputs = {
      light: cloudStorageTexture(1, 1, 'rgba16float', 'cloud history light'),
      air: cloudStorageTexture(1, 1, 'rgba16float', 'cloud history air'),
      depth: cloudStorageTexture(1, 1, 'rgba16float', 'cloud history depth'),
      extent: { width: 1, height: 1 },
    }
  }

  textures(): readonly Texture[] {
    return []
  }

  warm(): Promise<void> {
    return Promise.resolve()
  }

  /** The converging regime: reproject, reject, clip and blend into the other parity. */
  render(
    _renderer: WebGPURenderer,
    _frame: CloudFrame,
    _budget: CloudBudget,
  ): void {}

  /**
   * The immediate regime: write phase k's pixels of the newest parity from
   * the trace, age 0, and nothing else. After k = 3 every pixel is this
   * frame's.
   */
  renderImmediate(
    _renderer: WebGPURenderer,
    _frame: CloudFrame,
    _k: number,
  ): void {}

  reset(): void {}

  dispose(): void {}
}
