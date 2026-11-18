import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  type Node,
  RGBAFormat,
  type UniformNode,
} from 'three/webgpu'
import { clamp, float, max, texture, uniform, vec2 } from 'three/tsl'
import {
  type LevelSpec,
  levelProfile,
  PROFILE_HEIGHTS,
  PROFILE_ROWS,
  STATISTICS_COVERS,
} from '@inertialref/rendering'
import type { WorkerPool } from '@inertialref/workers'
import type { CloudBodyFrame, CloudFrame } from './cloudFrame.ts'
import {
  STATISTICS_TEXELS,
  statisticsKey,
  statisticsTexels,
} from './cloudStatisticsLayout.ts'
import { cloudStatisticsTask } from './cloudStatisticsTask.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * Each level's profile and statistics, as the CPU field reads them, in one
 * RGBA16F texture of 64 × 96, linear, one level, for each of a body's three
 * levels and each of the frame's two bodies.
 *
 * **Rows 0–47, the profile:** `levelProfile`'s table of 64 heights by eight
 * rows a level. A level's eight rows run from its stratiform genus to its
 * cumuliform one, so one bilinear read at row 7·v blends the profile by the
 * sample's convective share v (phase 1 design §4.3). The texels are the
 * CPU's own bytes over 255, which a half float holds to 2⁻¹²:
 *
 * | Channel | Holds                                                         |
 * | ------- | ------------------------------------------------------------- |
 * | R       | The extinction's share of the level's greatest                |
 * | G       | R's mean over the level: the density an unresolved cell holds |
 * | B       | The share of the row's column above the height                |
 * | A       | The effective radius's share of the level's greatest          |
 *
 * **Rows 48–95, the statistics:** `levelStatistics`, the footprint read's
 * table, eight rows a level as the profile's, the covers along a row
 * (`statisticsTexels`): (fraction, depth, shape, sight in cells) at texel
 * i, the gain and the cloudy columns' mean depth at texel 17 + i. Read
 * linearly in cover and row, as `readLevelStatistics` reads them.
 *
 * In the profile's texture and not one of their own: the trace binds 10 of
 * WebGPU's 16 sampled textures and its census holds that, and a statistic is
 * read where the profile already is.
 *
 * **A table is the field's, and it is built off the frame's path.** It
 * costs half a second to a second a level (`cloudStatisticsTask.ts`), so it
 * is asked of the pool, and a body whose tables are not all in draws
 * nothing (`ready`): no frame draws from a table that is not its level's.
 * When the last lands, `generation` moves, and the caches baked from the
 * field start over (`CloudMaps`).
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
/** Two bodies, the served and the second: 48 rows of profile. */
const PROFILE_TABLE_ROWS = 2 * BODY_ROWS
/** And as many of statistics under them. */
export const CLOUD_PROFILE_ROWS = 2 * PROFILE_TABLE_ROWS
/** RGBA16F. */
export const CLOUD_PROFILE_BYTES =
  CLOUD_PROFILE_HEIGHTS * CLOUD_PROFILE_ROWS * 8

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

/** A level with no thickness holds nothing, and its table is all zeros: nothing to build. */
const absent = (spec: LevelSpec): boolean => !(spec.top > spec.base)

/*
 * Every table built in this thread, from the pool or here, kept by its
 * level's members: a session visits few levels, and the same level on two
 * bodies, or again after a change of weather, is built once. The bound only
 * keeps a long session's map from growing; a table dropped is asked again.
 */
const TABLES = new Map<string, Float32Array>()
const TABLES_HELD = 256

function keep(key: string, texels: Float32Array): void {
  if (TABLES.size >= TABLES_HELD) TABLES.clear()
  TABLES.set(key, texels)
}

/** A level's statistics: what a step that reads them, or a crossing, takes. */
export interface CloudStatisticsNodes {
  readonly fraction: Node<'float'>
  readonly depth: Node<'float'>
  readonly shape: Node<'float'>
  /** In cells: the level's cell makes it meters. */
  readonly sightCells: Node<'float'>
}

export class CloudProfile {
  readonly texture: DataTexture
  /** 1 where every table of the slot's levels is in, 0 while one is owed. */
  readonly ready: readonly [
    UniformNode<'float', number>,
    UniformNode<'float', number>,
  ] = [uniform(0), uniform(0)]
  /**
   * The pool tables are built on. Without one, as a test's rig or an engine
   * built with `workers: null` has, a table is built here, inside the call
   * that first needs it.
   */
  pool: WorkerPool | null = null
  readonly #table: ReturnType<typeof texture>
  readonly #data: Uint16Array
  /** What each slot's level holds: its spec's key, so an unchanged weather uploads nothing. */
  readonly #held: (string | null)[] = [null, null, null, null, null, null]
  /** The key whose table each slot's level holds in its statistics rows. */
  readonly #tables: (string | null)[] = [null, null, null, null, null, null]
  /** Keys asked of the pool and not yet answered, and the pool they were asked of. */
  readonly #asked = new Set<string>()
  #askedOf: WorkerPool | null = null
  #generation = 0
  #disposed = false
  /** The last built tables' wall times, milliseconds: a readout. */
  readonly builds: number[] = []

  constructor() {
    this.#data = new Uint16Array(CLOUD_PROFILE_HEIGHTS * CLOUD_PROFILE_ROWS * 4)
    const table = new DataTexture(
      this.#data,
      CLOUD_PROFILE_HEIGHTS,
      CLOUD_PROFILE_ROWS,
      RGBAFormat,
      HalfFloatType,
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

  /** Moves each time a table lands: a cache baked from the field before it holds another field. */
  get generation(): number {
    return this.#generation
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
    if (this.#disposed) return
    let moved = false
    specs.forEach((spec, k) => {
      const key = statisticsKey(spec)
      const at = slot * 3 + k
      if (this.#held[at] !== key) {
        this.#held[at] = key
        this.#set(
          (slot * BODY_ROWS + k * PROFILE_ROWS) * CLOUD_PROFILE_HEIGHTS * 4,
          levelProfile(spec).texels,
          1 / 255,
        )
        moved = true
      }
      if (this.#tables[at] !== key) moved = this.#fill(slot, k, spec) || moved
    })
    const ready = specs.every(
      (spec, k) => this.#tables[slot * 3 + k] === statisticsKey(spec),
    )
    const flag = this.ready[slot]
    if (flag.value !== (ready ? 1 : 0)) flag.value = ready ? 1 : 0
    if (moved) this.texture.needsUpdate = true
  }

  /** A level's statistics rows from its table, if the table is in; otherwise asks for it. */
  #fill(slot: CloudProfileSlot, k: number, spec: LevelSpec): boolean {
    const key = statisticsKey(spec)
    const at = slot * 3 + k
    let texels = absent(spec) ? ZEROS : TABLES.get(key)
    if (texels === undefined) {
      if (this.pool === null) {
        const start = performance.now()
        texels = statisticsTexels(spec)
        this.builds.push(performance.now() - start)
        keep(key, texels)
      } else {
        this.#ask(spec, key)
        return false
      }
    }
    this.#tables[at] = key
    this.#writeTable(slot, k, texels)
    this.#generation += 1
    return true
  }

  #ask(spec: LevelSpec, key: string): void {
    if (this.pool === null) return
    // Another pool has none of the asks the last one held: ask it again.
    if (this.#askedOf !== this.pool) {
      this.#asked.clear()
      this.#askedOf = this.pool
    }
    if (this.#asked.has(key)) return
    // The `try` is around `submit` alone, for `atmosphereLuts.ts`'s reason:
    // a terminated pool throws there, inside a frame. The level then draws
    // nothing, and the next frame asks again.
    let result: Promise<{
      readonly key: string
      readonly texels: Float32Array
      readonly milliseconds: number
    }>
    try {
      result = this.pool.submit(cloudStatisticsTask, { spec }).result
    } catch {
      return
    }
    this.#asked.add(key)
    void result
      .then((answer) => {
        keep(answer.key, answer.texels)
        this.builds.push(answer.milliseconds)
      })
      .catch(() => {
        // A pool gone away: the next frame asks again.
      })
      .finally(() => {
        this.#asked.delete(key)
      })
  }

  #writeTable(slot: CloudProfileSlot, k: number, texels: Float32Array): void {
    for (let row = 0; row < PROFILE_ROWS; row += 1)
      this.#set(
        (PROFILE_TABLE_ROWS + slot * BODY_ROWS + k * PROFILE_ROWS + row) *
          CLOUD_PROFILE_HEIGHTS *
          4,
        texels.subarray(
          row * STATISTICS_TEXELS * 4,
          (row + 1) * STATISTICS_TEXELS * 4,
        ),
        1,
      )
  }

  #set(at: number, values: ArrayLike<number>, scale: number): void {
    for (let n = 0; n < values.length; n += 1)
      this.#data[at + n] = DataUtils.toHalfFloat(values[n]! * scale)
  }

  /** A row's texture coordinate, at its center. */
  #row(row: Node<'float'>): Node<'float'> {
    return row.add(0.5).div(CLOUD_PROFILE_ROWS)
  }

  /** A slot's level's first row of the given block, plus the convective share's 7·v. */
  #rowOf(
    first: number,
    slot: CloudProfileSlot,
    level: Node<'float'>,
    v: Node<'float'>,
  ): Node<'float'> {
    return max(level, 0)
      .mul(PROFILE_ROWS)
      .add(clamp(v, 0, 1).mul(PROFILE_ROWS - 1))
      .add(first + slot * BODY_ROWS)
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
    const uv = vec2(
      clamp(h01, 0, 1)
        .mul(CLOUD_PROFILE_HEIGHTS - 1)
        .add(0.5)
        .div(CLOUD_PROFILE_HEIGHTS),
      this.#row(this.#rowOf(0, slot, level, v)),
    )
    return this.#table.sample(uv).level(LEVEL0)
  }

  /** The statistics texel `first` of a cover's at a slot's level, cover and convective share: one bilinear read. */
  #statistic(
    first: number,
    slot: CloudProfileSlot,
    level: Node<'float'>,
    cover: Node<'float'>,
    v: Node<'float'>,
  ): Node<'vec4'> {
    const uv = vec2(
      clamp(cover, 0, 1)
        .mul(STATISTICS_COVERS - 1)
        .add(first + 0.5)
        .div(CLOUD_PROFILE_HEIGHTS),
      this.#row(this.#rowOf(PROFILE_TABLE_ROWS, slot, level, v)),
    )
    return this.#table.sample(uv).level(LEVEL0)
  }

  /** A level's fraction, depth, shape and sight at a cover and convective share: one read. */
  statistics(
    slot: CloudProfileSlot,
    level: Node<'float'>,
    cover: Node<'float'>,
    v: Node<'float'>,
  ): CloudStatisticsNodes {
    const read = this.#statistic(0, slot, level, cover, v)
    return {
      fraction: read.x,
      depth: read.y,
      shape: read.z,
      sightCells: read.w,
    }
  }

  /**
   * The mean scaled depth of a level's cloudy columns at a cover and
   * convective share, the level's and no place's (`LevelStatistics.mean`):
   * one read, the gain's texel.
   */
  mean(
    slot: CloudProfileSlot,
    level: Node<'float'>,
    cover: Node<'float'>,
    v: Node<'float'>,
  ): Node<'float'> {
    return this.#statistic(STATISTICS_COVERS, slot, level, cover, v).y
  }

  /** A level's gain at a cover and convective share: one read. */
  gain(
    slot: CloudProfileSlot,
    level: Node<'float'>,
    cover: Node<'float'>,
    v: Node<'float'>,
  ): Node<'float'> {
    return this.#statistic(STATISTICS_COVERS, slot, level, cover, v).x
  }

  dispose(): void {
    this.#disposed = true
    this.texture.dispose()
  }
}

const ZEROS = new Float32Array(PROFILE_ROWS * STATISTICS_TEXELS * 4)

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
