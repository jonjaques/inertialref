import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  type Node,
  RGBAFormat,
  UnsignedByteType,
} from 'three/webgpu'
import { clamp, float, max, texture, vec2 } from 'three/tsl'
import {
  type LevelSpec,
  levelProfile,
  PROFILE_HEIGHTS,
  PROFILE_ROWS,
} from '@inertialref/rendering'
import type { CloudBodyFrame, CloudFrame } from './cloudFrame.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * Each level's profile, as the CPU field reads it: `levelProfile`'s table of
 * 64 heights by eight rows, RGBA8, for each of a body's three levels and
 * each of the frame's two bodies, 64 × 48 in all, linear, one level. A
 * level's eight rows run from its stratiform genus to its cumuliform one, so
 * one bilinear read at row 7·v blends the profile by the sample's convective
 * share v (phase 1 design §4.3). The texels are the CPU's own bytes, so what
 * the GPU's read and `readLevelProfile` can differ by is the sampler's
 * weights alone.
 *
 * | Channel | Holds                                                         |
 * | ------- | ------------------------------------------------------------- |
 * | R       | The extinction's share of the level's greatest                |
 * | G       | R's mean over the level: the density an unresolved cell holds |
 * | B       | The share of the row's column above the height                |
 * | A       | The effective radius's share of the level's greatest          |
 *
 * The rows are laid out by the body's slot and the level's index, not by the
 * frame's `profileRow`: the slot is the bundle a medium is built over, which
 * a graph knows when it is built, and the frame's derivation does not know
 * which of the two slots a body is drawn in.
 */

export const CLOUD_PROFILE_HEIGHTS = PROFILE_HEIGHTS
/** Rows a level holds: its stratiform genus to its cumuliform one. */
export const CLOUD_PROFILE_LEVEL_ROWS = PROFILE_ROWS
/** Rows a body holds: three levels. */
const BODY_ROWS = 3 * PROFILE_ROWS
/** Two bodies, the served and the second: 48 rows. */
export const CLOUD_PROFILE_ROWS = 2 * BODY_ROWS

const LEVEL0 = /*@__PURE__*/ float(0)

/** The slot a body's rows are in: the served body's first, the second body's after them. */
export type CloudProfileSlot = 0 | 1

/** A body's three levels as specs: the frame's heights and the climate's genera. */
export function bodyLevelSpecs(
  body: CloudBodyFrame,
): readonly [LevelSpec, LevelSpec, LevelSpec] {
  const spec = (k: number): LevelSpec => {
    const level = body.levels[k]!
    const [stratiform, cumuliform] = body.climate.genera[k]!
    return { base: level.base, top: level.top, stratiform, cumuliform }
  }
  return [spec(0), spec(1), spec(2)]
}

const specKey = (spec: LevelSpec): string =>
  `${spec.base}|${spec.top}|${spec.stratiform}|${spec.cumuliform}`

/** The whole table for a pair of bodies' specs, rows by slot then level: what the GPU reads. */
export function cloudProfileTable(
  slots: readonly (readonly LevelSpec[])[],
): Uint8Array {
  const data = new Uint8Array(CLOUD_PROFILE_HEIGHTS * CLOUD_PROFILE_ROWS * 4)
  slots.forEach((specs, slot) => {
    specs.forEach((spec, k) => {
      data.set(
        levelProfile(spec).texels,
        (slot * BODY_ROWS + k * PROFILE_ROWS) * CLOUD_PROFILE_HEIGHTS * 4,
      )
    })
  })
  return data
}

export class CloudProfile {
  readonly texture: DataTexture
  readonly #table: ReturnType<typeof texture>
  readonly #data: Uint8Array
  /** What each slot's level holds: its spec's key, so an unchanged weather uploads nothing. */
  readonly #held: (string | null)[] = [null, null, null, null, null, null]

  constructor() {
    this.#data = new Uint8Array(CLOUD_PROFILE_HEIGHTS * CLOUD_PROFILE_ROWS * 4)
    const table = new DataTexture(
      this.#data,
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

  /**
   * Each body's levels into its rows, where a level's spec moved: the served
   * body's, and the second's or, with none, the served one's again, as the
   * uniform bundle writes the second body's weather.
   */
  write(frame: CloudFrame): void {
    this.writeSpecs(0, bodyLevelSpecs(frame.served))
    this.writeSpecs(1, bodyLevelSpecs(frame.second ?? frame.served))
  }

  /** One slot's three levels: a level whose spec is the one it holds is not copied again. */
  writeSpecs(slot: CloudProfileSlot, specs: readonly LevelSpec[]): void {
    let moved = false
    specs.forEach((spec, k) => {
      const key = specKey(spec)
      const at = slot * 3 + k
      if (this.#held[at] === key) return
      this.#held[at] = key
      this.#data.set(
        levelProfile(spec).texels,
        (slot * BODY_ROWS + k * PROFILE_ROWS) * CLOUD_PROFILE_HEIGHTS * 4,
      )
      moved = true
    })
    if (moved) this.texture.needsUpdate = true
  }

  /**
   * The four channels at `h01` of level `level` (0, 1 or 2) of a slot's
   * body and convective share `v`, each in [0, 1]: one bilinear read, level
   * 0. The height and the share are clamped as `readLevelProfile` clamps
   * them, so a read past either end of a level is its edge texel.
   */
  sample(
    slot: CloudProfileSlot,
    level: Node<'float'>,
    h01: Node<'float'>,
    v: Node<'float'>,
  ): Node<'vec4'> {
    const row = max(level, 0)
      .mul(PROFILE_ROWS)
      .add(clamp(v, 0, 1).mul(PROFILE_ROWS - 1))
      .add(slot * BODY_ROWS)
    const uv = vec2(
      clamp(h01, 0, 1)
        .mul(CLOUD_PROFILE_HEIGHTS - 1)
        .add(0.5)
        .div(CLOUD_PROFILE_HEIGHTS),
      row.add(0.5).div(CLOUD_PROFILE_ROWS),
    )
    return this.#table.sample(uv).level(LEVEL0)
  }

  dispose(): void {
    this.texture.dispose()
  }
}

/** The slot a body bundle's rows are in. */
export function profileSlot(
  uniforms: CloudUniforms,
  body: CloudBodyUniforms,
): CloudProfileSlot {
  return body === uniforms.second ? 1 : 0
}

/*
 * The field's construction hands the maps the uniform bundle and nothing
 * else, and the maps' `write` is the one call a frame makes before any pass
 * that reads the profile. So the profile a bundle's field built is found by
 * the bundle, and written there (`CloudMaps.write`).
 */
const PROFILES = new WeakMap<CloudUniforms, CloudProfile>()

/** The profile built for a uniform bundle by `createCloudProfile`, if any. */
export function profileOf(uniforms: CloudUniforms): CloudProfile | null {
  return PROFILES.get(uniforms) ?? null
}

/**
 * The profile table a field's media read.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change.
 */
export function createCloudProfile(deps: {
  readonly uniforms: CloudUniforms
}): CloudProfile {
  const profile = new CloudProfile()
  PROFILES.set(deps.uniforms, profile)
  return profile
}
