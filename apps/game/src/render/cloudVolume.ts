import {
  type ComputeNode,
  LinearFilter,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget3D,
  RepeatWrapping,
  RGFormat,
  type Storage3DTexture,
  type Texture,
  type TextureNode,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  clamp,
  dot,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  int,
  ivec3,
  length,
  Loop,
  max,
  min,
  saturate,
  screenCoordinate,
  select,
  smoothstep,
  sqrt,
  storageTexture3D,
  texture3D,
  textureStore,
  uint,
  uniform,
  uniformArray,
  uvec3,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  type LevelFrame,
  textureBytes,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { CloudFrame } from './cloudFrame.ts'
import type { CloudLevers } from './cloudLevers.ts'
import { levelOffset, levelPlane, sunMuAt } from './cloudGeometry.ts'
import {
  type CloudBudget,
  type CloudMedium,
  type CloudMediumFn,
  type CloudRay,
  type CloudResource,
  type CloudSample,
  cloudStorage3DTexture,
} from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import type {
  CloudBodyUniforms,
  CloudLayerUniforms,
  CloudLevelUniforms,
  CloudUniforms,
} from './cloudUniforms.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmCompute, warmSensorPass } from './warmup.ts'

/*
 * The local volume: the field cached in three eye-anchored levels of
 * 256² × 32 RG8 texels — R = √(σ/σ_scale), G = the fraction — stacked with a
 * guard slice under and over each level in one `RenderTarget3D`, baked a few
 * slices a frame, and a max-mip bound of 4³ bricks dilated by a texel so a
 * step through empty space can jump to its brick's exit (§3.11).
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

/** The passes' names on the timeline. */
export const CLOUD_VOLUME_LABEL = 'cloud volume'
export const CLOUD_VOLUME_BOUND_LABEL = 'cloud volume bound'

const LEVELS = CLOUD_VOLUME_TEXELS.length
/** A level's slices with its two guards. */
const STACK = CLOUD_VOLUME_SLICES + 2
const DEPTH = LEVELS * STACK
const BRICK = 4
const BRICKS = CLOUD_VOLUME_SIZE / BRICK
const BRICK_LAYERS = CLOUD_VOLUME_SLICES / BRICK
/**
 * A brick layer of each level is a z-slot of the bound: 24 in all. Its
 * dilation reaches one slice past each end of a level's 32, which is what
 * the guard slices hold, so no slot needs a guard of its own.
 */
const SLOTS = LEVELS * BRICK_LAYERS
const BRICKS_A_LAYER = BRICKS * BRICKS
/** RG8, and the bound's RGBA8. */
const TEXEL_BYTES = 2
const BOUND_TEXEL_BYTES = 4
/** Texels in from a trusted window's edges: a trilinear read reaches half a texel. */
const MARGIN = 1
/** Floor under a texel's share of a chord, so a level ray's rate is never 0/0. */
const NO_RATE = 1e-12
/** Meters past a brick's face a skip lands, so a ray never stalls on one. */
const PAST_FACE = 0.5
/** A rectangle nothing is inside: lattice x0, y0, x1, y1. */
const NOWHERE = [1, 1, 0, 0] as const

/** The volume is drawn when either the cache or the grid summed through it is selected. */
export function volumeSelected(levers: CloudLevers): boolean {
  return levers.cache === 'volume' || levers.sunDepth === 'grid'
}

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

/** The layer whose shell holds `height`, by component, and its numbers. */
function layerAt(
  layers: CloudLayerUniforms,
  height: Node<'float'>,
): {
  readonly index: Node<'int'>
  readonly sigma: Node<'float'>
  readonly erosion: Node<'float'>
  readonly cell: Node<'float'>
  readonly radius: Node<'float'>
} {
  const components = ['x', 'y', 'z'] as const
  let index: Node<'int'> = int(-1)
  let sigma: Node<'float'> = float(0)
  let erosion: Node<'float'> = float(0)
  let cell: Node<'float'> = float(1)
  let radius: Node<'float'> = float(10)
  // Top layer first, so the lowest that holds the sample is the last select.
  for (let k = components.length - 1; k >= 0; k -= 1) {
    const c = components[k]!
    const inside = height
      .greaterThanEqual(layers.base[c])
      .and(height.lessThan(layers.top[c]))
    index = select(inside, int(k), index)
    sigma = select(inside, layers.sigma[c], sigma)
    erosion = select(inside, layers.erosion[c], erosion)
    cell = select(inside, layers.cell[c], cell)
    radius = select(inside, layers.radius[c], radius)
  }
  return { index, sigma, erosion, cell, radius }
}

/** TSL's `Loop` over three ranges, which `@types/three` declares up to two of. */
const loopOver3 = Loop as unknown as (
  i: number,
  j: number,
  k: number,
  body: (inputs: {
    readonly i: Node<'int'>
    readonly j: Node<'int'>
    readonly k: Node<'int'>
  }) => void,
) => void

/** The detail the field keeps at a footprint, §5.6's fade_d. */
const detailFade = (
  footprint: Node<'float'>,
  cell: Node<'float'>,
): Node<'float'> =>
  float(1).sub(smoothstep(cell.div(16), cell.div(4), footprint))

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
   * One read a step: R = √(σ/σ_scale), G = fraction, at the finest level
   * holding the sample, plus detail-noise erosion where the footprint is finer
   * than the level's texel; the field where no level holds it. Level 0.
   * Statements: built inside a `Fn`.
   */
  readonly medium: CloudMediumFn

  readonly #deps: CloudVolumeDeps
  /*
   * Linear by name: a `RenderTarget3D` takes its minification filter from
   * the options and keeps `Data3DTexture`'s nearest magnification, and a read
   * at level 0 magnifies. Nearest, a cloudy texel reads as a 50 m box a ray
   * can clip in under a step, and the bound's dilation covers a filter that
   * is not there.
   */
  readonly #target = new RenderTarget3D(1, 1, 1, {
    type: UnsignedByteType,
    format: RGFormat,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    depthBuffer: false,
  })
  readonly #boundMap: Storage3DTexture = cloudStorage3DTexture(
    1,
    1,
    1,
    'rgba8unorm',
    'cloud volume bound',
  )
  readonly #volume: TextureNode
  readonly #boundRead: TextureNode
  /** Per level, the lattice rectangle the reads trust: x0, y0, x1, y1. */
  readonly #trusted = Array.from({ length: LEVELS }, () =>
    uniform(new Vector4(...NOWHERE)),
  )
  readonly #bakeLevel = bakeLevelUniforms()
  readonly #bakeOriginMod = uniform(new Vector2())
  readonly #bakeSlice = uniform(0)
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #slots = uniformArray(new Array<number>(SLOTS).fill(0), 'float')
  readonly #slotCount = uniform(0, 'uint')
  readonly #boundKernel: ComputeNode
  readonly #levels: LevelState[] = Array.from({ length: LEVELS }, freshLevel)
  #scenario: WeatherScenario | null = null
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
    this.#boundRead = texture3D(this.#boundMap)
    this.#material.name = 'cloud volume'
    this.#material.fragmentNode = this.#bakeNode()
    this.#boundKernel = this.#boundNode()
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
    const layers = this.#deps.uniforms.layers
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
        detailFade(sample.footprint, shell.cell).sub(
          detailFade(held.texel, shell.cell),
        ),
        0,
      ).mul(shell.erosion)
      If(erosion.greaterThan(0).and(shell.sigma.greaterThan(0)), () => {
        const cells = body.detailOrigin
          .add(sample.offset)
          .add(body.drift)
          .mul(float(4).div(shell.cell))
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
      radius.assign(shell.radius)
    }).Else(() => {
      const field = this.#deps.bake(sample, body)
      sigma.assign(field.sigma)
      fraction.assign(field.fraction)
      layer.assign(field.layer)
      column.assign(field.column)
      radius.assign(field.radius)
    })
    return { sigma, fraction, layer, column, radius }
  }

  /**
   * The largest R over the sample's 4³ brick and one texel around it: zero
   * means no trilinear read anywhere in the brick can see cloud. 1 where no
   * level holds the sample, so nothing is skipped through the field.
   */
  bound(sample: CloudSample, body: CloudBodyUniforms): Node<'float'> {
    const held = this.#held(sample.offset, sample.altitude, body)
    const brick = wrapped(floor(held.lattice.div(BRICK)), BRICKS)
    const layer = clamp(floor(held.slice.div(BRICK)), 0, BRICK_LAYERS - 1)
    const slot = min(held.level, LEVELS - 1)
      .mul(BRICK_LAYERS)
      .add(layer)
    const largest = this.#boundRead.load(ivec3(vec3(brick, slot))).x
    return select(held.level.lessThan(2.5), largest, float(1))
  }

  /**
   * The distance along the ray at which it leaves the brick holding the
   * sample: the least over the brick's three axes of the distance to its far
   * face over that coordinate's rate along the ray at the sample, formed
   * analytically — d(u)/dt = R·(e·A)·(d·E − (e·E)(d·A)/(e·A))/(e·A + o·A)²
   * from `levelPlane`, dh/dt = (r_e·μ + t)/(R + h) from §5.3 — plus half a
   * meter so a ray never stalls on a face. Over a 200 m brick the curvature
   * this takes as straight is under 3 mm, and over any brick it is under a
   * texel, which the bound's dilation already covers.
   */
  brickExit(
    sample: CloudSample,
    ray: CloudRay,
    body: CloudBodyUniforms,
  ): Node<'float'> {
    const held = this.#held(sample.offset, sample.altitude, body)
    const { slice } = this.#vertical(body)
    const R = body.datumRadius
    // The held level's frame, chosen as `held` chose it.
    const pick = <T extends Node<'vec3'> | Node<'float'>>(
      of: (frame: CloudLevelUniforms) => T,
    ): T => {
      let value = of(body.volume[LEVELS - 1]!)
      for (let L = LEVELS - 2; L >= 0; L -= 1)
        value = select(held.level.equal(L), of(body.volume[L]!), value) as T
      return value
    }
    const anchor = pick((frame) => frame.anchor)
    const east = pick((frame) => frame.east)
    const north = pick((frame) => frame.north)
    const along = pick((frame) => frame.along)
    const eA = along.x
    const a = dot(ray.direction, anchor)
    const denominator = eA.add(dot(sample.offset, anchor))
    const scale = R.mul(eA).div(denominator.mul(denominator)).div(held.texel)
    const rateU = scale.mul(
      dot(ray.direction, east).sub(along.y.mul(a).div(eA)),
    )
    const rateV = scale.mul(
      dot(ray.direction, north).sub(along.z.mul(a).div(eA)),
    )
    const rateH = body.datumRadius
      .add(body.eye)
      .mul(ray.mu)
      .add(sample.distance)
      .div(R.add(sample.altitude))
      .div(slice)
    const toFace = (x: Node<'float'>, rate: Node<'float'>): Node<'float'> => {
      const cell = floor(x.div(BRICK))
      const ahead = select(
        rate.greaterThanEqual(0),
        cell.add(1).mul(BRICK).sub(x),
        x.sub(cell.mul(BRICK)),
      )
      return ahead.div(max(abs(rate), NO_RATE))
    }
    const step = min(
      min(toFace(held.lattice.x, rateU), toFace(held.lattice.y, rateV)),
      toFace(held.slice, rateH),
    )
    return sample.distance.add(
      select(held.level.lessThan(2.5), step, float(0)).add(PAST_FACE),
    )
  }

  /* ----------------------------------------------------------------------- */
  /* The bake and the bound                                                   */
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
      const encoded = sqrt(
        saturate(medium.sigma.div(uniforms.layers.sigmaScale)),
      )
      return vec4(encoded, saturate(medium.fraction), 0, 1)
    })()
  }

  /** Each listed brick's largest R over its 6³ footprint, toroidal across, guarded up. */
  #boundNode(): ComputeNode {
    const store = storageTexture3D(this.#boundMap)
    const read = texture3D(this.#target.texture)
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(this.#slotCount.mul(BRICKS_A_LAYER)), () => {
        const listed = instanceIndex.div(BRICKS_A_LAYER)
        const within = instanceIndex.mod(BRICKS_A_LAYER)
        const bx = int(within.mod(BRICKS))
        const by = int(within.div(BRICKS))
        // `@types/three` types an array element by no node type at all.
        const slot = int(
          this.#slots.element(listed) as unknown as Node<'float'>,
        )
        const level = slot.div(BRICK_LAYERS)
        const layer = slot.mod(BRICK_LAYERS)
        // The brick's first slice less one: level L's slices start at 34L + 1.
        const z0 = level.mul(STACK).add(layer.mul(BRICK))
        const largest = float(0).toVar()
        /*
         * One `Loop` of three ranges, never three `Loop`s nested: TSL names a
         * loop's index by its place among that loop's own ranges, so every
         * nested loop declares an `i`, the inner one shadows the outer, and
         * the footprint collapses onto its diagonal: a bound built that way
         * misses cloud in one brick in seven, one in three at level 1.
         */
        loopOver3(
          BRICK + 2,
          BRICK + 2,
          BRICK + 2,
          ({ i: dz, j: dy, k: dx }) => {
            const x = bx
              .mul(BRICK)
              .add(int(dx))
              .sub(1)
              .add(CLOUD_VOLUME_SIZE)
              .mod(CLOUD_VOLUME_SIZE)
            const y = by
              .mul(BRICK)
              .add(int(dy))
              .sub(1)
              .add(CLOUD_VOLUME_SIZE)
              .mod(CLOUD_VOLUME_SIZE)
            largest.assign(
              max(largest, read.load(ivec3(x, y, z0.add(int(dz)))).x),
            )
          },
        )
        textureStore(
          store,
          uvec3(uint(bx), uint(by), uint(slot)),
          vec4(largest, 0, 0, 1),
        )
      })
    })().compute(SLOTS * BRICKS_A_LAYER)
    kernel.setName(CLOUD_VOLUME_BOUND_LABEL)
    return kernel
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
    if (!volumeSelected(frame.levers)) {
      this.#release()
      return
    }
    this.#allocate()
    this.#invalidate(frame, budget)
    const work = this.#schedule(frame, budget.slices)
    this.#bake(renderer, frame, work)
    this.#refreshBound(renderer, work)
    this.#publish(frame)
    this.#last = frame.frameIndex
  }

  /** What makes a level's slices hold nothing this frame's. */
  #invalidate(frame: CloudFrame, budget: CloudBudget): void {
    const { served, scenario } = frame
    const { boundaries, eye } = served.shells
    const top = boundaries[boundaries.length - 1] ?? 0
    // A scenario is a constant record, so a new one is a new object: its
    // union, its slices' heights and its σ scale are all the texels hold.
    const everything =
      this.#last === null ||
      frame.frameIndex !== this.#last + 1 ||
      frame.jump ||
      budget.jump ||
      scenario !== this.#scenario ||
      served.address !== this.#address
    this.#scenario = scenario
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

  /** The bound over every brick layer whose 6³ footprint a baked slice reached. */
  #refreshBound(renderer: WebGPURenderer, work: readonly Bake[]): void {
    const slots = new Set<number>()
    for (const { level, slice } of work) {
      // Brick layer b reads the level's slices 4b … 4b + 5, guards counted.
      const first = Math.max(0, Math.ceil((slice - (BRICK + 1)) / BRICK))
      const last = Math.min(BRICK_LAYERS - 1, Math.floor(slice / BRICK))
      for (let b = first; b <= last; b += 1) slots.add(level * BRICK_LAYERS + b)
    }
    if (slots.size === 0) return
    ;[...slots].forEach((slot, k) => {
      this.#slots.array[k] = slot
    })
    this.#slotCount.value = slots.size
    renderer.compute(this.#boundKernel, slots.size * BRICKS_A_LAYER)
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
        if (now !== undefined && !sameOrigin(origin, now)) pending = true
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

  /** Real size, the frame the levers first select it. */
  #allocate(): void {
    this.#allocated = true
    if (this.#target.width === CLOUD_VOLUME_SIZE) return
    this.#target.setSize(CLOUD_VOLUME_SIZE, CLOUD_VOLUME_SIZE, DEPTH)
    this.#boundMap.setSize(BRICKS, BRICKS, SLOTS)
    this.#forget()
  }

  /** Back to the 1 × 1 targets warming built against, holding nothing. */
  #release(): void {
    if (this.#target.width !== 1) {
      this.#target.setSize(1, 1, 1)
      this.#boundMap.setSize(1, 1, 1)
    }
    this.#forget()
    this.#pending = false
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
    const bound = this.#boundMap.image as {
      readonly width: number
      readonly height: number
      readonly depth: number
    }
    return (
      textureBytes(target.width, target.height, target.depth, TEXEL_BYTES) +
      textureBytes(bound.width, bound.height, bound.depth, BOUND_TEXEL_BYTES)
    )
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated
      ? []
      : [this.#target.texture, this.#boundMap]
  }

  /** The bake against a slice and the bound's kernel; a renderer with no backend builds nothing. */
  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed || renderer?.backend === undefined)
      return Promise.resolve()
    this.#allocated = true
    this.#warm ??= Promise.all([
      warmSensorPass(renderer, this.#quad, [
        { target: this.#target, material: this.#material },
      ]),
      warmCompute(renderer, [this.#boundKernel]),
    ]).then(() => undefined)
    return this.#warm
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#boundMap.dispose()
    this.#material.dispose()
    this.#boundKernel.dispose()
  }
}
