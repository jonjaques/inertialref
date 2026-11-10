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
import {
  atan,
  clamp,
  float,
  log2,
  select,
  sqrt,
  texture,
  vec2,
} from 'three/tsl'
import {
  type IceTable,
  iceAggregate,
  type MieTable,
  mieDroplets,
  PHASE_ATLAS,
  phaseAtlas,
  textureBytes,
} from '@inertialref/rendering'
import type { CloudPhaseNodes, CloudResource } from './cloudNodes.ts'
import type { CloudLayerUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The phase atlas on the GPU (phase 1 design §4.4): one texel an angle
 * across, one row a radius down, RGBA16F, linear, clamped and with no mips.
 * Rows 0–31 are the droplets, 32–54 the ice, 55–63 held for rain and dust;
 * RGB is the phase per band convolved with the served sun's disk, and A the
 * row's gain, 1/(1 − f_δ).
 *
 * The read is `sampleAtlas`'s bilinear lookup, which `cloudLight.gpu.test.ts`
 * holds it to: the angle's continuous texel index and the row land on texel
 * centers, and the sampler's linear filter does the rest. The table holds
 * the phase at θ_i = (π/2)(1 − cos(π·i/(n − 1))), so the index is
 * (n − 1)·φ/π with cos φ = 1 − 2θ/π. Both ends carry the structure — the
 * forward peak, and the glory's rings at the antisolar point — and both are
 * where `acos` loses: θ = acos(ν) near ν = −1, then acos(1 − 2θ/π) of a
 * number within a float32 step of −1, each a square root's worth of error at
 * the one end of the axis the table spends its densest texels on. So φ is
 * 2·atan2(√θ, √(π − θ)), and θ and π − θ are each an `atan2` of √(1 ∓ ν):
 * nothing subtracts two numbers near each other at either end.
 *
 * The atlas is built under a point sun and convolved when `serve` is told
 * the served sun's angular radius. Until the frame carries that radius, a
 * system's atlas is the tables as generated, and `droplets`, the bridge the
 * march reads, draws phase 0's picture from its rows bit for bit: a row's
 * texture coordinate is (row + ½)/64 where it was (row + ½)/32, and a power
 * of two scales a float exactly, so the sampler lands where it landed.
 */

/** RGBA16F: four half floats a texel. */
const TEXEL_BYTES = 8
/**
 * The served sun's angular radius moves the atlas when it has moved this
 * share since the atlas was convolved (§4.7). The glory's first ring is
 * 0.6° out at the largest droplets and the disk is 0.27° from Earth, so a
 * 1% move is 0.003°, a tenth of the finest texel the ring falls on.
 */
const RECONVOLVE = 0.01

/** A level's component of a per-level vector: x, y or z. */
function component(v: Node<'vec3'>, level: number): Node<'float'> {
  return level === 0 ? v.x : level === 1 ? v.y : v.z
}

export class CloudPhase implements CloudResource, CloudPhaseNodes {
  readonly name = 'phase'
  readonly pending = false
  readonly #droplets: MieTable
  readonly #ice: IceTable
  readonly #data: Uint16Array
  readonly #map: DataTexture
  readonly #node: TextureNode
  /** Radians: the disk the atlas holds now. */
  #angularRadius = 0
  /** Uploaded: a warm-up has put the atlas on the device. */
  #allocated = false
  #disposed = false

  constructor(droplets: MieTable, ice: IceTable) {
    this.#droplets = droplets
    this.#ice = ice
    this.#data = new Uint16Array(droplets.angles * PHASE_ATLAS.rows * 4)
    // [row][angle]: row j of the data is row j of the texture, at v = (j + ½)/64.
    const map = new DataTexture(
      this.#data,
      droplets.angles,
      PHASE_ATLAS.rows,
      RGBAFormat,
      HalfFloatType,
    )
    map.magFilter = LinearFilter
    map.minFilter = LinearFilter
    map.wrapS = ClampToEdgeWrapping
    map.wrapT = ClampToEdgeWrapping
    map.generateMipmaps = false
    map.name = 'cloud phase'
    this.#map = map
    this.#fill(0)
    this.#node = texture(map)
  }

  /** The atlas's texels convolved with a disk of `angularRadius`, radians, as halves, marked for upload. */
  #fill(angularRadius: number): void {
    const { texels } = phaseAtlas(this.#droplets, this.#ice, angularRadius)
    for (let k = 0; k < texels.length; k += 1)
      this.#data[k] = DataUtils.toHalfFloat(texels[k]!)
    this.#angularRadius = angularRadius
    this.#map.needsUpdate = true
  }

  /**
   * The served sun's angular radius, radians: the atlas is convolved again,
   * and uploaded on its next read, when the radius has moved 1% since it was
   * last convolved. True when it was. The second body reads the served
   * body's atlas, declared (§5.4).
   */
  serve(angularRadius: number): boolean {
    if (this.#disposed) return false
    const held = this.#angularRadius
    if (Math.abs(angularRadius - held) <= RECONVOLVE * held) return false
    this.#fill(angularRadius)
    return true
  }

  /** Radians: the sun's angular radius the atlas is convolved with, 0 for a point sun. */
  get angularRadius(): number {
    return this.#angularRadius
  }

  /** The atlas's u at cos θ = nu. */
  #across(nu: Node<'float'>): Node<'float'> {
    const { angles } = this.#droplets
    const cosine = clamp(nu, -1, 1)
    const below = sqrt(float(1).sub(cosine))
    const above = sqrt(float(1).add(cosine))
    // θ and π − θ, each from the side of ν it is small on.
    const theta = atan(below, above).mul(2)
    const opposite = atan(above, below).mul(2)
    const phi = atan(sqrt(theta), sqrt(opposite)).mul(2)
    return phi
      .mul((angles - 1) / Math.PI)
      .add(0.5)
      .div(angles)
  }

  /** The atlas at u and a row, rgba. */
  #read(u: Node<'float'>, row: Node<'float'>): Node<'vec4'> {
    return this.#node
      .sample(vec2(u, row.add(0.5).div(PHASE_ATLAS.rows)))
      .level(float(0))
  }

  /**
   * Droplet phase per band, sr⁻¹, at cos θ = nu, for an effective radius in
   * µm: the droplets' rows at a gain of one. The bridge the march and the
   * far atlas read until they read `phase`.
   */
  droplets(nu: Node<'float'>, radius: Node<'float'>): Node<'vec3'> {
    const { radii, radiusMin, radiusMax } = this.#droplets
    const row = clamp(
      log2(radius.div(radiusMin)).mul(
        (radii - 1) / Math.log2(radiusMax / radiusMin),
      ),
      0,
      radii - 1,
    )
    return this.#read(this.#across(nu), row.add(PHASE_ATLAS.dropletRow)).rgb
  }

  /**
   * First-order phase per band, sr⁻¹, in rgb, and the row's gain,
   * 1/(1 − f_δ), in a, at cos θ = nu, for a level's class at an effective
   * radius, µm.
   *
   * The level's class is its first row: a level whose rows start at the
   * ice's reads them linearly in diameter, (2r − 2r₀)/Δd, and any other
   * reads the droplets' logarithm, log2(r/r₀)·(rows − 1)/log2(r₁/r₀), with r₀
   * the level's first radius. The row is clamped inside the level's rows,
   * so a bilinear fetch at a class's last row weighs the next class's first
   * by zero and never blends droplets with ice.
   */
  phase(
    nu: Node<'float'>,
    layers: CloudLayerUniforms,
    level: number,
    radius: Node<'float'>,
  ): Node<'vec4'> {
    const { radii, radiusMin, radiusMax } = this.#droplets
    const first = component(layers.phaseRow, level)
    const rows = component(layers.phaseRows, level)
    const least = component(layers.phaseRadius, level)
    const logarithmic = log2(radius.div(least)).mul(
      (radii - 1) / Math.log2(radiusMax / radiusMin),
    )
    const linear = radius.sub(least).mul(2 / this.#ice.diameterStep)
    const ice = first.greaterThanEqual(PHASE_ATLAS.iceRow - 0.5)
    const local = clamp(select(ice, linear, logarithmic), 0, rows.sub(1))
    return this.#read(this.#across(nu), first.add(local))
  }

  /** The atlas's texture: what a census lists once it is on the device. */
  get texture(): Texture {
    return this.#map
  }

  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    return textureBytes(this.#droplets.angles, PHASE_ATLAS.rows, 1, TEXEL_BYTES)
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated ? [] : [this.#map]
  }

  /**
   * Puts the atlas on the device ahead of the first ray that reads it; it
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

  /** The atlas is uploaded when it is convolved and draws nothing a frame. */
  render(): void {}

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#map.dispose()
  }
}

/**
 * The phase a field's light reads: the committed droplet and ice tables,
 * under a point sun until `serve` names the served sun's disk.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change.
 */
export function createCloudPhase(_deps: {
  readonly uniforms: CloudUniforms
}): CloudPhase {
  return new CloudPhase(mieDroplets(), iceAggregate())
}
