import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  type Node,
  RGBAFormat,
  UnsignedByteType,
} from 'three/webgpu'
import { float, texture, vec2 } from 'three/tsl'
import {
  CLOUD_GENERA,
  genusProfile,
  genusProfileMean,
} from '@inertialref/rendering'

/*
 * Each genus's density over its layer's height: `genusProfile` baked on the
 * CPU into 64 heights × 8 genera, RGBA8, linear, one level, read once a step.
 * Height i holds h01 = i/63, so both ends of a layer are table texels and
 * hold 0, as the profile does, and a read clamped past either end stays 0.
 *
 * G holds the genus's mean over its layer (`genusProfileMean`), constant
 * along the row: the density an unresolved cell stands for (§5.6's p̄), which
 * a step then has from the same fetch as the profile rather than from a
 * branch over the genera.
 */

export const CLOUD_PROFILE_HEIGHTS = 64
/** Seven genera and a spare row of zeros. */
export const CLOUD_PROFILE_ROWS = 8

const LEVEL0 = /*@__PURE__*/ float(0)

/** The table's texels, row by genus, as the GPU reads them: a test's reference too. */
export function cloudProfileTable(): Uint8Array {
  const data = new Uint8Array(CLOUD_PROFILE_HEIGHTS * CLOUD_PROFILE_ROWS * 4)
  CLOUD_GENERA.forEach((genus, row) => {
    const mean = Math.round(255 * genusProfileMean(genus))
    for (let i = 0; i < CLOUD_PROFILE_HEIGHTS; i += 1) {
      const at = (row * CLOUD_PROFILE_HEIGHTS + i) * 4
      data[at] = Math.round(
        255 * genusProfile(genus, i / (CLOUD_PROFILE_HEIGHTS - 1)),
      )
      data[at + 1] = mean
      data[at + 3] = 255
    }
  })
  return data
}

export class CloudProfile {
  readonly texture: DataTexture
  readonly #table: ReturnType<typeof texture>

  constructor() {
    const table = new DataTexture(
      cloudProfileTable(),
      CLOUD_PROFILE_HEIGHTS,
      CLOUD_PROFILE_ROWS,
      RGBAFormat,
      UnsignedByteType,
    )
    // A DataTexture is nearest by default, which the builder reads with a
    // `textureLoad` and no sampler: no interpolation between heights, and
    // not the program the stand-in compiles (rule 56).
    table.magFilter = LinearFilter
    table.minFilter = LinearFilter
    table.wrapS = ClampToEdgeWrapping
    table.wrapT = ClampToEdgeWrapping
    table.generateMipmaps = false
    table.name = 'cloud profile'
    table.needsUpdate = true
    this.texture = table
    this.#table = texture(table)
  }

  /** (profile, the genus's mean) at `h01` of the layer, 0 at its base and 1 at its top. Level 0. */
  sample(genus: Node<'float'>, h01: Node<'float'>): Node<'vec2'> {
    const uv = vec2(
      h01
        .mul(CLOUD_PROFILE_HEIGHTS - 1)
        .add(0.5)
        .div(CLOUD_PROFILE_HEIGHTS),
      genus.add(0.5).div(CLOUD_PROFILE_ROWS),
    )
    return this.#table.sample(uv).level(LEVEL0).xy
  }

  /** The genus's profile at `h01`, 0 at its layer's base and 1 at its top; 0 outside. */
  profile(genus: Node<'float'>, h01: Node<'float'>): Node<'float'> {
    return this.sample(genus, h01).x
  }

  dispose(): void {
    this.texture.dispose()
  }
}
