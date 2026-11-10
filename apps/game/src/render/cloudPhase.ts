import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  type Node,
  RGBAFormat,
  type Texture,
  type TextureNode,
  type WebGPURenderer,
} from 'three/webgpu'
import { atan, clamp, float, log2, sqrt, texture, vec2, vec4 } from 'three/tsl'
import {
  type MieTable,
  mieDroplets,
  textureBytes,
} from '@inertialref/rendering'
import type { CloudPhaseNodes, CloudResource } from './cloudNodes.ts'
import type { CloudLayerUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The droplets' Lorenz–Mie table on the GPU: one texel an angle across, one
 * row a radius down, RGBA16F with RGB the air's three bands — 1024 × 32 for
 * the generated table — linear, clamped and with no mips, read once a ray at
 * its mean radius (§5.10's shortcut).
 *
 * The read is `samplePhase`'s bilinear lookup, which `cloudLight.gpu.test.ts`
 * holds it to: the angle's continuous texel index and the radius's
 * continuous row land on texel centers, and the sampler's linear filter does
 * the rest. The table holds the phase at θ_i = (π/2)(1 − cos(π·i/(n − 1))),
 * so the index is (n − 1)·φ/π with cos φ = 1 − 2θ/π. Both ends carry the
 * structure — the forward peak, and the glory's rings at the antisolar
 * point — and both are where `acos` loses: θ = acos(ν) near ν = −1, then
 * acos(1 − 2θ/π) of a number within a float32 step of −1, each a square
 * root's worth of error at the one end of the axis the table spends its
 * densest texels on. So φ is 2·atan2(√θ, √(π − θ)), and θ and π − θ are
 * each an `atan2` of √(1 ∓ ν): nothing subtracts two numbers near each
 * other at either end.
 */

/** RGBA16F: four half floats a texel. */
const TEXEL_BYTES = 8
/** A half float's 1. */
const HALF_ONE = 0x3c00

export class CloudPhase implements CloudResource, CloudPhaseNodes {
  readonly name = 'phase'
  readonly pending = false
  readonly #table: MieTable
  readonly #map: DataTexture
  readonly #node: TextureNode
  /** Uploaded: a warm-up has put the table on the device. */
  #allocated = false
  #disposed = false

  constructor(table: MieTable) {
    this.#table = table
    const { angles, radii, phase } = table
    const data = new Uint16Array(angles * radii * 4)
    for (let k = 0; k < angles * radii; k += 1) {
      for (let band = 0; band < 3; band += 1)
        data[k * 4 + band] = DataUtils.toHalfFloat(phase[k * 3 + band]!)
      data[k * 4 + 3] = HALF_ONE
    }
    // [row][angle]: row j of the data is row j of the texture, at v = (j + ½)/radii.
    const map = new DataTexture(data, angles, radii, RGBAFormat, HalfFloatType)
    map.magFilter = LinearFilter
    map.minFilter = LinearFilter
    map.wrapS = ClampToEdgeWrapping
    map.wrapT = ClampToEdgeWrapping
    map.generateMipmaps = false
    map.name = 'cloud phase'
    map.needsUpdate = true
    this.#map = map
    this.#node = texture(map)
  }

  /** Droplet phase per band, sr⁻¹, at cos θ = nu, for an effective radius in µm. */
  droplets(nu: Node<'float'>, radius: Node<'float'>): Node<'vec3'> {
    const { angles, radii, radiusMin, radiusMax } = this.#table
    const cosine = clamp(nu, -1, 1)
    const below = sqrt(float(1).sub(cosine))
    const above = sqrt(float(1).add(cosine))
    // θ and π − θ, each from the side of ν it is small on.
    const theta = atan(below, above).mul(2)
    const opposite = atan(above, below).mul(2)
    const phi = atan(sqrt(theta), sqrt(opposite)).mul(2)
    const angle = phi.mul((angles - 1) / Math.PI)
    const row = clamp(
      log2(radius.div(radiusMin)).mul(
        (radii - 1) / Math.log2(radiusMax / radiusMin),
      ),
      0,
      radii - 1,
    )
    const uv = vec2(angle.add(0.5).div(angles), row.add(0.5).div(radii))
    return this.#node.sample(uv).level(float(0)).rgb
  }

  /**
   * First-order phase per band in rgb and the row's gain in a, for a level's
   * class. Every level is droplets at the radius asked for, at a gain of
   * one: a medium with no diffraction taken out of it.
   */
  phase(
    nu: Node<'float'>,
    _layers: CloudLayerUniforms,
    _level: number,
    radius: Node<'float'>,
  ): Node<'vec4'> {
    return vec4(this.droplets(nu, radius), 1)
  }

  /** The table's texture: what a census lists once it is on the device. */
  get texture(): Texture {
    return this.#map
  }

  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    return textureBytes(this.#table.angles, this.#table.radii, 1, TEXEL_BYTES)
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated ? [] : [this.#map]
  }

  /**
   * Puts the table on the device ahead of the first ray that reads it; it
   * draws nothing, so there is no pipeline of its own to build. A renderer
   * with no backend has no device to put it on.
   */
  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed || renderer?.backend === undefined)
      return Promise.resolve()
    renderer.initTexture(this.#map)
    this.#allocated = true
    return Promise.resolve()
  }

  /** The table is uploaded once and never redrawn. */
  render(): void {}

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#map.dispose()
  }
}

/**
 * The phase a field's light reads: the committed droplet table.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change.
 */
export function createCloudPhase(_deps: {
  readonly uniforms: CloudUniforms
}): CloudPhase {
  return new CloudPhase(mieDroplets())
}
