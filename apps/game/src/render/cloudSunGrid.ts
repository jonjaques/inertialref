import {
  HalfFloatType,
  LinearFilter,
  type Node,
  NodeMaterial,
  QuadMesh,
  RedFormat,
  RenderTarget3D,
  RepeatWrapping,
  type Texture,
  type TextureNode,
  Vector2,
  Vector3,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  clamp,
  exp,
  float,
  floor,
  Fn,
  If,
  length,
  log,
  Loop,
  max,
  min,
  saturate,
  screenCoordinate,
  select,
  sqrt,
  texture3D,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import {
  freshSunGrid,
  type LevelFrame,
  owedByMotion,
  owedBySun,
  type SunGridState,
  sunGridStep,
  sunWakeWeight,
  textureBytes,
  trustedWindow,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import type { CloudFrame } from './cloudFrame.ts'
import {
  altitudeAt,
  levelOffset,
  levelPlane,
  shellCrossingFrom,
  sunMuAt,
} from './cloudGeometry.ts'
import { crossingDepth, crossingExponent, spreadDepth } from './cloudMix.ts'
import type {
  CloudBudget,
  CloudResource,
  CloudSunDepthNodes,
  CloudSunDepths,
} from './cloudNodes.ts'
import type { CloudLevelUniforms, CloudUniforms } from './cloudUniforms.ts'
import {
  CLOUD_VOLUME_SIZE,
  CLOUD_VOLUME_TEXELS,
  cloudFieldTravel,
  type CloudVolume,
  wrapped,
} from './cloudVolume.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmByDrawing } from './warmup.ts'

/*
 * The sun's optical depth as a grid around the eye (Nubis³): τ from each
 * cell's center toward the sun, summed through the local volume in 32 steps
 * whose heights come from `altitudeAt` (rule 52), over the window of the
 * volume's 200 m level and 32 heights from the union's base to its top.
 *
 * **Its depth is the drawn medium's.** A cell sums the extinction the
 * volume's medium answers with, which is the one the march's transmittance
 * is formed from, so the sun dims inside a cloud at the rate the view does.
 *
 * **A cell holds an opacity, and a read answers the depth of the mean
 * transmittance** (`cellCode`, `cellDepth`). `toSun` and `whole` are
 * −ln of the mean of `e^(−τ)` over the eight cells a read filters, where
 * those are under a depth of six: a point between a lit cell and a
 * shadowed one reads the share of the sun each passes. Three things follow
 * for a reader. Between two slices of one column whose depths differ by Δ
 * a read is under their mean by about Δ²/8. Past a depth of six a cell
 * steps by 0.2 to 0.4 of a depth. And no cell holds more than 64.
 *
 * **Its frame is the volume's 200 m level.** A cell is two of that level's
 * texels, 400 m, on its anchor and plane, so the grid re-anchors exactly
 * when the level does; its window of 128 cells is centered on the eye in
 * that plane, as the level's 256 texels are, and scrolls toroidally. A slice
 * is drawn whole, at the window the grid has that frame, and the grid trusts
 * only the intersection of the windows its slices were drawn at, a cell in
 * from its edges.
 *
 * **No frame rebuilds it** (`sunGridStep`, which is the schedule; this
 * module keeps its state and draws what it answers). A new field, a moved
 * anchor and a wake from idle leave every slice holding nothing; they come
 * back at the frame's cap, and only from a volume that is whole, so no step
 * of a rebuild reads the field's five textures where the volume has one.
 * A whole grid is redrawn at the pace of what it holds: a slice before the
 * fastest layer has crossed a tenth of a cell, and before the sun has turned
 * a quarter of a degree from the one it was baked under. The cells are fixed
 * to the body and the sun is only the ray a bake follows, so two slices
 * baked a quarter of a degree apart disagree by 44 m of shadow in 10 km of
 * chord, against a 400 m cell, and a turning sun is not an event.
 *
 * **It answers with a weight, and the layers' statistics draw where the
 * weight is not one** (`cloudMix.ts`). The weight is the product of three:
 * the rebuild's, zero until every slice holds the field and rising over the
 * `sunRamp` lever's frames; the wake's, zero where the grid idles, more
 * than its level's extent over the union's top, and one a quarter of that
 * lower; and the reach's, one to 20.8 km from the eye along the grid's
 * axes and zero from 24 km. The last is measured from the eye and not from
 * the window's edge: the window moves a cell at a time, and a weight tied to
 * it would step at each snap. So the grid ends in a ramp, never in an edge
 * lit on one side and shadowed on the other.
 *
 * **Under a sun below a cell's horizon the bake follows the ray down and
 * stops where it leaves a level** (`#bakeNode`). What that ray meets when it
 * comes back up, hundreds of kilometers sunward, is one crossing a level by
 * the crossing's law, fed the level's own statistics there
 * (`CloudVolume.statistics`): its share, its depth turned along the chord,
 * its spread, and the length its cover holds over, which under a cirrus is
 * hundreds of kilometers where a cell of its genus is five.
 */

/** Over the window of the volume's 200 m level and the union's height. */
export const SUN_GRID_SIZE = [128, 128, 32] as const
/** Steps a cell's sun ray takes through the union. */
export const SUN_GRID_STEPS = 32
/** The pass's name on the timeline. */
export const CLOUD_SUN_GRID_LABEL = 'cloud sun grid'
/** Meters from the eye along the grid's axes: where its weight reaches zero, and the stretch it falls over. */
export const SUN_GRID_REACH = 24_000
export const SUN_GRID_FADE = 3_200

const [WIDTH, HEIGHT, SLICES] = SUN_GRID_SIZE
/** The frame's level the grid's cells are laid on: its 200 m one. */
const LEVEL = 1
/** A cell is two of that level's texels: 128 cells span its 256. */
const CELL_METERS = (CLOUD_VOLUME_TEXELS[LEVEL] * CLOUD_VOLUME_SIZE) / WIDTH
/** R16F. */
const TEXEL_BYTES = 2
/** Cells in from a trusted window's edge: a trilinear read reaches half a cell. */
const MARGIN = 1
const NOWHERE = [1, 1, 0, 0] as const
/**
 * The 200 m level's frame at the grid's cells: its anchor, axes and eye
 * terms, and a window of the grid's size whose middle corner is the eye's
 * nearest, as `levelFrames` places a level's.
 */
function gridFrame(level: LevelFrame): LevelFrame {
  const corner = (plane: number): number =>
    Math.floor(plane / CELL_METERS + 0.5) - Math.floor(WIDTH / 2)
  return {
    ...level,
    texelMeters: CELL_METERS,
    size: WIDTH,
    origin: [corner(level.eye[0]), corner(level.eye[1])],
  }
}

/** The angle between two unit vectors, radians, from their cross product: an arccosine loses a turn of a millionth of a radian. */
function turned(a: Vec3, b: Vec3): number {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  return Math.atan2(Math.hypot(x, y, z), a.x * b.x + a.y * b.y + a.z * b.z)
}

const modulo = (value: number, size: number): number =>
  ((value % size) + size) % size

/*
 * What a cell holds of its depth τ: the opacity `1 − e^(−τ)` up to a depth
 * of six, and past it the same curve's tangent there, to a depth of 64.
 *
 * A read filters eight cells, and what it filters is what the cell holds.
 * Held as depths, a point between a clear ray and a ray through cloud reads
 * half the cloud's depth, and `e^(−τ/2)` of a depth of ten is 0.007 where
 * half the sun reaches the points beside it: every cloud's edge is dark for
 * a cell's width, and a field of broken cloud reads darker than it is by
 * the share of it that is edge. Held as opacities the same read is the mean
 * transmittance of the eight, which is what a cell 400 m wide can say of
 * the sun inside it.
 *
 * Past a depth of six nothing of the beam is left to bias, 0.0025 of it,
 * and the opacity runs out of a half float's steps: one step under one is
 * 0.0005, a twentieth of a depth at four and a fifth at six. So the curve
 * goes on along its tangent, where a step is 0.2 to 0.4 of a depth, for the
 * depth the light after first order reads. The cap is past that light's
 * table, 16 in transport depth; uncapped, a cell a thousand deep would
 * outweigh seven clear ones.
 */
/** The depth a cell's opacity gives way to its tangent at, and the greatest depth a cell holds. */
export const SUN_GRID_KNEE = 6
export const SUN_GRID_DEEPEST = 64
const KNEE = SUN_GRID_KNEE
const KNEE_PASSED = Math.exp(-KNEE)
const KNEE_CODE = 1 - KNEE_PASSED
const DEEPEST = SUN_GRID_DEEPEST

/** A depth as a cell holds it. */
function cellCode(depth: Node<'float'>): Node<'float'> {
  return select(
    depth.lessThan(KNEE),
    float(1).sub(exp(depth.negate())),
    min(depth, DEEPEST).sub(KNEE).mul(KNEE_PASSED).add(KNEE_CODE),
  )
}

/** The depth a filtered read of cells stands for: −ln of their mean transmittance under the knee. */
function cellDepth(code: Node<'float'>): Node<'float'> {
  return select(
    code.lessThan(KNEE_CODE),
    log(max(float(1).sub(code), KNEE_PASSED)).negate(),
    code.sub(KNEE_CODE).div(KNEE_PASSED).add(KNEE),
  )
}

/** A stretch of a ray: where it starts, meters along, and how long it is. */
interface Stretch {
  readonly from: Node<'float'>
  readonly length: Node<'float'>
}

/** What the grid answers with: the contract's three, and how far it holds the ray's far end. */
export interface CloudSunGridDepths extends CloudSunDepths {
  /**
   * The grid's share of the depth behind the point, 0..1: `whole` is `toSun`
   * plus this share of what lies between the point and the ray's far end.
   * It falls to zero as that end leaves the grid's reach, 23 km behind a
   * point 2 km over the base at a 5° sun, and there the part behind is the
   * statistics' to give.
   */
  readonly behind: Node<'float'>
}

/** What the grid reads of the volume: its medium, its field's statistics, and whether a slice may be baked from it. */
export type CloudSunSource = Pick<
  CloudVolume,
  'medium' | 'statistics' | 'trusted' | 'generation'
>

export class CloudSunGrid implements CloudResource, CloudSunDepthNodes {
  readonly name = 'sunGrid'
  readonly #uniforms: CloudUniforms
  readonly #volume: CloudSunSource
  /** Linear by name: a `RenderTarget3D` keeps `Data3DTexture`'s nearest magnification. */
  readonly #target = new RenderTarget3D(1, 1, 1, {
    type: HalfFloatType,
    format: RedFormat,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    depthBuffer: false,
  })
  readonly #map: TextureNode
  readonly #level: CloudLevelUniforms = {
    anchor: uniform(new Vector3(0, 1, 0)),
    east: uniform(new Vector3(1, 0, 0)),
    north: uniform(new Vector3(0, 0, 1)),
    eye: uniform(new Vector2()),
    along: uniform(new Vector3(1, 0, 0)),
    origin: uniform(new Vector2()),
    texel: uniform(CELL_METERS),
  }
  readonly #trusted = uniform(new Vector4(...NOWHERE))
  readonly #originMod = uniform(new Vector2())
  readonly #slice = uniform(0)
  readonly #toFirstExit = uniform(1)
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  #state: SunGridState = freshSunGrid(SLICES)
  /** The sun the last frame was drawn under: what this frame's turn is measured from. */
  #sun: Vec3 | null = null
  #pending = false
  #drawn = 0
  #allocated = false
  #warm: Promise<void> | null = null
  #disposed = false

  constructor(uniforms: CloudUniforms, volume: CloudSunSource) {
    this.#uniforms = uniforms
    this.#volume = volume
    const map = this.#target.texture
    map.name = 'cloud sun grid'
    map.wrapS = RepeatWrapping
    map.wrapT = RepeatWrapping
    this.#map = texture3D(map)
    this.#material.name = 'cloud sun grid'
    this.#material.fragmentNode = this.#bakeNode()
  }

  /**
   * The union's base, and the rise from one slice's height to the next. The
   * 32 heights run from the base to the top, the first and last on them, so
   * a sample at the base reads the whole column and one at the top reads
   * nothing; centered in 32 equal cells, the base would read half a cell
   * short, 1.6% of the column.
   */
  #vertical(): { readonly base: Node<'float'>; readonly slice: Node<'float'> } {
    const body = this.#uniforms.served
    const base = body.boundaries.x
    return {
      base,
      slice: max(body.boundariesHigh.y.sub(base).div(SLICES - 1), 1e-3),
    }
  }

  /** The cell's depth at an eye-relative point, and how far the grid holds the point: its reach's ramp, inside the trusted window. */
  #read(point: Node<'vec3'>): {
    readonly tau: Node<'float'>
    readonly held: Node<'float'>
  } {
    const body = this.#uniforms.served
    const { base, slice } = this.#vertical()
    const plane = levelPlane(this.#level, point, body)
    const cell = plane.div(CELL_METERS)
    const rect = this.#trusted
    const inside = cell.x
      .greaterThanEqual(rect.x.add(MARGIN))
      .and(cell.y.greaterThanEqual(rect.y.add(MARGIN)))
      .and(cell.x.lessThanEqual(rect.z.sub(MARGIN)))
      .and(cell.y.lessThanEqual(rect.w.sub(MARGIN)))
    const height = clamp(
      altitudeAt(body, point).sub(base).div(slice),
      0,
      SLICES - 1,
    )
    const tau = cellDepth(
      this.#map
        .sample(vec3(cell.div(WIDTH), height.add(0.5).div(SLICES)))
        .level(float(0)).x,
    )
    const out = abs(plane.sub(this.#level.eye))
    const ramp = saturate(
      float(SUN_GRID_REACH).sub(max(out.x, out.y)).div(SUN_GRID_FADE),
    )
    return { tau, held: select(inside, ramp, float(0)) }
  }

  /**
   * Where the sun's ray through a point, followed away from the sun, leaves
   * the union: through the base under a sun over the horizon, and through
   * the top where the ray never comes down to the base. The cell there
   * holds the ray's whole depth. A point under the base is that end itself.
   */
  #farEnd(point: Node<'vec3'>): Node<'vec3'> {
    const body = this.#uniforms.served
    const away = body.sun.negate()
    const base = shellCrossingFrom(body, point, away, body.boundaries.x)
    const top = shellCrossingFrom(body, point, away, body.boundariesHigh.y)
    const reach = select(
      base.hit.and(base.near.greaterThan(0)),
      base.near,
      select(
        base.hit.and(base.far.greaterThanEqual(0)),
        float(0),
        max(top.far, 0),
      ),
    )
    return point.add(away.mul(reach))
  }

  /**
   * The sun's depths at an eye-relative body-fixed point, and the grid's
   * weight there. Where the weight is zero the grid holds nothing of the
   * point and both depths are zero.
   *
   * `whole` costs a second read of the same texture, at the ray's far end,
   * and is built only into a program that reads it.
   */
  depths(offset: Node<'vec3'>): CloudSunGridDepths {
    const here = this.#read(offset)
    const end = this.#read(this.#farEnd(offset))
    const held = here.held.greaterThan(0)
    const toSun = select(held, here.tau, float(0))
    return {
      toSun,
      whole: toSun.add(
        select(held, end.held.mul(max(end.tau.sub(here.tau), 0)), float(0)),
      ),
      weight: this.#uniforms.trace.sunWeight.mul(here.held),
      behind: select(held, end.held, float(0)),
    }
  }

  /**
   * Where a ray from `origin` along the sun is inside each level, as
   * stretches of its length: on the way down to a level's base, or through
   * the level whole where the ray never reaches that base, and on the way
   * up from the base to the level's top. A ray under a sun below its
   * horizon goes down first and comes back up far sunward; one over it only
   * climbs. Absent levels and levels behind the ray have no length.
   */
  #stretches(origin: Node<'vec3'>): readonly {
    readonly down: Stretch
    readonly up: Stretch
    readonly thickness: Node<'float'>
  }[] {
    const body = this.#uniforms.served
    const { layers, sun } = body
    const of = (v: Node<'vec3'>, k: number): Node<'float'> =>
      [v.x, v.y, v.z][k]!
    return [0, 1, 2].map((k) => {
      const low = of(layers.base, k)
      const high = of(layers.top, k)
      const top = shellCrossingFrom(body, origin, sun, high)
      const base = shellCrossingFrom(body, origin, sun, low)
      const reached = top.hit.and(high.greaterThan(low))
      const enter = max(top.near, 0)
      const leave = max(top.far, 0)
      // The base is ahead of the ray, or all round it. Decided by the far
      // root alone: from a cell on the base the near one is zero, a float's
      // step to either side, and both readings give the same lengths.
      const ahead = base.hit.and(base.far.greaterThan(0))
      const back = max(base.far, 0)
      return {
        down: {
          from: enter,
          length: select(
            reached,
            max(select(ahead, max(base.near, 0), leave).sub(enter), 0),
            float(0),
          ),
        },
        up: {
          from: back,
          length: select(reached.and(ahead), max(leave.sub(back), 0), float(0)),
        },
        thickness: high.sub(low),
      }
    })
  }

  /**
   * One slice of cells: τ from each cell's center at the slice's height
   * toward the sun, through the volume, in 32 steps.
   *
   * **Over the cell's horizon the steps run to the union's top,** the ray's
   * one way out.
   *
   * **Under it they are spent on the ray's way down, inside the levels, and
   * stop where it leaves one through its base.** From the top of a deck 1.5°
   * under the horizon the ray leaves through the base after 34 km and comes
   * back up into the layer more than 300 km sunward; steps over that whole
   * chord are 11 km each, and three of them fall in the deck near the cell.
   * What the ray meets on its way back up is one crossing a level, by the
   * crossing's law (`#crossing`).
   */
  #bakeNode(): Node<'vec4'> {
    const body = this.#uniforms.served
    const level = this.#level
    return Fn(() => {
      const { base, slice } = this.#vertical()
      const pixel = floor(screenCoordinate.xy)
      const cell = level.origin.add(wrapped(pixel.sub(this.#originMod), WIDTH))
      const plane = cell.add(0.5).mul(CELL_METERS)
      const height = base.add(this.#slice.mul(slice))
      const origin = levelOffset(level, plane, height, body)
      // Heading down: decided by the sun's own sine at the cell, which is
      // also what sides the statistics.
      const down = this.#toFirstExit
        .greaterThan(0.5)
        .and(sunMuAt(body, origin).lessThan(0))
      const union = max(
        shellCrossingFrom(body, origin, body.sun, body.boundariesHigh.y).far,
        0,
      )
      const levels = this.#stretches(origin)
      // In the order a descending ray meets them, from the highest level;
      // a climbing ray has one stretch, the union's.
      const marched = [2, 1, 0].map((k, n) => ({
        from: select(down, levels[k]!.down.from, float(0)).toVar(),
        length: select(
          down,
          levels[k]!.down.length,
          n === 0 ? union : float(0),
        ).toVar(),
      }))
      const starts: Node<'float'>[] = []
      let total: Node<'float'> = float(0)
      for (const { length } of marched) {
        starts.push(total)
        total = total.add(length).toVar()
      }
      const step = total.div(SUN_GRID_STEPS).toVar()
      const tau = float(0).toVar()
      Loop(SUN_GRID_STEPS, ({ i }) => {
        const along = float(i).add(0.5).mul(step)
        // The first stretch the step's middle has not passed the end of.
        let t: Node<'float'> = float(0)
        for (let n = marched.length - 1; n >= 0; n -= 1) {
          const { from, length } = marched[n]!
          t = select(
            along.lessThan(starts[n]!.add(length)),
            from.add(along.sub(starts[n]!)),
            t,
          )
        }
        const point = origin.add(body.sun.mul(t))
        const medium = this.#volume.medium(
          {
            offset: point,
            distance: length(point),
            altitude: altitudeAt(body, point),
            sunMu: sunMuAt(body, point),
            footprint: float(CELL_METERS),
          },
          body,
        )
        // One optical depth a cell, the fraction folded in.
        tau.addAssign(medium.sigma.mul(medium.fraction).mul(step))
      })
      for (const { up, thickness } of levels)
        If(down.and(up.length.greaterThan(0)), () => {
          tau.addAssign(this.#crossing(origin, up, thickness))
        })
      return vec4(cellCode(tau), 0, 0, 1)
    })()
  }

  /**
   * A level a ray comes back up through, far sunward, as an optical depth:
   * one crossing by the crossing's law, fed the level's own statistics at
   * the middle of the ray's chord through it. They are the field's four
   * numbers there, never a texel's: the cloudy share, the vertical depth
   * whose transmittance is the cloudy columns' mean, the gamma its columns'
   * depths are spread by, and the sight length.
   *
   * The depth is the spread's mean times the chord's path factor, the chord
   * over the level's thickness. The chord is the shell's own, from its
   * crossings: the thickness over the sun's sine is 8% long for a kilometer
   * of cloud met 1.75° over the horizon, where the ray is still curving up
   * out of the layer. An extinction read at the chord's middle times the
   * chord is not that depth: the profile's share there is its peak, not its
   * mean. And the sight length is the level's measured one, tens of cells
   * under a sparse cirrus, not its cell: by the cell a 30 km run under
   * cirrus counts six columns where it crosses one or two, and half a cover
   * to the sixth is a sixtieth of the sun.
   */
  #crossing(
    origin: Node<'vec3'>,
    chord: Stretch,
    thickness: Node<'float'>,
  ): Node<'float'> {
    const body = this.#uniforms.served
    const at = origin.add(body.sun.mul(chord.from.add(chord.length.mul(0.5))))
    const level = this.#volume.statistics(
      {
        offset: at,
        distance: length(at),
        altitude: altitudeAt(body, at),
        sunMu: sunMuAt(body, at),
        footprint: float(0),
      },
      body,
    )
    const run = sqrt(
      max(chord.length.mul(chord.length).sub(thickness.mul(thickness)), 0),
    )
    return crossingDepth(
      level.fraction,
      spreadDepth(level.depth, level.shape).mul(
        chord.length.div(max(thickness, 1)),
      ),
      crossingExponent(run, level.sight),
      level.shape,
    )
  }

  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    budget: CloudBudget,
  ): void {
    if (this.#disposed) return
    this.#allocate(renderer)
    const { served } = frame
    const level = served.volume.frames[LEVEL]
    const before = this.#sun
    this.#sun = served.sun
    if (level === undefined) {
      this.#drawn = 0
      this.#silence()
      return
    }
    const { boundaries, eye } = served.shells
    const over = eye - (boundaries[boundaries.length - 1] ?? 0)
    // Idle where the level it is laid on lies more than its own extent
    // below the eye, as that level of the volume is.
    const idleOver = CLOUD_VOLUME_SIZE * level.texelMeters
    const grid = gridFrame(level)
    const step = sunGridStep(this.#state, {
      frame: frame.frameIndex,
      origin: grid.origin,
      epoch: level.epoch,
      rebuilt: served.volume.rebuilt[LEVEL] === true,
      idle: over > idleOver,
      owed: Math.max(
        owedByMotion(cloudFieldTravel(frame), CELL_METERS),
        before === null ? 0 : owedBySun(turned(before, served.sun)),
      ),
      cap: budget.sunSlices,
      ramp: frame.levers.sunRamp,
      source: {
        trusted: this.#volume.trusted,
        generation: this.#volume.generation,
      },
    })
    this.#state = step.state
    this.#pending = step.pending
    this.#drawn = step.bake.length
    this.#bakeAt(grid)
    if (step.bake.length > 0)
      runQuadPasses(
        renderer,
        this.#quad,
        // Each slice replaces every cell it covers: nothing to clear.
        { linear: true, autoClear: false },
        (draw) => {
          for (const k of step.bake) {
            this.#slice.value = k
            draw(CLOUD_SUN_GRID_LABEL, this.#target, this.#material, k)
          }
        },
      )
    // The reads trust the intersection of the slices' windows, at the
    // rebuild's weight times the wake's.
    const [x0, y0, x1, y1] =
      (step.state.idle ? null : trustedWindow(step.state.slices, WIDTH)) ??
      NOWHERE
    this.#trusted.value.set(x0, y0, x1, y1)
    this.#uniforms.trace.sunWeight.value =
      step.state.weight * sunWakeWeight(over, idleOver)
  }

  /** The frame's level terms, for the bake and for every read of the frame. */
  #bakeAt(grid: LevelFrame): void {
    const level = this.#level
    level.anchor.value.set(grid.anchor.x, grid.anchor.y, grid.anchor.z)
    level.east.value.set(grid.east.x, grid.east.y, grid.east.z)
    level.north.value.set(grid.north.x, grid.north.y, grid.north.z)
    level.eye.value.set(grid.eye[0], grid.eye[1])
    level.along.value.set(grid.along[0], grid.along[1], grid.along[2])
    level.origin.value.set(grid.origin[0], grid.origin[1])
    this.#originMod.value.set(
      modulo(grid.origin[0], WIDTH),
      modulo(grid.origin[1], HEIGHT),
    )
  }

  /** Read nowhere, at no weight. */
  #silence(): void {
    this.#trusted.value.set(...NOWHERE)
    this.#uniforms.trace.sunWeight.value = 0
  }

  #allocate(renderer: WebGPURenderer): void {
    this.#allocated = true
    if (this.#target.width === WIDTH) return
    this.#target.setSize(WIDTH, HEIGHT, SLICES)
    // At once: a resized target is made at its next binding, so what
    // `textures()` lists is on the device at the size `bytes` declares.
    renderer.initRenderTarget(this.#target)
    this.#forget()
  }

  /** No slice holds anything: the grid comes back under the cap, from a weight of zero. */
  #forget(): void {
    this.#state = freshSunGrid(SLICES)
    this.#silence()
    this.#drawn = 0
  }

  /**
   * Whether a cell under a sun below its horizon sums down to where its ray
   * leaves a level, with one crossing a level the ray comes back up through,
   * or to the far crossing of the union's top in the same 32 steps. The
   * first by default; the sun instrument scores both
   * (`cloudSunAccuracy.gpu.test.ts`), and the grid starts over when it
   * changes.
   */
  get toFirstExit(): boolean {
    return this.#toFirstExit.value > 0.5
  }

  set toFirstExit(on: boolean) {
    if (on === this.toFirstExit) return
    this.#toFirstExit.value = on ? 1 : 0
    this.#forget()
    this.#pending = true
  }

  /** A slice missing or at a window the grid has left, or a weight still rising: what a settle waits for. */
  get pending(): boolean {
    return this.#pending
  }

  /** Slices baked this frame: never more than the frame's cap. */
  get drawn(): number {
    return this.#drawn
  }

  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    const { width, height, depth } = this.#target
    return textureBytes(width, height, depth, TEXEL_BYTES)
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated ? [] : [this.#target.texture]
  }

  /**
   * The bake against a slice, drawn (an R16F target, which `warmByDrawing`
   * says why); a renderer with no backend builds nothing.
   */
  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed || renderer?.backend === undefined)
      return Promise.resolve()
    this.#allocated = true
    if (this.#warm === null) {
      warmByDrawing(renderer, this.#quad, CLOUD_SUN_GRID_LABEL, [
        { target: this.#target, material: this.#material },
      ])
      // The draw lands on the target's first slice with whatever the bake's
      // uniforms last held. A warm-up that arrives after a frame has baked,
      // a chain rebuilt with the levers on, draws over a slice its record
      // still calls current, so a grid at its real size owes every slice
      // again.
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
 * The sun's depth as a grid, summed through the volume.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change.
 */
export function createCloudSunGrid(deps: {
  readonly uniforms: CloudUniforms
  readonly volume: CloudSunSource
}): CloudSunGrid {
  return new CloudSunGrid(deps.uniforms, deps.volume)
}
