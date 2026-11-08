import { getLogger } from '@inertialref/shared'
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
  vec3,
  vec4,
} from 'three/tsl'
import { CLOUD_CLIPMAP_SIZE, type CloudFrame } from './cloudFrame.ts'
import { levelPlane, levelTexel } from './cloudGeometry.ts'
import type { CloudMapNodes } from './cloudMaps.ts'
import type { CloudBudget, CloudResource, CloudSample } from './cloudNodes.ts'
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
 * 250 m × 2^k, in a toroidally addressed 2D array of four RGBA8 targets
 * packed as the weather cube's are, baked from the cube in the strips the
 * window's move exposes. The cube is 19.6 km a texel at Earth's equator and
 * the placeholder has no structure under it that the noise does not carry,
 * so the clipmap adds nothing finer in phase 0: it is the cube's field
 * resampled onto the planes the march reads, one function at two
 * resolutions, and the place phase 3's climatology and orography go in.
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

const CHANNELS = [
  'cloudClipmap0',
  'cloudClipmap1',
  'cloudClipmap2',
  'cloudClipmap3',
] as const
/** Four RGBA8 targets: 16 bytes a texel. */
const TEXEL_BYTES = 16
/** Rows a time refresh redraws: an eighth of a level. */
const REFRESH_ROWS = CLOUD_CLIPMAP_SIZE / 8
const REFRESH_SLOTS = CLOUD_CLIPMAP_LEVELS * 8

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

export interface CloudClipmapNodes {
  /**
   * Each layer's coverage at the sample, from the finest level whose window
   * holds it, faded over the outer fifth into the next (the fade band reads
   * both levels). Level 0.
   */
  coverage(sample: CloudSample, body: CloudBodyUniforms): Node<'vec3'>
  /** (log τ, convective share, ice) of one layer: read once a segment. */
  column(
    sample: CloudSample,
    body: CloudBodyUniforms,
    layer: Node<'int'>,
  ): Node<'vec3'>
  /** The texel size of the level `coverage` reads: the column a segment may span. */
  columnMeters(sample: CloudSample, body: CloudBodyUniforms): Node<'float'>
  /** Texture 0 of level `k` alone, at the sample: one read, the sweep's clipmap fetch. */
  level(sample: CloudSample, body: CloudBodyUniforms, k: number): Node<'vec4'>
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

/** A vector's component `layer` (0, 1 or 2) by selects: no dynamic index of a node. */
function component(v: Node<'vec3'>, layer: Node<'int'>): Node<'float'> {
  return select(
    layer.equal(int(0)),
    v.x,
    select(layer.equal(int(1)), v.y, v.z),
  ) as Node<'float'>
}

export class CloudClipmap implements CloudResource {
  readonly name = 'clipmap'
  readonly nodes: CloudClipmapNodes

  /** 1 × 1 × 6 until a frame draws: the format is the pipeline's, not the size. */
  readonly #target = new RenderTarget(1, 1, {
    depth: CLOUD_CLIPMAP_LEVELS,
    count: CHANNELS.length,
    type: UnsignedByteType,
    depthBuffer: false,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
  })
  /** One bake a level, each reading its own level's uniforms. */
  readonly #materials: readonly NodeMaterial[]
  readonly #quad = new QuadMesh()
  #allocated: 'none' | 'stand-in' | 'full' = 'none'
  /** The render a level went stale on, or null while it is whole. */
  readonly #staleSince: (number | null)[] = Array.from(
    { length: CLOUD_CLIPMAP_LEVELS },
    () => null,
  )
  #renders = 0
  /** The time refresh's next slot: level ⌊slot/8⌋, eighth slot mod 8. */
  #refresh = 0
  #scenario: string | null = null
  #period: readonly [number, number] = [0, 0]
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
    const [cover, depth, convective] = this.#target.textures.map((map) =>
      texture(map),
    ) as [TextureNode, TextureNode, TextureNode, TextureNode]
    // One pick a sample node: coverage, column and its meters share it.
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
    this.nodes = {
      coverage: (sample, body) => {
        const { coordinates, blend, layer } = pickOf(sample, body)
        const fade = blend.x
        // Beyond the coarsest window the first read is not taken, and the
        // second only inside a fade band: each a branch, not a select of
        // two reads that both run.
        const here = select(
          fade.lessThan(1),
          readLevel(cover, coordinates.xy, layer).xyz,
          vec3(0),
        )
        const there = select(
          fade
            .greaterThan(0)
            .and(layer.lessThan(int(CLOUD_CLIPMAP_LEVELS - 1))),
          readLevel(cover, coordinates.zw, layer.add(int(1))).xyz,
          vec3(0),
        )
        return mix(here, there, fade)
      },
      column: (sample, body, of) => {
        const { coordinates, layer } = pickOf(sample, body)
        const at = coordinates.xy
        return vec3(
          component(readLevel(depth, at, layer).xyz, of),
          component(readLevel(convective, at, layer).xyz, of),
          readLevel(cover, at, layer).w,
        )
      },
      columnMeters: (sample, body) => pickOf(sample, body).blend.y,
      level: (sample, body, k) => {
        const level = body.clipmap[k]!
        return readLevel(cover, locate(level, sample.offset, body).at, int(k))
      },
    }
    this.#materials = uniforms.served.clipmap
      .slice(0, CLOUD_CLIPMAP_LEVELS)
      .map((level, k) => {
        const material = new NodeMaterial()
        material.name = `cloud clipmap ${k}`
        material.fragmentNode = bakeNode(level, uniforms.served, source)
        return material
      })
  }

  get pending(): boolean {
    return !this.#disposed && this.#staleSince.some((since) => since !== null)
  }

  get bytes(): number {
    if (this.#disposed || this.#allocated === 'none') return 0
    return (
      this.#target.width *
      this.#target.height *
      CLOUD_CLIPMAP_LEVELS *
      TEXEL_BYTES
    )
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
   * This frame's share (§3.9): every level the frame stales — a jump, a new
   * scenario or pattern period, a re-anchor, a cut, the first frame at full
   * size — rebuilds whole, levels 0–1 the frame they go stale and one of
   * 2–5 a frame, the longest stale first, so a run of jumps still reaches
   * every level; every whole level draws the strips its window's move
   * exposed; and a frame that rebuilds nothing redraws an eighth of one
   * level for time, the cycle 48 frames. The levels' frames are the
   * bundle's, written for this frame before the clipmap renders.
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
      this.#target.setSize(
        CLOUD_CLIPMAP_SIZE,
        CLOUD_CLIPMAP_SIZE,
        CLOUD_CLIPMAP_LEVELS,
      )
      this.#allocated = 'full'
    }
    const [low, high] = frame.period
    const moved =
      fresh ||
      frame.jump ||
      budget.jump ||
      frame.scenario.id !== this.#scenario ||
      low !== this.#period[0] ||
      high !== this.#period[1]
    this.#scenario = frame.scenario.id
    this.#period = [low, high]
    const stale = this.#staleSince
    for (let k = 0; k < CLOUD_CLIPMAP_LEVELS; k += 1)
      if (moved || update.rebuilt[k] === true) stale[k] ??= now

    const whole: number[] = [0, 1].filter((k) => stale[k] !== null)
    let coarse: number | null = null
    for (let k = 2; k < CLOUD_CLIPMAP_LEVELS; k += 1) {
      const since = stale[k]
      if (since === null || since === undefined) continue
      if (coarse === null || since < stale[coarse]!) coarse = k
    }
    if (coarse !== null) whole.push(coarse)

    const rects: (readonly [number, number, number, number, number])[] = []
    for (const k of whole)
      rects.push([k, 0, 0, CLOUD_CLIPMAP_SIZE, CLOUD_CLIPMAP_SIZE])
    for (let k = 0; k < CLOUD_CLIPMAP_LEVELS; k += 1) {
      if (stale[k] !== null || whole.includes(k)) continue
      for (const { x, y, width, height } of update.dirty[k] ?? [])
        rects.push([k, x, y, width, height])
    }
    if (whole.length === 0) {
      const slot = this.#refresh
      this.#refresh = (slot + 1) % REFRESH_SLOTS
      const k = Math.floor(slot / 8)
      if (stale[k] === null)
        rects.push([
          k,
          0,
          (slot % 8) * REFRESH_ROWS,
          CLOUD_CLIPMAP_SIZE,
          REFRESH_ROWS,
        ])
    }
    for (const k of whole) stale[k] = null
    this.#draw(renderer, rects)
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
            draw(CLOUD_CLIPMAP_LABEL, target, this.#materials[k]!, k)
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
 * A level's bake: the fragment's storage texel (x, y) is lattice texel
 * origin + ((x − origin) mod 256), whose center's plane coordinate is
 * (i + ½)·texel, whose direction is the plane point's from the body's
 * center (`directionOf`), at which the source is read. Integers below 2²⁴
 * and products by powers of two are exact in float32, so the lattice
 * texel is exact; the direction carries half a meter on Earth, against the
 * cube's 19.6 km texels.
 */
function bakeNode(
  level: CloudLevelUniforms,
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
  const outputs: Record<string, Node<'vec4'>> = {}
  CHANNELS.forEach((name, k) => {
    outputs[name] =
      k === 0
        ? source.synoptic(direction)
        : source.channel(direction, k as 1 | 2 | 3)
  })
  return mrt(outputs)
}
