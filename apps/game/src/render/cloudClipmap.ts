import {
  LinearFilter,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  RepeatWrapping,
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
  If,
  int,
  max,
  mix,
  normalize,
  round,
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
} from '@inertialref/rendering'
import { CLOUD_CLIPMAP_SIZE, type CloudFrame } from './cloudFrame.ts'
import { levelPlane, levelTexel } from './cloudGeometry.ts'
import type { CloudMapNodes } from './cloudMaps.ts'
import type { CloudBudget, CloudResource, CloudSample } from './cloudNodes.ts'
import type { CloudProfile } from './cloudProfile.ts'
import {
  CLOUD_CLIPMAP_LEVELS,
  type CloudBodyUniforms,
  type CloudLevelUniforms,
  type CloudUniforms,
} from './cloudUniforms.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmByDrawing } from './warmup.ts'

/*
 * What the fine march reads a step: six eye-anchored levels of 256² texels,
 * 250 m × 2^k, each a layer a cloud level, in a toroidally addressed 2D array
 * of one RGBA8 target, baked from the cube in the strips the window's move
 * exposes. A texel of cloud level j holds what a step in that level reads of
 * its column, in one fetch: its cover, its convective share, and its gain
 * (`levelStatistics`), the last as sixteen bits over two channels. The gain
 * runs from 1 to 30 (Earth's blended low level at a small cover), past what
 * a byte holds to the oracle's bound; split linearly, `(B·256 + A)·255/65535`,
 * so the sampler's filtering of the two bytes is the filtering of the gain. The cube is 19.6 km a texel at Earth's equator and the climate has
 * no structure under it, so the clipmap adds nothing finer in phase 1: it is
 * the cube's field resampled onto the planes the march reads, and the place
 * phase 3's climatology and orography go in.
 *
 * A layer a cloud level, and not the cube's packing of three levels a
 * texel, so a step's cover and share are one texel of one texture: the
 * trace binds one clipmap texture and reads it once a step (twice in a
 * level's fade band), where the cube's packing would take two of each.
 *
 * **Its pace and its freshness are the cube's.** A level holds nothing the
 * cube does not, so it is redrawn when a face it reads is, an eighth of a
 * level a frame, and never otherwise. A level is fresh when it was baked
 * from faces of the field's present generation: one rebuilt from a face not
 * yet rebaked after a jump stays pending and is rebuilt when the face is.
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

/** The bake's pass on the timeline: a whole level, a strip or a refresh slice, each one quad. */
export const CLOUD_CLIPMAP_LABEL = 'cloud clipmap'

/** One RGBA8 target: 4 bytes a texel. */
const TEXEL_BYTES = 4
/** The gain the two channels hold at their greatest: over the 29.5 measured. */
export const CLIPMAP_GAIN_SPAN = 32
/** Cloud levels: the array holds a layer of each a clipmap level. */
const CLOUD_LEVELS = 3
const LAYERS = CLOUD_CLIPMAP_LEVELS * CLOUD_LEVELS
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
  /** What the resolved extinction is multiplied by (`levelStatistics`). */
  readonly gain: Node<'float'>
  /** The texel size of the clipmap level the sample reads: the column a segment may span. */
  readonly meters: Node<'float'>
}

export interface CloudClipmapNodes {
  /**
   * Cloud level `level`'s column at the sample (0, 1 or 2; read as 0
   * outside every level), from the finest clipmap level whose window holds
   * it, faded over the outer fifth into the next (the fade band reads both).
   * Level 0.
   *
   * A call emits the level's pick as statements where it is made, so a call
   * is one read: its members are what that pick found. A second call for
   * the same sample picks again rather than reading variables a branch it
   * is not in may have left unset.
   */
  column(
    sample: CloudSample,
    body: CloudBodyUniforms,
    level: Node<'int'>,
  ): CloudClipmapColumn
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
 * The finest level whose window holds the sample, as statements: each
 * level's coordinates are formed once, in the branch that tests it, and the
 * next level's only inside a fade band. A chain of `select`s over the levels
 * reads the same values, but the builder emits a `select` as an `if` at each
 * of its uses, so each of the pick's five uses walks the chain again and a
 * read past level 0 forms every level's coordinates several times: one fine
 * read names each level's anchor seven times, where this form names it at
 * most twice (`cloudDensity.gpu.test.ts`). Past the coarsest there is no
 * level, and the coverage fades to none over that level's own band.
 */
function pick(sample: CloudSample, body: CloudBodyUniforms): Pick {
  const levels = body.clipmap.slice(0, CLOUD_CLIPMAP_LEVELS)
  const coarsest = levels.length - 1
  const coordinates = vec4(0).toVar()
  const blend = vec2(1, levels[coarsest]!.texel).toVar()
  const layer = int(coarsest).toVar()
  const nest = (k: number): void => {
    const located = locate(levels[k]!, sample.offset, body)
    const at = located.at.toVar()
    const reach = located.reach.toVar()
    const holds = reach.lessThan(REACH)
    if (k === coarsest) {
      // No next level: the read fades to none, and `zw` is never read.
      coordinates.assign(vec4(at, 0, 0))
      If(holds, () => {
        blend.assign(vec2(smoothstep(FADE, REACH, reach), levels[k]!.texel))
      })
      return
    }
    If(holds, () => {
      const fade = smoothstep(FADE, REACH, reach).toVar()
      coordinates.assign(vec4(at, 0, 0))
      If(fade.greaterThan(0), () => {
        coordinates.assign(
          vec4(at, locate(levels[k + 1]!, sample.offset, body).at),
        )
      })
      blend.assign(vec2(fade, levels[k]!.texel))
      layer.assign(int(k))
    }).Else(() => {
      nest(k + 1)
    })
  }
  nest(0)
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
    type: UnsignedByteType,
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
  readonly #profile: CloudProfile
  /** The profile's generation the levels were baked under, over an analytic source. */
  #tables = -1
  /** The field's generation where the source has no cube: bumped by this clipmap's own events. */
  #ownGeneration = 0
  #weather: string | null = null
  #address: string | null = null
  #period: readonly [number, number] = [0, 0]
  /** Each level's faces, and the window they were found for. */
  readonly #faces: ({
    readonly key: string
    readonly faces: CubeFace[]
  } | null)[] = Array.from({ length: CLOUD_CLIPMAP_LEVELS }, () => null)
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
  constructor(
    uniforms: CloudUniforms,
    source: CloudMapNodes,
    profile: CloudProfile,
  ) {
    this.#target.texture.name = 'cloud clipmap'
    const column = texture(this.#target.texture)
    const read = (
      map: TextureNode,
      { coordinates, blend, layer }: Pick,
      level: Node<'int'>,
    ): Node<'vec4'> => {
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
        const found = pick(sample, body)
        const held = read(column, found, level)
        return {
          cover: held.x,
          convective: held.y,
          gain: held.z
            .mul(256)
            .add(held.w)
            .mul((255 / 65535) * CLIPMAP_GAIN_SPAN),
          meters: found.blend.y,
        }
      },
    }
    this.#source = source
    this.#profile = profile
    const body = uniforms.served
    this.#materials = body.clipmap
      .slice(0, CLOUD_CLIPMAP_LEVELS)
      .flatMap((level, k) =>
        [0, 1, 2].map((j) => {
          const material = new NodeMaterial()
          material.name = `cloud clipmap ${k}.${j}`
          material.fragmentNode = bakeNode(level, j, body, source, profile)
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
      (since, k) => since !== null || this.#readGeneration[k]! < generation,
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

  /**
   * Every layer's bake against the target, drawn (an RG8 target, which
   * `warmByDrawing` says why); a renderer with no backend builds nothing.
   */
  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed || renderer?.backend === undefined)
      return Promise.resolve()
    if (this.#warm === null) {
      warmByDrawing(
        renderer,
        this.#quad,
        CLOUD_CLIPMAP_LABEL,
        this.#materials.map((material) => ({ target: this.#target, material })),
      )
      if (this.#allocated === 'none') this.#allocated = 'stand-in'
      // The draws land on the first layer with whatever the bakes' uniforms
      // last held. A warm-up after a frame has baked, a chain rebuilt with
      // the levers on, draws over level 0's low layer while its record says
      // whole, so every level at its real size is owed again.
      if (this.#target.width !== 1) this.#readGeneration.fill(-1)
      this.#warm = Promise.resolve()
    }
    return this.#warm
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
    // Over an analytic source this clipmap keeps its own generation, and a
    // level's statistics landing moves it as it moves the cube's.
    const tables = this.#profile.generation
    if (
      tables !== this.#tables ||
      fresh ||
      frame.jump ||
      budget.jump ||
      served.weatherKey !== this.#weather ||
      served.address !== this.#address ||
      low !== this.#period[0] ||
      high !== this.#period[1]
    )
      this.#ownGeneration += 1
    this.#tables = tables
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
      const eighth = this.#refreshEighth(faces)
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
   * faces the cube has redrawn since it read them. Over an analytic source,
   * which moves every frame, every level in turn, 48 frames a cycle.
   */
  #refreshEighth(
    faces: readonly (readonly CubeFace[])[],
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
        if (!redrawn) continue
        this.#refresh = { level: k, eighth: 0, versions }
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
      const u =
        (origin[0] + 0.5 + ((size - 1) * i) / (FACE_SAMPLES - 1)) * texelMeters
      const v =
        (origin[1] + 0.5 + ((size - 1) * j) / (FACE_SAMPLES - 1)) * texelMeters
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
 * A layer's bake, clipmap level `level`'s cloud level `j`: the fragment's
 * storage texel (x, y) is lattice texel origin + ((x − origin) mod 256),
 * whose center's plane coordinate is (i + ½)·texel, whose direction is the
 * plane point's from the body's center, at which the source is read.
 * Integers below 2²⁴ and products by powers of two are exact in float32,
 * so the lattice texel is exact; the direction carries half a meter on
 * Earth, against the cube's 19.6 km texels.
 */
function bakeNode(
  level: CloudLevelUniforms,
  j: number,
  body: CloudBodyUniforms,
  source: CloudMapNodes,
  profile: CloudProfile,
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
  const pickLevel = (v: Node<'vec3'>): Node<'float'> =>
    (j === 0 ? v.x : j === 1 ? v.y : v.z) as Node<'float'>
  const cover = pickLevel(source.cover(direction).xyz)
  const convective = pickLevel(source.kind(direction).xyz)
  // The gain at the column's cover and share, as sixteen bits: rounded to
  // its step, then split so each byte is exact in the target.
  const steps = round(
    clamp(profile.gain(0, float(j), cover, convective), 0, CLIPMAP_GAIN_SPAN)
      .div(CLIPMAP_GAIN_SPAN)
      .mul(65535),
  )
  const high = floor(steps.div(256))
  return vec4(
    cover,
    convective,
    high.div(255),
    steps.sub(high.mul(256)).div(255),
  )
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
  readonly profile: CloudProfile
}): CloudClipmap {
  return new CloudClipmap(deps.uniforms, deps.maps.nodes, deps.profile)
}
