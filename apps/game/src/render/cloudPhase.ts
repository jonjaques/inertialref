import type { Node, Texture } from 'three/webgpu'
import type { MieTable } from '@inertialref/rendering'
import {
  CLOUD_STAND_INS,
  type CloudPhaseNodes,
  type CloudResource,
} from './cloudNodes.ts'

/*
 * The droplets' Lorenz–Mie table on the GPU: 1024 angles × 32 radii,
 * RGBA16F with RGB the air's three bands, linear and with no mips, read once
 * a ray at its mean radius (§5.10's shortcut).
 *
 * Neutral here: isotropic, read through a 1 × 1 stand-in of the table's
 * format.
 */
export class CloudPhase implements CloudResource, CloudPhaseNodes {
  readonly name = 'phase'
  readonly bytes = 0
  readonly pending = false
  readonly #standIn = CLOUD_STAND_INS.phase()

  constructor(_table: MieTable) {}

  /** Droplet phase per band, sr⁻¹, at cos θ = nu, for an effective radius in µm. */
  droplets(nu: Node<'float'>, radius: Node<'float'>): Node<'vec3'> {
    return this.#standIn.droplets(nu, radius)
  }

  textures(): readonly Texture[] {
    return []
  }

  warm(): Promise<void> {
    return Promise.resolve()
  }

  render(): void {}

  dispose(): void {}
}
