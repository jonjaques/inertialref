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
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  freshSunSource,
  type LevelFrame,
  owedByMotion,
  type SunSourceBake,
  type SunSourceState,
  sunSourceStep,
  textureBytes,
  trustedWindow,
  UNSPREAD_SHAPE,
} from '@inertialref/rendering'
import { layerAt, layerRadius } from './cloudDensity.ts'
import type { CloudFrame } from './cloudFrame.ts'
import { levelOffset, levelPlane, sunMuAt } from './cloudGeometry.ts'
import {
  type CloudBudget,
  type CloudLevelStatistics,
  type CloudMedium,
  type CloudMediumFn,
  type CloudResource,
  type CloudSample,
} from './cloudNodes.ts'
import type {
  CloudBodyUniforms,
  CloudLevelUniforms,
  CloudUniforms,
} from './cloudUniforms.ts'
import type { CloudProfile } from './cloudProfile.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmByDrawing } from './warmup.ts'

/*
 * The local volume: the field cached in two eye-anchored levels of
 * 256² × 32 texels, the frame's 200 m and 800 m ones, stacked with a guard slice under and over each level in
 * one `RenderTarget3D`. It is what the sun grid sums its optical depth
 * through (`cloudSunGrid.ts`), and nothing else reads it: the trace marches
 * the field itself.
 *
 * **A texel holds one number, the extinction a sun ray sums:** the scaled
 * extinction times the cloudy share, as sixteen bits over the texture's two
 * bytes. The split is linear, so the sampler's filtering of the two bytes
 * is the filtering of the number. Its span is 32 times the levels' greatest
 * reference extinction (`VOLUME_SIGMA_SPAN`), because a cloud holds its
 * genus's extinction inside it by a gain of 1 to 29.5 over the reference
 * (`levelStatistics`), and a byte's root under one reference clipped every
 * cloud to it.
 *
 * **Every level bakes the resolved field wherever its texel is under a
 * cell.** The field's read is the resolved field up to a switch,
 * `cell·4^(dither − 1)`, and the level's statistics past it; the bake reads
 * at its level's texel with the dither at one, the switch at a whole cell.
 * So the 200 m level is the resolved field under every genus, and the
 * 800 m level is under every genus but fog, whose cell is 500 m. A
 * sun ray's depth is a sum along one line, and the sum of the resolved field
 * is that line's own depth. The statistics are a share and a depth to mix by
 * the crossing's law; summed as an extinction they are the mean density,
 * which passes `e^(−F·τ)` where the level passes `(1 − F) + F·e^(−τ)`. The
 * bake adds nothing back at a read: the field fades no detail by footprint,
 * so a texel is the field at its center and a read between texels is the
 * sampler's.
 *
 * **It holds the frame's 200 m and 800 m levels, and not its 50 m one**
 * (`CLOUD_VOLUME_HELD`). The grid's cell is 400 m and a step of its bake is
 * 300 m or more through a 10 km union, so a 50 m level is point-sampled
 * once a cell and once a step, and what it would buy is small: without
 * it no row of the sun gate is worse than with it by more than 0.0006 RMS of the sun over its 22.5 km at four taps, and within 4 km of
 * the eye by no more than 0.010 (altocumulus under a 5° sun, 0.045 against
 * 0.055; `cloudSunAccuracy.gpu.test.ts`, by ring, on the Mac mini's M6).
 * It would cost half again the bytes, 4,456,448, and 34 more slices a
 * rebuild. Within 6.4 km of the eye the 200 m level answers where a 50 m
 * one would have.
 *
 * **A level is read only where every one of its slices holds this anchor's
 * texels.** A slice is baked whole, at the window the level has that frame,
 * so after the window moves the slices not yet redrawn still hold the old
 * window (toroidally, the strip it exposed holds the strip it left), and the
 * level is trusted only on the intersection of the windows its slices were
 * baked at, a texel in from each edge so a trilinear read never reaches a
 * texel outside it. Where no level is trusted the medium is the field itself
 * (`bake`), which is how a sun ray is followed past the coarsest level's
 * 102 km.
 *
 * **No frame bakes more than the cap** (`CloudBudget.slices`), whatever
 * happened: `sunSourceStep` is the schedule, and this module keeps its state
 * and draws what it answers. The anchor moving, the field's time jumping,
 * the weather changing and a level waking from idle each leave slices
 * holding nothing, and they come back at the cap, the finest level first.
 * Until they have, the grid bakes nothing and its weight is zero
 * (`trusted`). A whole level is redrawn at the pace its field moves, a slice
 * before the fastest layer has crossed a tenth of a texel, so a field that
 * stands still is not baked again.
 *
 * **It bakes only from maps that owe nothing** (`sources`). A slice baked
 * while the cube or the clipmap still holds the last field would be called
 * this field's, and under a clock that is held no pace would redraw it.
 *
 * **A table landing is a field event.** A body draws nothing until its
 * levels' statistics tables are in (`CloudProfile.ready`), and the table
 * carries the gain every resolved read is multiplied by. So the volume bakes
 * nothing for a body whose tables are owed, and starts over when the
 * profile's `generation` moves, as it does on a new weather.
 */

export const CLOUD_VOLUME_SIZE = 256
/** Plus 2 guard slices a level, stacked in z. */
export const CLOUD_VOLUME_SLICES = 32
/** The levels a frame lays out about the eye, meters a texel (`cloudFrame.ts`). */
export const CLOUD_VOLUME_TEXELS = [50, 200, 800] as const
/** The frame's levels the volume holds, finer first: its 200 m and 800 m ones. */
export const CLOUD_VOLUME_HELD = [1, 2] as const

/** The pass's name on the timeline. */
export const CLOUD_VOLUME_LABEL = 'cloud volume'

const LEVELS = CLOUD_VOLUME_HELD.length
/** A level's slices with its two guards. */
const STACK = CLOUD_VOLUME_SLICES + 2
const DEPTH = LEVELS * STACK
/** RG8. */
const TEXEL_BYTES = 2
/** The extinction the two bytes hold at their greatest, in the levels' greatest reference extinction. */
export const VOLUME_SIGMA_SPAN = 32
/** The dither the bake reads the field at: the switch to a level's statistics at a whole cell. */
const BAKE_DITHER = 1
/** Meters: a footprint past every level's cell, where the field answers with its statistics. */
const UNRESOLVED = 1e6
/** Texels in from a trusted window's edges: a trilinear read reaches half a texel. */
const MARGIN = 1
/** A rectangle nothing is inside: lattice x0, y0, x1, y1. */
const NOWHERE = [1, 1, 0, 0] as const

export interface CloudVolumeDeps {
  readonly uniforms: CloudUniforms
  /** What it caches: the field. */
  readonly bake: CloudMediumFn
  /** What the field is read from: no slice is baked while one of them owes work. */
  readonly sources?: readonly { readonly pending: boolean }[]
  /**
   * What the field's tables answer for the served body: whether they are all
   * in, and a count that moves when one lands. A field with no tables is
   * always ready at one generation.
   */
  readonly tables?: { readonly ready: boolean; readonly generation: number }
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

/** Where in the volume a point is read: its level, or the count of levels where none is trusted. */
interface Held {
  /** The finest trusted level holding the point, as the volume stacks them, from 0; the count of levels where none does. */
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

const modulo = (value: number, size: number): number =>
  ((value % size) + size) % size

/**
 * Meters the fastest thing in the served field moved this frame: the wind's
 * drift or a level's turn about the spin axis, whichever is faster, over the
 * field's own step of time. What every cache of the field paces itself by
 * (`owedByMotion`).
 */
export function cloudFieldTravel(frame: CloudFrame): number {
  const { served } = frame
  const { boundaries } = served.shells
  const top = boundaries[boundaries.length - 1] ?? 0
  const turn = served.levels.reduce(
    (most, level) => Math.max(most, Math.abs(level.turnRate)),
    0,
  )
  const speed = Math.max(
    Math.hypot(served.wind.x, served.wind.y, served.wind.z),
    turn * (served.datumRadius + top),
  )
  return speed * Math.abs(frame.frameSeconds)
}

/** A sample read with the switch at a whole cell: the resolved field wherever the footprint is under one. */
const resolved = (sample: CloudSample): CloudSample => ({
  ...sample,
  dither: float(BAKE_DITHER),
})

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
   * One read a step of the grid's sun ray: the texel's extinction, the
   * cloudy share in it, at the finest level holding the sample; the field,
   * read as the bake reads it, where no level holds it. Read at level 0.
   * Statements: built inside a `Fn`.
   */
  readonly medium: CloudMediumFn

  readonly #deps: CloudVolumeDeps
  /*
   * Linear by name: a `RenderTarget3D` takes its minification filter from
   * the options and keeps `Data3DTexture`'s nearest magnification, and a read
   * at level 0 magnifies. Nearest, a cloudy texel reads as a 200 m box a ray
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
  #state: SunSourceState = freshSunSource(LEVELS, STACK)
  #weather: string | null = null
  #address: string | null = null
  #period: readonly [number, number] | null = null
  /** The tables' generation the slices were baked under. */
  #tables: number | null = null
  #last: number | null = null
  #pending = false
  #whole = false
  #drawn: readonly number[] = Array.from({ length: LEVELS }, () => 0)
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

  /** The union's base, and its slice height. */
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
    let level: Node<'float'> = float(LEVELS)
    let lattice: Node<'vec2'> = vec2(0)
    let texel: Node<'float'> = float(
      CLOUD_VOLUME_TEXELS[CLOUD_VOLUME_HELD[LEVELS - 1]!],
    )
    for (let L = LEVELS - 1; L >= 0; L -= 1) {
      const frame = body.volume[CLOUD_VOLUME_HELD[L]!]!
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
    If(held.level.lessThan(LEVELS - 0.5), () => {
      const z = held.level.mul(STACK).add(1).add(held.slice).div(DEPTH)
      const read = this.#volume
        .sample(vec3(held.lattice.div(CLOUD_VOLUME_SIZE), z))
        .level(float(0))
      const shell = layerAt(layers, sample.altitude)
      // The texel's sixteen bits: the cloudy share is in the extinction.
      sigma.assign(
        read.x
          .mul(256)
          .add(read.y)
          .mul((255 / 65535) * VOLUME_SIGMA_SPAN)
          .mul(layers.sigmaScale),
      )
      fraction.assign(1)
      layer.assign(shell.index)
      column.assign(held.texel)
      radius.assign(layerRadius(shell))
    }).Else(() => {
      const field = this.#deps.bake(resolved(sample), body)
      sigma.assign(field.sigma)
      fraction.assign(field.fraction)
      layer.assign(field.layer)
      column.assign(field.column)
      radius.assign(field.radius)
    })
    return { sigma, fraction, layer, column, radius, depth: vec2(0) }
  }

  /**
   * The level's statistics at a point's column, from the field itself and
   * never from a texel: what a crossing mixed by the law takes. A field with
   * no statistics answers one column of what it holds there, through its
   * level's whole thickness.
   */
  statistics(
    sample: CloudSample,
    body: CloudBodyUniforms,
  ): CloudLevelStatistics {
    const field = this.#deps.bake(
      { ...sample, footprint: float(UNRESOLVED) },
      body,
    )
    if (field.statistics !== undefined) return field.statistics
    const shell = layerAt(body.layers, sample.altitude)
    return {
      fraction: field.fraction,
      depth: field.sigma.mul(shell.thickness),
      shape: float(UNSPREAD_SHAPE),
      sight: field.column,
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The bake                                                                 */
  /* ----------------------------------------------------------------------- */

  /** One slice of one level: the field at each texel's center, read at the level's texel. */
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
        resolved({
          offset,
          distance: length(offset),
          altitude: height,
          sunMu: sunMuAt(body, offset),
          footprint: level.texel,
        }),
        body,
      )
      // Sixteen bits over two bytes, the high byte whole: the target rounds
      // the low one.
      const code = saturate(
        medium.sigma
          .mul(medium.fraction)
          .div(body.layers.sigmaScale.mul(VOLUME_SIGMA_SPAN)),
      ).mul(65535)
      const high = floor(code.div(256))
      return vec4(high.div(255), code.sub(high.mul(256)).div(255), 0, 1)
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
    const { served } = frame
    const frames = CLOUD_VOLUME_HELD.map((L) => served.volume.frames[L])
    const { boundaries, eye } = served.shells
    const top = boundaries[boundaries.length - 1] ?? 0
    const [low, high] = frame.period
    const tables = this.#deps.tables ?? { ready: true, generation: 0 }
    // A weather's union, its slices' heights and its σ scale are all the
    // texels hold, so another weather is another volume; a pattern that
    // draws its cells again is another field under the same name; and a
    // table that lands is the gain every texel was baked without.
    const reset =
      this.#last === null ||
      frame.frameIndex !== this.#last + 1 ||
      frame.jump ||
      budget.jump ||
      served.weatherKey !== this.#weather ||
      served.address !== this.#address ||
      low !== this.#period?.[0] ||
      high !== this.#period?.[1] ||
      tables.generation !== this.#tables
    this.#weather = served.weatherKey
    this.#address = served.address
    this.#period = [low, high]
    this.#tables = tables.generation
    this.#last = frame.frameIndex
    const travel = cloudFieldTravel(frame)
    const step = sunSourceStep(this.#state, {
      frame: frame.frameIndex,
      reset,
      ready:
        tables.ready &&
        (this.#deps.sources ?? []).every((source) => !source.pending),
      cap: budget.slices,
      levels: frames.map((level, L) => ({
        origin: level?.origin ?? [0, 0],
        epoch: level?.epoch ?? -1,
        rebuilt: served.volume.rebuilt[CLOUD_VOLUME_HELD[L]!] === true,
        // A level whose window lies more than its own extent below the eye
        // is out of reach of every sun ray the grid follows: from orbit,
        // none is baked.
        idle:
          level === undefined ||
          eye - top > CLOUD_VOLUME_SIZE * level.texelMeters,
        owed: level === undefined ? 0 : owedByMotion(travel, level.texelMeters),
      })),
    })
    this.#state = step.state
    this.#whole = step.trusted
    this.#pending = step.pending
    this.#bake(renderer, frames, step.bake)
    this.#publish()
  }

  #bake(
    renderer: WebGPURenderer,
    frames: readonly (LevelFrame | undefined)[],
    work: readonly SunSourceBake[],
  ): void {
    const drawn = Array.from({ length: LEVELS }, () => 0)
    if (work.length > 0)
      runQuadPasses(
        renderer,
        this.#quad,
        // Each slice replaces every texel it covers: nothing to clear.
        { linear: true, autoClear: false },
        (draw) => {
          for (const { level, slice } of work) {
            // The schedule bakes no slice of a level the frame did not lay out.
            const at = frames[level]
            if (at === undefined) continue
            this.#bakeAt(at, slice)
            draw(
              CLOUD_VOLUME_LABEL,
              this.#target,
              this.#material,
              level * STACK + slice,
            )
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

  /** Each level's trusted rectangle: the intersection of its slices' windows, and nowhere while it idles. */
  #publish(): void {
    this.#state.levels.forEach((level, L) => {
      // An idle level keeps the slices it had and the schedule draws none of
      // them, so what it holds is of no window the eye is near.
      const rect = level.idle
        ? null
        : trustedWindow(level.slices, CLOUD_VOLUME_SIZE)
      const [x0, y0, x1, y1] = rect ?? NOWHERE
      this.#trusted[L]!.value.set(x0, y0, x1, y1)
    })
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

  /** No slice holds anything, and the next frame is a first one: every reader of the volume starts over with it. */
  #forget(): void {
    this.#state = {
      ...freshSunSource(LEVELS, STACK),
      generation: this.#state.generation,
    }
    for (const rect of this.#trusted) rect.value.set(...NOWHERE)
    this.#whole = false
    this.#last = null
  }

  /** Work due at this frame's state: a level not yet whole, or a slice at a window it has left. */
  get pending(): boolean {
    return this.#pending
  }

  /** Slices baked this frame, by held level: what the schedule spent. */
  get drawn(): readonly number[] {
    return this.#drawn
  }

  /**
   * Every awake level held this field in every slice when the frame began:
   * what the sun grid may bake from (`sunSourceStep`).
   */
  get trusted(): boolean {
    return this.#whole
  }

  /** Counts the field's events: a reader baked under another count holds another field. */
  get generation(): number {
    return this.#state.generation
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
      // uniforms last held. A warm-up that arrives after a frame has baked,
      // a chain rebuilt with the levers on, draws over the finest level's
      // lower guard while its record still says whole, so a cache at its
      // real size owes every slice again.
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
  /** The cube and the clipmap the medium reads its cover from. */
  readonly maps: { readonly pending: boolean }
  readonly clipmap: { readonly pending: boolean }
  /** The profile the medium reads its levels' statistics tables from. */
  readonly profile: CloudProfile
}): CloudVolume {
  const { profile } = deps
  return new CloudVolume({
    uniforms: deps.uniforms,
    bake: deps.medium,
    sources: [deps.maps, deps.clipmap],
    tables: {
      // The served body's slot: the volume caches no other body.
      get ready() {
        return profile.ready[0].value > 0.5
      },
      get generation() {
        return profile.generation
      },
    },
  })
}
