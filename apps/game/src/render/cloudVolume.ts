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
import {
  freshSunSource,
  type LevelFrame,
  owedByMotion,
  type SunSourceBake,
  type SunSourceState,
  sunSourceStep,
  textureBytes,
  trustedWindow,
} from '@inertialref/rendering'
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
 * The local volume: the field cached in two eye-anchored levels of
 * 256² × 32 RG8 texels, R = √(σ/σ_scale) and G the fraction, stacked with a
 * guard slice under and over each level in one `RenderTarget3D`. It is what
 * the sun grid sums its optical depth through (`cloudSunGrid.ts`), and
 * nothing else reads it: the trace marches the field itself.
 *
 * **Its levels are the frame's 200 m and 800 m.** The grid's cell is 400 m
 * and a step of its bake is 300 m or more through a 10 km union, so a finer
 * level would be point-sampled once a cell and once a step: detail the grid
 * cannot store, where the 200 m level holds the field already averaged. The
 * frame lays out a 50 m level too (`CLOUD_VOLUME_TEXELS`), and the volume
 * holds none of it.
 *
 * **A level is read only where every one of its slices holds this anchor's
 * texels.** A slice is baked whole, at the window the level has that frame,
 * so after the window moves the slices not yet redrawn still hold the old
 * window (toroidally, the strip it exposed holds the strip it left), and the
 * level is trusted only on the intersection of the windows its slices were
 * baked at, a texel in from each edge so a trilinear read never reaches a
 * texel outside it. Where no level is trusted the medium is the field itself
 * (`bake`), which is how a sun ray is followed past the coarse level's
 * 102 km.
 *
 * **No frame bakes more than the cap** (`CloudBudget.slices`), whatever
 * happened: `sunSourceStep` is the schedule, and this module keeps its state
 * and draws what it answers. The anchor moving, the field's time jumping,
 * the weather changing and a level waking from idle each leave slices
 * holding nothing, and they come back at the cap, the finer level first.
 * Until they have, the grid bakes nothing and its weight is zero
 * (`trusted`). A whole level is redrawn at the pace its field moves, a slice
 * before the fastest layer has crossed a tenth of a texel, so a field that
 * stands still is not baked again.
 *
 * **It bakes only from maps that owe nothing** (`sources`). A slice baked
 * while the cube or the clipmap still holds the last field would be called
 * this field's, and under a clock that is held no pace would redraw it.
 *
 * **The bake's footprint is the level's texel.** The field fades its detail
 * and mixes in its unresolved share by footprint, so each level caches the
 * field as seen at its own resolution, and a read finer than that adds the
 * detail erosion the bake left out.
 */

export const CLOUD_VOLUME_SIZE = 256
/** Plus 2 guard slices a level, stacked in z. */
export const CLOUD_VOLUME_SLICES = 32
/** The levels a frame lays out about the eye, meters a texel (`cloudFrame.ts`). */
export const CLOUD_VOLUME_TEXELS = [50, 200, 800] as const
/** The frame's levels the volume holds, finer first. */
export const CLOUD_VOLUME_HELD = [1, 2] as const

/** The pass's name on the timeline. */
export const CLOUD_VOLUME_LABEL = 'cloud volume'

const LEVELS = CLOUD_VOLUME_HELD.length
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
  /** What the field is read from: no slice is baked while one of them owes work. */
  readonly sources?: readonly { readonly pending: boolean }[]
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

/** Where in the volume a point is read: its level, or 2 where none is trusted. */
interface Held {
  /** 0 or 1, the finer trusted level holding the point, as the volume stacks them; 2 where neither does. */
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
   * at the finer level holding the sample, plus detail-noise erosion where
   * the footprint is finer than the level's texel; the field where neither
   * level holds it. Read at level 0. Statements: built inside a `Fn`.
   */
  readonly medium: CloudMediumFn

  readonly #deps: CloudVolumeDeps
  /*
   * Linear by name: a `RenderTarget3D` takes its minification filter from
   * the options and keeps `Data3DTexture`'s nearest magnification, and a read
   * at level 0 magnifies. Nearest, a cloudy texel reads as a 200 m box under
   * a grid whose cells are laid half a texel off its centers.
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
    const { served } = frame
    const frames = CLOUD_VOLUME_HELD.map((L) => served.volume.frames[L])
    const { boundaries, eye } = served.shells
    const top = boundaries[boundaries.length - 1] ?? 0
    const [low, high] = frame.period
    // A weather's union, its slices' heights and its σ scale are all the
    // texels hold, so another weather is another volume; and a pattern that
    // draws its cells again is another field under the same name.
    const reset =
      this.#last === null ||
      frame.frameIndex !== this.#last + 1 ||
      frame.jump ||
      budget.jump ||
      served.weatherKey !== this.#weather ||
      served.address !== this.#address ||
      low !== this.#period?.[0] ||
      high !== this.#period?.[1]
    this.#weather = served.weatherKey
    this.#address = served.address
    this.#period = [low, high]
    this.#last = frame.frameIndex
    const travel = cloudFieldTravel(frame)
    const step = sunSourceStep(this.#state, {
      frame: frame.frameIndex,
      reset,
      ready: (this.#deps.sources ?? []).every((source) => !source.pending),
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
      // a chain rebuilt with the levers on, draws over the finer level's
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
  readonly noise: { readonly nodes: CloudNoiseNodes }
  /** The cube and the clipmap the medium reads its cover from. */
  readonly maps: { readonly pending: boolean }
  readonly clipmap: { readonly pending: boolean }
}): CloudVolume {
  return new CloudVolume({
    uniforms: deps.uniforms,
    bake: deps.medium,
    detail: deps.noise.nodes,
    sources: [deps.maps, deps.clipmap],
  })
}
