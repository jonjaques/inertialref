import {
  LinearFilter,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget3D,
  RepeatWrapping,
  RGFormat,
  type Texture,
  type TextureNode,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  clamp,
  float,
  floor,
  Fn,
  If,
  int,
  length,
  max,
  saturate,
  screenCoordinate,
  select,
  sqrt,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { type LevelFrame, textureBytes } from '@inertialref/rendering'
import {
  detailCells,
  detailReach,
  layerAt,
  layerRadius,
} from './cloudDensity.ts'
import type { CloudFrame } from './cloudFrame.ts'
import { levelOffset, levelPlane, sunMuAt } from './cloudGeometry.ts'
import {
  type CloudBudget,
  type CloudMedium,
  type CloudMediumFn,
  type CloudResource,
  type CloudSample,
} from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import type {
  CloudBodyUniforms,
  CloudLevelUniforms,
  CloudUniforms,
} from './cloudUniforms.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmByDrawing } from './warmup.ts'

/*
 * The local volume: the field cached in three eye-anchored levels of
 * 256² × 32 RG8 texels — R = √(σ/σ_scale), G = the fraction — stacked with a
 * guard slice under and over each level in one `RenderTarget3D` and baked a
 * few slices a frame (§3.11). It is what the sun grid sums its optical depth
 * through (`cloudSunGrid.ts`); the trace marches the field itself.
 *
 * **A level is read only where every one of its slices holds this anchor's
 * texels.** A slice is baked whole, at the window the level has that frame,
 * so after the window moves the slices not yet redrawn still hold the old
 * window — toroidally, the strip it exposed holds the strip it left — and
 * the level is trusted only on the intersection of the windows its slices
 * were baked at, a texel in from each edge so a trilinear read never reaches
 * a texel outside it. The anchor moving, the field's time jumping, the
 * scenario changing and a level waking from idle each leave it trusted
 * nowhere until all 34 slices are baked again. Where no level is trusted the
 * medium is the field itself (`bake`): the field stays the fallback beyond
 * the volume's reach, so a cache that is still filling draws what it caches
 * at the field's price, never a hole.
 *
 * **The per-frame budget** (`CloudBudget.slices`, 8) goes to level 0's
 * missing slices first — all 34 of them the frame they go missing, whatever
 * the budget, so the nearest cloud is never the field's for a frame — then
 * to slices baked at a window the level has since left, then to levels 1
 * and 2's missing slices, then to the oldest slice anywhere: the field's
 * drift moves the cloud a little every frame, and a cycle of the 102 slices
 * at 8 a frame refreshes each within 13 frames. Levels 1 and 2 rebuild
 * before that refresh and not after it, or a rebuild after a jump would
 * wait on a refresh that never ends.
 *
 * **The bake's footprint is the level's texel.** The field fades its detail
 * and mixes in its unresolved share by footprint (§5.6), so each level
 * caches the field as seen at its own resolution, and a read finer than
 * that adds the detail erosion the bake left out.
 */

export const CLOUD_VOLUME_SIZE = 256
/** Plus 2 guard slices a level, stacked in z. */
export const CLOUD_VOLUME_SLICES = 32
export const CLOUD_VOLUME_TEXELS = [50, 200, 800] as const

/** The pass's name on the timeline. */
export const CLOUD_VOLUME_LABEL = 'cloud volume'

const LEVELS = CLOUD_VOLUME_TEXELS.length
/** A level's slices with its two guards. */
const STACK = CLOUD_VOLUME_SLICES + 2
const DEPTH = LEVELS * STACK
/** RG8. */
const TEXEL_BYTES = 2
/** Texels in from a trusted window's edges: a trilinear read reaches half a texel. */
const MARGIN = 1
/** A rectangle nothing is inside: lattice x0, y0, x1, y1. */
const NOWHERE = [1, 1, 0, 0] as const

export interface CloudVolumeDeps {
  readonly uniforms: CloudUniforms
  /** What it caches: the field. */
  readonly bake: CloudMediumFn
  readonly detail: CloudNoiseNodes
}

/* ------------------------------------------------------------------------- */
/* Arithmetic the nodes share                                                 */
/* ------------------------------------------------------------------------- */

/** x mod n into [0, n), floored: WGSL's `%` on floats keeps the dividend's sign. */
export function wrapped(x: Node<'float'>, n: number): Node<'float'>
export function wrapped(x: Node<'vec2'>, n: number): Node<'vec2'>
export function wrapped(
  x: Node<'float'> | Node<'vec2'>,
  n: number,
): Node<'float'> | Node<'vec2'> {
  const value = x as Node<'vec2'>
  return value.sub(floor(value.div(n)).mul(n))
}

/** Where in the volume a point is read: its level, or 3 where none is trusted. */
interface Held {
  /** 0, 1, 2, or 3: the finest trusted level holding the point. */
  readonly level: Node<'float'>
  /** Lattice texels of that level's plane, continuous: texel (i, j) covers [i, i + 1). */
  readonly lattice: Node<'vec2'>
  /** Slices over the union's base, continuous, in [0, 32]. */
  readonly slice: Node<'float'>
  readonly texel: Node<'float'>
}

/* ------------------------------------------------------------------------- */
/* The volume                                                                 */
/* ------------------------------------------------------------------------- */

interface SliceRecord {
  /** The window's origin the slice was baked at; null where it holds nothing this anchor's. */
  origin: readonly [number, number] | null
  /** The frame it was baked at: the refresh takes the oldest. */
  frame: number
}

interface LevelState {
  readonly slices: SliceRecord[]
  epoch: number
  idle: boolean
}

interface Bake {
  readonly level: number
  readonly slice: number
}

const freshLevel = (): LevelState => ({
  slices: Array.from({ length: STACK }, () => ({ origin: null, frame: -1 })),
  epoch: -1,
  idle: true,
})

const sameOrigin = (
  a: readonly [number, number],
  b: readonly [number, number],
): boolean => a[0] === b[0] && a[1] === b[1]

const modulo = (value: number, size: number): number =>
  ((value % size) + size) % size

/** A level's own uniform set, for the bake's one level a draw. */
function bakeLevelUniforms(): CloudLevelUniforms {
  return {
    anchor: uniform(new Vector3(0, 1, 0)),
    east: uniform(new Vector3(1, 0, 0)),
    north: uniform(new Vector3(0, 0, 1)),
    eye: uniform(new Vector2()),
    along: uniform(new Vector3(1, 0, 0)),
    origin: uniform(new Vector2()),
    texel: uniform(1),
  }
}

export class CloudVolume implements CloudResource {
  readonly name = 'volume'
  /**
   * One read a step of the grid's sun ray: R = √(σ/σ_scale), G = fraction,
   * at the finest level holding the sample, plus detail-noise erosion where
   * the footprint is finer than the level's texel; the field where no level
   * holds it. Level 0. Statements: built inside a `Fn`.
   */
  readonly medium: CloudMediumFn

  readonly #deps: CloudVolumeDeps
  /*
   * Linear by name: a `RenderTarget3D` takes its minification filter from
   * the options and keeps `Data3DTexture`'s nearest magnification, and a read
   * at level 0 magnifies. Nearest, a cloudy texel reads as a 50 m box a ray
   * can clip in under a step.
   */
  readonly #target = new RenderTarget3D(1, 1, 1, {
    type: UnsignedByteType,
    format: RGFormat,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    depthBuffer: false,
  })
  readonly #volume: TextureNode
  /** Per level, the lattice rectangle the reads trust: x0, y0, x1, y1. */
  readonly #trusted = Array.from({ length: LEVELS }, () =>
    uniform(new Vector4(...NOWHERE)),
  )
  readonly #bakeLevel = bakeLevelUniforms()
  readonly #bakeOriginMod = uniform(new Vector2())
  readonly #bakeSlice = uniform(0)
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #levels: LevelState[] = Array.from({ length: LEVELS }, freshLevel)
  #weather: string | null = null
  #address: string | null = null
  #last: number | null = null
  #pending = false
  #drawn: readonly number[] = [0, 0, 0]
  #allocated = false
  #warm: Promise<void> | null = null
  #disposed = false

  constructor(deps: CloudVolumeDeps) {
    this.#deps = deps
    const map = this.#target.texture
    map.name = 'cloud volume'
    // Toroidal across, clamped up: a level's guard slices stop its filter.
    map.wrapS = RepeatWrapping
    map.wrapT = RepeatWrapping
    this.#volume = texture3D(map)
    this.#material.name = 'cloud volume'
    this.#material.fragmentNode = this.#bakeNode()
    this.medium = (sample, body) => this.#mediumAt(sample, body)
  }

  /* ----------------------------------------------------------------------- */
  /* The reads                                                                */
  /* ----------------------------------------------------------------------- */

  /** The union's base, its slice height, and the volume's σ scale. */
  #vertical(body: CloudBodyUniforms): {
    readonly base: Node<'float'>
    readonly slice: Node<'float'>
  } {
    const base = body.boundaries.x
    const top = body.boundariesHigh.y
    return {
      base,
      slice: max(top.sub(base).div(CLOUD_VOLUME_SLICES), 1e-3),
    }
  }

  #held(
    offset: Node<'vec3'>,
    height: Node<'float'>,
    body: CloudBodyUniforms,
  ): Held {
    const { base, slice } = this.#vertical(body)
    let level: Node<'float'> = float(3)
    let lattice: Node<'vec2'> = vec2(0)
    let texel: Node<'float'> = float(CLOUD_VOLUME_TEXELS[LEVELS - 1])
    for (let L = LEVELS - 1; L >= 0; L -= 1) {
      const frame = body.volume[L]!
      const at = levelPlane(frame, offset, body).div(frame.texel)
      const rect = this.#trusted[L]!
      const inside = at.x
        .greaterThanEqual(rect.x.add(MARGIN))
        .and(at.y.greaterThanEqual(rect.y.add(MARGIN)))
        .and(at.x.lessThanEqual(rect.z.sub(MARGIN)))
        .and(at.y.lessThanEqual(rect.w.sub(MARGIN)))
      level = select(inside, float(L), level)
      lattice = select(inside, at, lattice)
      texel = select(inside, frame.texel, texel)
    }
    return {
      level,
      lattice,
      slice: clamp(height.sub(base).div(slice), 0, CLOUD_VOLUME_SLICES),
      texel,
    }
  }

  #mediumAt(sample: CloudSample, body: CloudBodyUniforms): CloudMedium {
    const layers = body.layers
    const held = this.#held(sample.offset, sample.altitude, body)
    const sigma = float(0).toVar()
    const fraction = float(0).toVar()
    const layer = int(-1).toVar()
    const column = float(0).toVar()
    const radius = float(10).toVar()
    If(held.level.lessThan(2.5), () => {
      const z = held.level.mul(STACK).add(1).add(held.slice).div(DEPTH)
      const read = this.#volume
        .sample(vec3(held.lattice.div(CLOUD_VOLUME_SIZE), z))
        .level(float(0))
      const shell = layerAt(layers, sample.altitude)
      const cached = read.x.mul(read.x).mul(layers.sigmaScale).toVar()
      // The detail the bake's footprint faded out and this one keeps.
      const erosion = max(
        detailReach(sample.footprint, shell.cell).sub(
          detailReach(held.texel, shell.cell),
        ),
        0,
      ).mul(shell.erosion)
      If(erosion.greaterThan(0).and(shell.sigma.greaterThan(0)), () => {
        // The field's own detail lattice, so what is eaten here is what the
        // field eats there.
        const cells = detailCells(sample, body, shell.cell)
        const eaten = this.#deps.detail.detail(cells).mul(erosion)
        const density = saturate(
          cached
            .div(shell.sigma)
            .sub(eaten)
            .div(max(float(1).sub(eaten), 1e-3)),
        )
        cached.assign(shell.sigma.mul(density))
      })
      sigma.assign(cached)
      fraction.assign(read.y)
      layer.assign(shell.index)
      column.assign(held.texel)
      radius.assign(layerRadius(shell))
    }).Else(() => {
      const field = this.#deps.bake(sample, body)
      sigma.assign(field.sigma)
      fraction.assign(field.fraction)
      layer.assign(field.layer)
      column.assign(field.column)
      radius.assign(field.radius)
    })
    return { sigma, fraction, layer, column, radius, depth: vec2(0) }
  }

  /* ----------------------------------------------------------------------- */
  /* The bake                                                                 */
  /* ----------------------------------------------------------------------- */

  /** One slice of one level: the field at each texel's center, at the level's texel. */
  #bakeNode(): Node<'vec4'> {
    const { uniforms, bake } = this.#deps
    const body = uniforms.served
    const level = this.#bakeLevel
    return Fn(() => {
      const { base, slice } = this.#vertical(body)
      const pixel = floor(screenCoordinate.xy)
      // Storage texel → lattice texel: (i − origin) mod size, from the window's corner.
      const lattice = level.origin.add(
        wrapped(pixel.sub(this.#bakeOriginMod), CLOUD_VOLUME_SIZE),
      )
      const plane = lattice.add(0.5).mul(level.texel)
      const height = base.add(this.#bakeSlice.add(0.5).mul(slice))
      const offset = levelOffset(level, plane, height, body)
      const medium = bake(
        {
          offset,
          distance: length(offset),
          altitude: height,
          sunMu: sunMuAt(body, offset),
          footprint: level.texel,
        },
        body,
      )
      const encoded = sqrt(saturate(medium.sigma.div(body.layers.sigmaScale)))
      return vec4(encoded, saturate(medium.fraction), 0, 1)
    })()
  }

  /* ----------------------------------------------------------------------- */
  /* The schedule                                                             */
  /* ----------------------------------------------------------------------- */

  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    budget: CloudBudget,
  ): void {
    if (this.#disposed) return
    this.#allocate(renderer)
    this.#invalidate(frame, budget)
    const work = this.#schedule(frame, budget.slices)
    this.#bake(renderer, frame, work)
    this.#publish(frame)
    this.#last = frame.frameIndex
  }

  /** What makes a level's slices hold nothing this frame's. */
  #invalidate(frame: CloudFrame, budget: CloudBudget): void {
    const { served } = frame
    const { boundaries, eye } = served.shells
    const top = boundaries[boundaries.length - 1] ?? 0
    // A weather's union, its slices' heights and its σ scale are all the
    // texels hold, so another weather is another volume.
    const everything =
      this.#last === null ||
      frame.frameIndex !== this.#last + 1 ||
      frame.jump ||
      budget.jump ||
      served.weatherKey !== this.#weather ||
      served.address !== this.#address
    this.#weather = served.weatherKey
    this.#address = served.address
    this.#levels.forEach((state, L) => {
      const level = served.volume.frames[L]
      // A level whose window lies more than its own extent below the eye
      // is out of reach of every fine ray: from orbit, none is drawn.
      const idle =
        level === undefined || eye - top > CLOUD_VOLUME_SIZE * level.texelMeters
      if (
        level !== undefined &&
        (everything ||
          served.volume.rebuilt[L] === true ||
          level.epoch !== state.epoch ||
          (state.idle && !idle))
      ) {
        for (const record of state.slices) record.origin = null
        state.epoch = level.epoch
      }
      state.idle = idle
    })
  }

  #schedule(frame: CloudFrame, budget: number): Bake[] {
    const frames = frame.served.volume.frames
    const work: Bake[] = []
    const taken = new Set<number>()
    const take = (level: number, slice: number): void => {
      work.push({ level, slice })
      taken.add(level * STACK + slice)
    }
    const active = (L: number): boolean => !this.#levels[L]!.idle
    const missing = (L: number) =>
      this.#levels[L]!.slices.flatMap((record, k) =>
        record.origin === null ? [k] : [],
      )
    if (active(0)) for (const k of missing(0)) take(0, k)
    let left = Math.max(0, budget - work.length)
    const spend = (L: number, k: number): void => {
      if (left <= 0 || taken.has(L * STACK + k)) return
      take(L, k)
      left -= 1
    }
    for (let L = 0; L < LEVELS; L += 1) {
      if (!active(L)) continue
      const now = frames[L]!.origin
      this.#levels[L]!.slices.forEach((record, k) => {
        if (record.origin !== null && !sameOrigin(record.origin, now))
          spend(L, k)
      })
    }
    for (let L = 1; L < LEVELS; L += 1)
      if (active(L)) for (const k of missing(L)) spend(L, k)
    const oldest = this.#levels
      .flatMap((state, L) =>
        state.idle
          ? []
          : state.slices.map((record, k) => ({ L, k, at: record.frame })),
      )
      .sort((a, b) => a.at - b.at || a.L - b.L || a.k - b.k)
    for (const { L, k } of oldest) spend(L, k)
    return work
  }

  #bake(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    work: readonly Bake[],
  ): void {
    const drawn = [0, 0, 0]
    if (work.length > 0)
      runQuadPasses(
        renderer,
        this.#quad,
        // Each slice replaces every texel it covers: nothing to clear.
        { linear: true, autoClear: false },
        (draw) => {
          for (const { level, slice } of work) {
            const at = frame.served.volume.frames[level]!
            this.#bakeAt(at, slice)
            draw(
              CLOUD_VOLUME_LABEL,
              this.#target,
              this.#material,
              level * STACK + slice,
            )
            const record = this.#levels[level]!.slices[slice]!
            record.origin = [at.origin[0], at.origin[1]]
            record.frame = frame.frameIndex
            drawn[level]! += 1
          }
        },
      )
    this.#drawn = drawn
  }

  #bakeAt(frame: LevelFrame, slice: number): void {
    const level = this.#bakeLevel
    level.anchor.value.set(frame.anchor.x, frame.anchor.y, frame.anchor.z)
    level.east.value.set(frame.east.x, frame.east.y, frame.east.z)
    level.north.value.set(frame.north.x, frame.north.y, frame.north.z)
    level.eye.value.set(frame.eye[0], frame.eye[1])
    level.along.value.set(frame.along[0], frame.along[1], frame.along[2])
    level.origin.value.set(frame.origin[0], frame.origin[1])
    level.texel.value = frame.texelMeters
    this.#bakeOriginMod.value.set(
      modulo(frame.origin[0], CLOUD_VOLUME_SIZE),
      modulo(frame.origin[1], CLOUD_VOLUME_SIZE),
    )
    // The guards repeat their level's edge slices.
    this.#bakeSlice.value = Math.min(
      CLOUD_VOLUME_SLICES - 1,
      Math.max(0, slice - 1),
    )
  }

  /** Each level's trusted rectangle: the intersection of its slices' windows. */
  #publish(frame: CloudFrame): void {
    let pending = false
    this.#levels.forEach((state, L) => {
      const now = frame.served.volume.frames[L]?.origin
      const rect = [-Infinity, -Infinity, Infinity, Infinity]
      let whole = !state.idle
      for (const { origin } of state.slices) {
        if (origin === null) {
          whole = false
          break
        }
        rect[0] = Math.max(rect[0]!, origin[0])
        rect[1] = Math.max(rect[1]!, origin[1])
        rect[2] = Math.min(rect[2]!, origin[0] + CLOUD_VOLUME_SIZE)
        rect[3] = Math.min(rect[3]!, origin[1] + CLOUD_VOLUME_SIZE)
        // An idle level keeps the slices it had and the schedule draws none
        // of them, so a window it has left is nothing owed.
        if (!state.idle && now !== undefined && !sameOrigin(origin, now))
          pending = true
      }
      if (!state.idle && !whole) pending = true
      const [x0, y0, x1, y1] = whole ? rect : NOWHERE
      this.#trusted[L]!.value.set(x0!, y0!, x1!, y1!)
    })
    this.#pending = pending
  }

  /* ----------------------------------------------------------------------- */
  /* The resource                                                             */
  /* ----------------------------------------------------------------------- */

  /**
   * Real size, the first frame it draws. A resize frees the texture and
   * three makes the new one at its next binding: allocated here at once, so
   * what `textures()` lists is on the device at the size `bytes` declares.
   */
  #allocate(renderer: WebGPURenderer): void {
    this.#allocated = true
    if (this.#target.width === CLOUD_VOLUME_SIZE) return
    this.#target.setSize(CLOUD_VOLUME_SIZE, CLOUD_VOLUME_SIZE, DEPTH)
    renderer.initRenderTarget(this.#target)
    this.#forget()
  }

  #forget(): void {
    this.#levels.forEach((state, L) => {
      this.#levels[L] = { ...freshLevel(), idle: state.idle }
    })
    for (const rect of this.#trusted) rect.value.set(...NOWHERE)
    this.#last = null
  }

  /** Work due at this frame's state: a level not yet whole, or a slice at a window it has left. */
  get pending(): boolean {
    return this.#pending
  }

  /** Slices baked this frame, by level: what the schedule spent. */
  get drawn(): readonly number[] {
    return this.#drawn
  }

  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    const target = this.#target
    return textureBytes(target.width, target.height, target.depth, TEXEL_BYTES)
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated ? [] : [this.#target.texture]
  }

  /**
   * The bake against a slice, drawn (an RG8 target, which `warmByDrawing`
   * says why); a renderer with no backend builds nothing.
   */
  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed || renderer?.backend === undefined)
      return Promise.resolve()
    this.#allocated = true
    if (this.#warm === null) {
      warmByDrawing(renderer, this.#quad, CLOUD_VOLUME_LABEL, [
        { target: this.#target, material: this.#material },
      ])
      // The draw lands on the target's first slice with whatever the bake's
      // uniforms last held. A warm-up that arrives after a frame has baked —
      // a chain rebuilt with the levers on — draws over level 0's lower guard
      // while its record still says whole, so a cache at its real size owes
      // every slice again.
      if (this.#target.width !== 1) {
        this.#forget()
        this.#pending = true
      }
      this.#warm = Promise.resolve()
    }
    return this.#warm
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#material.dispose()
  }
}

/**
 * The field cached around the eye, for the sun grid to sum through.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change.
 */
export function createCloudVolume(deps: {
  readonly uniforms: CloudUniforms
  /** The fine march's medium: what the volume caches. */
  readonly medium: CloudMediumFn
  readonly noise: { readonly nodes: CloudNoiseNodes }
}): CloudVolume {
  return new CloudVolume({
    uniforms: deps.uniforms,
    bake: deps.medium,
    detail: deps.noise.nodes,
  })
}
