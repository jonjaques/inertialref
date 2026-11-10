import { getLogger } from '@inertialref/shared'
import {
  LinearFilter,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  RepeatWrapping,
  HalfFloatType,
  type Texture,
  type TextureNode,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  clamp,
  float,
  floor,
  int,
  max,
  mix,
  mrt,
  normalize,
  screenCoordinate,
  select,
  smoothstep,
  texture,
  vec2,
  vec4,
} from 'three/tsl'
import {
  cubeFaceOf,
  type CubeFace,
  type LevelFrame,
  MESOSCALE_GRADIENT,
  WEATHER_AXIAL_DRIFT,
} from '@inertialref/rendering'
import { CLOUD_CLIPMAP_SIZE, type CloudFrame } from './cloudFrame.ts'
import { levelOffset, levelPlane, levelTexel } from './cloudGeometry.ts'
import type { CloudMapNodes } from './cloudMaps.ts'
import type { CloudBudget, CloudResource, CloudSample } from './cloudNodes.ts'
import { mesoscaleNode, mesoscaleRateNode } from './cloudNoise.ts'
import {
  CLOUD_CLIPMAP_LEVELS,
  type CloudBodyUniforms,
  type CloudLevelUniforms,
  type CloudUniforms,
} from './cloudUniforms.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmSensorPass } from './warmup.ts'

/*
 * What the fine march reads a step: six eye-anchored levels of 256² texels,
 * 250 m × 2^k, each a layer a cloud level, in a toroidally addressed 2D array
 * of two targets baked from the cube in the strips the window's move
 * exposes. A texel of cloud level j holds what a step in that level reads
 * of its column, in one fetch of each target:
 *
 *   texel  RGBA16F: the mesoscale displacement at the level's middle height,
 *          meters in its turned frame, and the level's cover
 *   rise   RGBA8: the convective share, and the displacement's rate with
 *          height, ±0.7 about ½
 *
 * **The displacement is carried, not evaluated a step.** `weatherField.ts`
 * reads each level's noise at `p′ + Σ a·cell·push·sin(k·p′)`: six sines, which
 * the march's inner loop does not pay. The waves are 17 cells and longer and
 * steepen the displacement by 0.66 at most, so across a texel it is all but
 * linear, and over a level's height it is its value at the middle plus a
 * rate: the second-order term is under `½·0.11·Σk·(h/2)²`, 27 m over a
 * 1.9 km level at a 1,200 m cell, against the 75 m of a base texel. A column
 * the march already fetches carries both, so a step adds no read, no binding
 * and no transcendental.
 *
 * **Its pace is its source's.** The climate is the cube's, resampled, so a
 * level is redrawn when a face it reads is. The displacement turns with its
 * level, so a level is redrawn too when its levels have turned far enough
 * to move it by a 32nd of a cell (`displacementDrift`). Either way an eighth
 * a frame. A level is fresh when it was baked from faces of the field's
 * present generation: one rebuilt from a face not yet rebaked after a jump
 * stays pending and is rebuilt when the face is.
 *
 * **A level is read eye-relatively** (rule 58): a sample's plane coordinate
 * is the eye's, formed on the CPU in float64, plus a difference formed from
 * the offset (`levelPlane`), and the bake inverts the same projection at its
 * texel centers, so the two agree by construction.
 *
 * **Every texel is a function of its lattice coordinate alone.** Texel
 * (i, j) of a level is stored at (i mod 256, j mod 256) and holds the cube at
 * the direction of its own center under the level's anchor, which holds
 * still until the level is rebuilt whole; so the strips a move exposes are
 * drawn from the same arithmetic a full bake uses, and a strip update is
 * that bake, texel for texel.
 */

const log = getLogger('game.clouds')

/** The bake's pass on the timeline: a whole level, a strip or a refresh slice, each one quad. */
export const CLOUD_CLIPMAP_LABEL = 'cloud clipmap'

const CHANNELS = ['cloudClipmapTexel', 'cloudClipmapRise'] as const
/** An RGBA16F and an RGBA8 target: 12 bytes a texel. */
const TEXEL_BYTES = 12
/** Cloud levels: the array holds a layer of each a clipmap level. */
const CLOUD_LEVELS = 3
const LAYERS = CLOUD_CLIPMAP_LEVELS * CLOUD_LEVELS
/** The rise's encoding, ± this about ½: over the six waves' 0.66 at most. */
const RISE_SPAN = 0.7
/** Rows a time refresh redraws: an eighth of a level. */
const REFRESH_ROWS = CLOUD_CLIPMAP_SIZE / 8
/** Directions a side of a level's window its faces are found from (`levelFaces`). */
const FACE_SAMPLES = 17

/*
 * A level holds a sample whose texel coordinate lies within `REACH` of its
 * window's center on both axes: a bilinear read there takes texels from
 * origin to origin + 255 and never wraps onto the window's far side, with
 * half a texel to spare. Its outer fifth fades into the next level, so the
 * band where a level ends reads both.
 */
const HALF = CLOUD_CLIPMAP_SIZE / 2
const REACH = HALF - 1
const FADE = 0.8 * HALF

const LEVEL0 = /*@__PURE__*/ float(0)

/** What a step of a cloud level reads of its column. */
export interface CloudClipmapColumn {
  readonly cover: Node<'float'>
  readonly convective: Node<'float'>
  /** The mesoscale displacement at the level's middle height, meters, in its turned frame. */
  readonly displacement: Node<'vec3'>
  /** Its rate with height, meters a meter. */
  readonly rise: Node<'vec3'>
}

export interface CloudClipmapNodes {
  /**
   * Cloud level `level`'s column at the sample (0, 1 or 2; read as 0
   * outside every level), from the finest clipmap level whose window holds
   * it, faded over the outer fifth into the next (the fade band reads both).
   * Level 0.
   */
  column(
    sample: CloudSample,
    body: CloudBodyUniforms,
    level: Node<'int'>,
  ): CloudClipmapColumn
  /** The texel size of the clipmap level a sample reads: the column a segment may span. */
  columnMeters(sample: CloudSample, body: CloudBodyUniforms): Node<'float'>
}

/** Which level a sample reads, and how far into its fade band it is. */
interface Pick {
  /** The level's texel coordinates, and the next level's. */
  readonly coordinates: Node<'vec4'>
  /** (the next level's weight, the level's texel in meters). */
  readonly blend: Node<'vec2'>
  readonly layer: Node<'int'>
}

/**
 * A level's continuous texel coordinates of an eye-relative offset: texel
 * (i, j) covers [i, i + 1) × [j, j + 1), and divided by the window's size
 * this is the uv a repeat-wrapped read takes. Every clipmap read is made
 * here.
 */
export function clipmapTexel(
  level: CloudLevelUniforms,
  offset: Node<'vec3'>,
  body: CloudBodyUniforms,
): Node<'vec2'> {
  return levelTexel(level, levelPlane(level, offset, body))
}

/** A level's texel coordinates of an offset, and how far from its window's center. */
function locate(
  level: CloudLevelUniforms,
  offset: Node<'vec3'>,
  body: CloudBodyUniforms,
): { readonly at: Node<'vec2'>; readonly reach: Node<'float'> } {
  const at = clipmapTexel(level, offset, body)
  const off = abs(at.sub(level.origin.add(HALF)))
  return { at, reach: max(off.x, off.y) }
}

/**
 * The finest level whose window holds the sample, from the coarsest down so
 * the last level that holds it wins. Past the coarsest there is no level,
 * and the coverage fades to none over that level's own band.
 */
function pick(sample: CloudSample, body: CloudBodyUniforms): Pick {
  const levels = body.clipmap.slice(0, CLOUD_CLIPMAP_LEVELS)
  const located = levels.map((level) => locate(level, sample.offset, body))
  const coarsest = located.length - 1
  let coordinates: Node<'vec4'> = vec4(located[coarsest]!.at, 0, 0)
  let blend: Node<'vec2'> = vec2(1, levels[coarsest]!.texel)
  let layer: Node<'int'> = int(coarsest)
  for (let k = coarsest; k >= 0; k -= 1) {
    const { at, reach } = located[k]!
    const holds = reach.lessThan(REACH)
    const next = located[Math.min(k + 1, coarsest)]!.at
    coordinates = select(holds, vec4(at, next), coordinates)
    blend = select(
      holds,
      vec2(smoothstep(FADE, REACH, reach), levels[k]!.texel),
      blend,
    )
    layer = select(holds, int(k), layer)
  }
  return { coordinates, blend, layer }
}

function readLevel(
  map: TextureNode,
  at: Node<'vec2'>,
  layer: Node<'int'>,
): Node<'vec4'> {
  return vec4(map.sample(at.div(CLOUD_CLIPMAP_SIZE)).depth(layer).level(LEVEL0))
}

export class CloudClipmap implements CloudResource {
  readonly name = 'clipmap'
  readonly nodes: CloudClipmapNodes

  /** 1 × 1 × 18 until a frame draws: the format is the pipeline's, not the size. */
  readonly #target = new RenderTarget(1, 1, {
    depth: LAYERS,
    count: CHANNELS.length,
    type: HalfFloatType,
    depthBuffer: false,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
  })
  /** One bake a layer, clipmap level k's cloud level j at 3k + j, each reading its own uniforms. */
  readonly #materials: readonly NodeMaterial[]
  readonly #quad = new QuadMesh()
  #allocated: 'none' | 'stand-in' | 'full' = 'none'
  /** The render a level went stale on, or null while it is whole. */
  readonly #staleSince: (number | null)[] = Array.from(
    { length: CLOUD_CLIPMAP_LEVELS },
    () => null,
  )
  #renders = 0
  readonly #source: CloudMapNodes
  /** The field's generation where the source has no cube: bumped by this clipmap's own events. */
  #ownGeneration = 0
  #weather: string | null = null
  #address: string | null = null
  #period: readonly [number, number] = [0, 0]
  /** Each level's faces, and the window they were found for. */
  readonly #faces: ({ readonly key: string; readonly faces: CubeFace[] } | null)[] =
    Array.from({ length: CLOUD_CLIPMAP_LEVELS }, () => null)
  /** The generation each level's last whole bake read, its faces' least; −1 before one. */
  readonly #readGeneration: number[] = Array.from(
    { length: CLOUD_CLIPMAP_LEVELS },
    () => -1,
  )
  /**
   * Each level's reading of each face's version: what its last whole bake or
   * refresh cycle read, or −1 for a face it does not read. A face that
   * enters the window enters by the strips its move exposed, which read it
   * as it stands.
   */
  readonly #readVersions: number[][] = Array.from(
    { length: CLOUD_CLIPMAP_LEVELS },
    () => [-1, -1, -1, -1, -1, -1],
  )
  /** The refresh under way: its level, its next eighth, and the versions it started from. */
  #refresh: {
    readonly level: number
    eighth: number
    readonly versions: number[]
  } | null = null
  /** The field's instant each level's last whole bake or refresh began at: what its displacement turned from. */
  readonly #bakedAt: number[] = Array.from(
    { length: CLOUD_CLIPMAP_LEVELS },
    () => 0,
  )
  /** Where the analytic source's refresh goes next: level ⌊slot/8⌋, eighth slot mod 8. */
  #slot = 0
  #warm: Promise<void> | null = null
  #disposed = false

  /**
   * `source` is what the levels bake from: the weather cube's nodes in the
   * system (§3.9), or `analyticMapNodes`, the placeholder's function at the
   * clipmap's own resolution, in a test that bakes without a cube. Required,
   * because either compiles: a clipmap left to a default bakes the
   * placeholder's own pattern and never the cube the far bakes read, and the
   * fine and far marches then draw two different fields.
   */
  constructor(uniforms: CloudUniforms, source: CloudMapNodes) {
    this.#target.textures.forEach((map, k) => {
      map.name = CHANNELS[k]!
    })
    // The rise and the share are bytes: an attachment's format is its own.
    this.#target.textures[1]!.type = UnsignedByteType
    const [texel, rise] = this.#target.textures.map((map) => texture(map)) as [
      TextureNode,
      TextureNode,
    ]
    // One pick a sample node: the column and the meters share it.
    const picks = new WeakMap<CloudSample, Map<CloudBodyUniforms, Pick>>()
    const pickOf = (sample: CloudSample, body: CloudBodyUniforms): Pick => {
      let byBody = picks.get(sample)
      if (byBody === undefined) {
        byBody = new Map()
        picks.set(sample, byBody)
      }
      let found = byBody.get(body)
      if (found === undefined) {
        found = pick(sample, body)
        byBody.set(body, found)
      }
      return found
    }
    const read = (
      map: TextureNode,
      sample: CloudSample,
      body: CloudBodyUniforms,
      level: Node<'int'>,
    ): Node<'vec4'> => {
      const { coordinates, blend, layer } = pickOf(sample, body)
      const fade = blend.x
      const cloud = select(level.lessThan(int(0)), int(0), level)
      // Beyond the coarsest window the first read is not taken, and the
      // second only inside a fade band: each a branch, not a select of two
      // reads that both run.
      const here = select(
        fade.lessThan(1),
        readLevel(map, coordinates.xy, layer.mul(CLOUD_LEVELS).add(cloud)),
        vec4(0),
      )
      const there = select(
        fade.greaterThan(0).and(layer.lessThan(int(CLOUD_CLIPMAP_LEVELS - 1))),
        readLevel(
          map,
          coordinates.zw,
          layer.add(int(1)).mul(CLOUD_LEVELS).add(cloud),
        ),
        vec4(0),
      )
      return mix(here, there, fade)
    }
    this.nodes = {
      column: (sample, body, level) => {
        const held = read(texel, sample, body, level)
        const slope = read(rise, sample, body, level)
        return {
          cover: held.w,
          convective: slope.x,
          displacement: held.xyz,
          rise: slope.yzw.sub(0.5).mul(2 * RISE_SPAN),
        }
      },
      columnMeters: (sample, body) => pickOf(sample, body).blend.y,
    }
    this.#source = source
    const body = uniforms.served
    this.#materials = body.clipmap
      .slice(0, CLOUD_CLIPMAP_LEVELS)
      .flatMap((level, k) =>
        [0, 1, 2].map((j) => {
          const material = new NodeMaterial()
          material.name = `cloud clipmap ${k}.${j}`
          material.fragmentNode = bakeNode(level, j, body, source)
          return material
        }),
      )
  }

  /**
   * A level is owed while it is stale, or while what it last read is of an
   * older generation than the field's: a level rebuilt from a face not yet
   * rebaked after a jump is not whole.
   */
  get pending(): boolean {
    if (this.#disposed || this.#allocated !== 'full') return false
    const generation = this.#generation
    return this.#staleSince.some(
      (since, k) =>
        since !== null || this.#readGeneration[k]! < generation,
    )
  }

  /** The field's present generation: the cube's, or this clipmap's own over an analytic source. */
  get #generation(): number {
    return this.#source.freshness?.generation ?? this.#ownGeneration
  }

  /** The least generation of the faces a level reads: what a bake of it now would hold. */
  #facesGeneration(faces: readonly CubeFace[]): number {
    const freshness = this.#source.freshness
    if (freshness === undefined) return this.#ownGeneration
    let least = Infinity
    for (const face of faces)
      least = Math.min(least, freshness.faceGeneration(face))
    return least
  }

  /** Each face's version, −1 for a face not in `faces`. */
  #versions(faces: readonly CubeFace[]): number[] {
    const freshness = this.#source.freshness
    const versions = [-1, -1, -1, -1, -1, -1]
    for (const face of faces) versions[face] = freshness?.faceVersion(face) ?? 0
    return versions
  }

  /** A level's faces for its window this frame, found again only when the window moved. */
  #levelFaces(k: number, level: LevelFrame, radius: number): CubeFace[] {
    const key = `${level.origin[0]},${level.origin[1]},${level.anchor.x},${level.anchor.y},${level.anchor.z},${radius}`
    const held = this.#faces[k]
    if (held?.key === key) return held.faces
    const faces = levelFaces(level, radius)
    this.#faces[k] = { key, faces }
    return faces
  }

  get bytes(): number {
    if (this.#disposed || this.#allocated === 'none') return 0
    return this.#target.width * this.#target.height * LAYERS * TEXEL_BYTES
  }

  textures(): readonly Texture[] {
    return this.#disposed || this.#allocated === 'none'
      ? []
      : this.#target.textures
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#warm ??= this.#compile(renderer).catch((cause: unknown) => {
      log.warn('the cloud clipmap did not warm', { cause: String(cause) })
    })
    return this.#warm
  }

  async #compile(renderer: WebGPURenderer): Promise<void> {
    const compiled = warmSensorPass(
      renderer,
      this.#quad,
      this.#materials.map((material) => ({ target: this.#target, material })),
    )
    if (this.#allocated === 'none') this.#allocated = 'stand-in'
    await compiled
  }

  /**
   * This frame's share (§3.9). Every level the frame stales — a new
   * generation of the field, a re-anchor, the first frame at full size —
   * rebuilds whole, levels 0–1 the frame they go stale and one of 2–5 a
   * frame, the longest stale first, so a run of jumps still reaches every
   * level; a level rebuilt from a face older than the field is staled again
   * when that face is rebaked; every whole level draws the strips its
   * window's move exposed. A frame that rebuilds nothing redraws an eighth
   * of a level whose faces the cube has redrawn since it read them, and
   * nothing when none has. The levels' frames are the bundle's, written for
   * this frame before the clipmap renders, and the cube renders first.
   */
  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    budget: CloudBudget,
  ): void {
    if (this.#disposed) return
    const now = this.#renders
    this.#renders += 1
    const update = frame.served.clipmap
    const fresh = this.#allocated !== 'full'
    if (fresh) {
      this.#target.setSize(CLOUD_CLIPMAP_SIZE, CLOUD_CLIPMAP_SIZE, LAYERS)
      this.#allocated = 'full'
    }
    const { served } = frame
    const [low, high] = served.climate.period
    if (
      fresh ||
      frame.jump ||
      budget.jump ||
      served.weatherKey !== this.#weather ||
      served.address !== this.#address ||
      low !== this.#period[0] ||
      high !== this.#period[1]
    )
      this.#ownGeneration += 1
    this.#weather = served.weatherKey
    this.#address = served.address
    this.#period = [low, high]
    const generation = this.#generation
    const faces = update.frames.map((level, k) =>
      this.#levelFaces(k, level, served.datumRadius),
    )
    const stale = this.#staleSince
    for (let k = 0; k < CLOUD_CLIPMAP_LEVELS; k += 1) {
      const read = this.#readGeneration[k]!
      // A level that read an older field is rebuilt once its faces hold the
      // present one; one whose faces are not there yet waits for them.
      const behind =
        read < generation &&
        (read === -1 || this.#facesGeneration(faces[k] ?? []) > read)
      if (fresh || behind || update.rebuilt[k] === true) stale[k] ??= now
    }

    const whole: number[] = [0, 1].filter((k) => stale[k] !== null)
    let coarse: number | null = null
    for (let k = 2; k < CLOUD_CLIPMAP_LEVELS; k += 1) {
      const since = stale[k]
      if (since === null || since === undefined) continue
      if (coarse === null || since < stale[coarse]!) coarse = k
    }
    if (coarse !== null) whole.push(coarse)

    const rects: (readonly [number, number, number, number, number])[] = []
    for (const k of whole) {
      rects.push([k, 0, 0, CLOUD_CLIPMAP_SIZE, CLOUD_CLIPMAP_SIZE])
      const read = faces[k] ?? []
      stale[k] = null
      this.#readGeneration[k] = this.#facesGeneration(read)
      this.#readVersions[k] = this.#versions(read)
      this.#bakedAt[k] = frame.time
      if (this.#refresh?.level === k) this.#refresh = null
    }
    for (let k = 0; k < CLOUD_CLIPMAP_LEVELS; k += 1) {
      if (stale[k] !== null || whole.includes(k)) continue
      for (const { x, y, width, height } of update.dirty[k] ?? [])
        rects.push([k, x, y, width, height])
      const read = this.#readVersions[k]!
      const now = this.#versions(faces[k] ?? [])
      now.forEach((version, face) => {
        if (version >= 0 && read[face] === -1) read[face] = version
      })
    }
    if (whole.length === 0) {
      const eighth = this.#refreshEighth(faces, frame)
      if (eighth !== null)
        rects.push([
          eighth[0],
          0,
          eighth[1] * REFRESH_ROWS,
          CLOUD_CLIPMAP_SIZE,
          REFRESH_ROWS,
        ])
    }
    this.#draw(renderer, rects)
  }

  /**
   * The eighth of a level this frame redraws for time, if one is owed:
   * the refresh under way, or a new one on the first whole level whose
   * faces the cube has redrawn since it read them or whose displacement has
   * turned a 32nd of a cell since it was drawn. Over an analytic source,
   * which moves every frame, every level in turn, 48 frames a cycle.
   */
  #refreshEighth(
    faces: readonly (readonly CubeFace[])[],
    frame: CloudFrame,
  ): readonly [number, number] | null {
    const stale = this.#staleSince
    if (this.#source.freshness === undefined) {
      const slot = this.#slot
      this.#slot = (slot + 1) % (CLOUD_CLIPMAP_LEVELS * 8)
      const k = Math.floor(slot / 8)
      return stale[k] === null ? [k, slot % 8] : null
    }
    if (this.#refresh === null) {
      for (let k = 0; k < CLOUD_CLIPMAP_LEVELS; k += 1) {
        if (stale[k] !== null) continue
        const versions = this.#versions(faces[k] ?? [])
        const read = this.#readVersions[k]!
        const redrawn = versions.some(
          (version, face) => version >= 0 && version !== read[face],
        )
        const turned =
          displacementDrift(frame, frame.time - this.#bakedAt[k]!) >= 1 / 32
        if (!redrawn && !turned) continue
        this.#refresh = { level: k, eighth: 0, versions }
        this.#bakedAt[k] = frame.time
        break
      }
    }
    const refresh = this.#refresh
    if (refresh === null) return null
    const eighth: readonly [number, number] = [refresh.level, refresh.eighth]
    refresh.eighth += 1
    if (refresh.eighth === 8) {
      this.#readVersions[refresh.level] = refresh.versions
      this.#refresh = null
    }
    return eighth
  }

  #draw(
    renderer: WebGPURenderer,
    rects: readonly (readonly [number, number, number, number, number])[],
  ): void {
    if (rects.length === 0) return
    const target = this.#target
    try {
      runQuadPasses(
        renderer,
        this.#quad,
        { linear: true, autoClear: false, scissor: true },
        (draw) => {
          for (const [k, x, y, width, height] of rects) {
            target.scissor.set(x, y, width, height)
            for (let j = 0; j < CLOUD_LEVELS; j += 1) {
              const layer = k * CLOUD_LEVELS + j
              draw(CLOUD_CLIPMAP_LABEL, target, this.#materials[layer]!, layer)
            }
          }
        },
      )
    } finally {
      target.scissor.set(0, 0, target.width, target.height)
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    for (const material of this.#materials) material.dispose()
  }
}

/**
 * The cube faces a level's window reads, from a grid of its texel
 * directions, in float64. A level's window is a square on its gnomonic
 * plane, a face's boundary there is a straight line, and a texel reads only
 * the tile of its own face (the gutters are the face's own bake), so the
 * faces of the grid's directions are the faces the level reads. The grid is
 * 17 a side: a face can meet the window without holding one of its points
 * only as a sliver at a cube corner inside it, and the three faces at a
 * corner each hold a third of the angle around it.
 */
export function levelFaces(level: LevelFrame, radius: number): CubeFace[] {
  const found = new Set<CubeFace>()
  const { anchor, east, north, origin, texelMeters, size } = level
  for (let i = 0; i < FACE_SAMPLES; i += 1)
    for (let j = 0; j < FACE_SAMPLES; j += 1) {
      const u = (origin[0] + 0.5 + ((size - 1) * i) / (FACE_SAMPLES - 1)) * texelMeters
      const v = (origin[1] + 0.5 + ((size - 1) * j) / (FACE_SAMPLES - 1)) * texelMeters
      found.add(
        cubeFaceOf({
          x: anchor.x * radius + east.x * u + north.x * v,
          y: anchor.y * radius + east.y * u + north.y * v,
          z: anchor.z * radius + east.z * u + north.z * v,
        }).face,
      )
    }
  return [...found].sort((a, b) => a - b)
}

/**
 * How far the displacement a level holds has moved in `seconds` of the
 * field's time, in the cells of the cloud level it moves most: each cloud
 * level's turn at the equator and the drift along the axis, times the
 * displacement's steepest gradient, over its cell.
 */
export function displacementDrift(frame: CloudFrame, seconds: number): number {
  const radius = frame.served.datumRadius
  let most = 0
  for (const level of frame.served.levels) {
    if (!(level.top > level.base)) continue
    const speed = Math.abs(level.turnRate) * radius + WEATHER_AXIAL_DRIFT
    most = Math.max(
      most,
      (MESOSCALE_STEEPEST * speed * Math.abs(seconds)) / Math.max(level.cell, 1),
    )
  }
  return most
}

/** The six waves' gradients together: the displacement's steepest. */
const MESOSCALE_STEEPEST = 6 * MESOSCALE_GRADIENT

/**
 * A layer's bake, clipmap level `level`'s cloud level `j`: the fragment's
 * storage texel (x, y) is lattice texel origin + ((x − origin) mod 256),
 * whose center's plane coordinate is (i + ½)·texel, whose direction is the
 * plane point's from the body's center, at which the source is read.
 * Integers below 2²⁴ and products by powers of two are exact in float32,
 * so the lattice texel is exact; the direction carries half a meter on
 * Earth, against the cube's 19.6 km texels.
 *
 * The displacement is taken at the cloud level's middle height, at the
 * point's offset from the eye (`levelOffset`, formed without subtracting two
 * radii), turned into the level's frame: `M_j·offset`, which the eye's
 * phases are advanced by.
 */
function bakeNode(
  level: CloudLevelUniforms,
  j: 0 | 1 | 2 | number,
  body: CloudBodyUniforms,
  source: CloudMapNodes,
): Node {
  const storage = floor(screenCoordinate.xy)
  const fromOrigin = storage.sub(level.origin)
  const lattice = level.origin
    .add(fromOrigin)
    .sub(floor(fromOrigin.div(CLOUD_CLIPMAP_SIZE)).mul(CLOUD_CLIPMAP_SIZE))
  const plane = lattice.add(0.5).mul(level.texel)
  const direction = normalize(
    level.anchor
      .mul(body.datumRadius)
      .add(level.east.mul(plane.x))
      .add(level.north.mul(plane.y)),
  )
  const { layers } = body
  const pickLevel = (v: Node<'vec3'>): Node<'float'> =>
    (j === 0 ? v.x : j === 1 ? v.y : v.z) as Node<'float'>
  const middle = pickLevel(layers.base).add(pickLevel(layers.top)).mul(0.5)
  const cell = max(pickLevel(layers.cell), 1)
  const turn = layers.turn[j as 0 | 1 | 2]
  const phases = layers.mesoscale[j as 0 | 1 | 2]
  const turned = turn.mul(levelOffset(level, plane, middle, body)) as Node<'vec3'>
  const up = turn.mul(direction) as Node<'vec3'>
  const displacement = mesoscaleNode(turned, phases, cell)
  const rise = mesoscaleRateNode(turned, up, phases, cell)
  const cover = pickLevel(source.cover(direction).xyz)
  const convective = pickLevel(source.kind(direction).xyz)
  return mrt({
    [CHANNELS[0]]: vec4(displacement, cover),
    [CHANNELS[1]]: vec4(
      convective,
      clamp(rise.div(2 * RISE_SPAN).add(0.5), 0, 1),
    ),
  })
}

/**
 * The clipmap a field's fine medium reads, baked from the weather cube.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change.
 */
export function createCloudClipmap(deps: {
  readonly uniforms: CloudUniforms
  readonly maps: { readonly nodes: CloudMapNodes }
}): CloudClipmap {
  return new CloudClipmap(deps.uniforms, deps.maps.nodes)
}
