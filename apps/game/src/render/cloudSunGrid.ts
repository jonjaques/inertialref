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
  clamp,
  float,
  floor,
  Fn,
  length,
  Loop,
  max,
  screenCoordinate,
  select,
  texture3D,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import {
  type LevelFrame,
  SUN_CASCADE_TURN,
  textureBytes,
  type WeatherScenario,
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
import type {
  CloudBudget,
  CloudResource,
  CloudSunDepthNodes,
} from './cloudNodes.ts'
import type { CloudLevelUniforms, CloudUniforms } from './cloudUniforms.ts'
import {
  CLOUD_VOLUME_SIZE,
  CLOUD_VOLUME_TEXELS,
  type CloudVolume,
  wrapped,
} from './cloudVolume.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmByDrawing } from './warmup.ts'

/*
 * The sun's optical depth as a grid around the eye (Nubis³): τ from each
 * cell's center to the union's top along the sun, summed through the local
 * volume in 32 steps whose heights come from `altitudeAt` (rule 52), over
 * the volume's level-1 window and 32 heights from the union's base to its
 * top.
 *
 * **Its frame is the volume's level 1.** A cell is two of level 1's texels,
 * 400 m, on that level's anchor and plane, so the grid re-anchors exactly
 * when the level does; its window of 128 cells is centered on the eye in
 * that plane, as the level's 256 texels are, and scrolls toroidally.
 *
 * **A slice is drawn whole, at the window the grid has that frame.** The
 * cells a move exposes come in with the round-robin: four slices a frame,
 * six while any slice holds a window the grid has left, so a move is drawn
 * into every slice within six frames. Until then the grid trusts only the
 * intersection of the windows its slices were drawn at, a cell in from its
 * edges, and reads nothing past it. Drawing the strip into all 32 slices the
 * frame it appears would be 32 quads on one frame, against the pass budget's
 * six for the grid under motion (§4.4). A sun turned 0.05° from the one the
 * grid was drawn under, the field's time jumping, a new anchor or scenario
 * each rebuild it whole that frame: 32 slices of 128² cells × 32 steps,
 * 16.8 M texel-steps, which is the cap the two candidates share.
 *
 * Past the window, and from orbit, where level 1 lies more than its own
 * extent below the eye and the grid is idle as the volume's level is, the
 * sun is unshadowed beyond the taps.
 */

/** Over the volume's level-1 window and the union's height. */
export const SUN_GRID_SIZE = [128, 128, 32] as const
/** Steps a cell's sun ray takes to the union's top. */
export const SUN_GRID_STEPS = 32
/** The pass's name on the timeline. */
export const CLOUD_SUN_GRID_LABEL = 'cloud sun grid'

const [WIDTH, HEIGHT, SLICES] = SUN_GRID_SIZE
/** A cell is two of level 1's texels: 128 cells span its 256. */
const CELL_METERS = (CLOUD_VOLUME_TEXELS[1] * CLOUD_VOLUME_SIZE) / WIDTH
const STEADY = 4
const MOVING = 6
/** R16F. */
const TEXEL_BYTES = 2
/** Cells in from a trusted window's edge: a trilinear read reaches half a cell. */
const MARGIN = 1
const NOWHERE = [1, 1, 0, 0] as const
const SLICE_STEPS = WIDTH * HEIGHT * SUN_GRID_STEPS
const TURN = Math.cos((SUN_CASCADE_TURN * Math.PI) / 180)

/**
 * Level 1's frame at the grid's cells: its anchor, axes and eye terms, and a
 * window of the grid's size whose middle corner is the eye's nearest, as
 * `levelFrames` places a level's.
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

interface SliceRecord {
  origin: readonly [number, number] | null
  frame: number
}

const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

const modulo = (value: number, size: number): number =>
  ((value % size) + size) % size

export class CloudSunGrid implements CloudResource, CloudSunDepthNodes {
  readonly name = 'sunGrid'
  readonly #uniforms: CloudUniforms
  readonly #volume: CloudVolume
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
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #slices: SliceRecord[] = Array.from({ length: SLICES }, () => ({
    origin: null,
    frame: -1,
  }))
  /** Level 1's anchor epoch the slices were drawn on. */
  #epoch: number | null = null
  /** The sun the slices were drawn under, since the grid was last whole. */
  #sun: Vec3 | null = null
  #idle = true
  #pending = false
  #spent = 0
  #scenario: WeatherScenario | null = null
  #address: string | null = null
  #last: number | null = null
  #allocated = false
  #warm: Promise<void> | null = null
  #disposed = false

  constructor(uniforms: CloudUniforms, volume: CloudVolume) {
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

  /** Optical depth from an eye-relative body-fixed point to the sun. */
  opticalDepth(offset: Node<'vec3'>): Node<'float'> {
    const body = this.#uniforms.served
    const { base, slice } = this.#vertical()
    const cell = levelPlane(this.#level, offset, body).div(CELL_METERS)
    const rect = this.#trusted
    const inside = cell.x
      .greaterThanEqual(rect.x.add(MARGIN))
      .and(cell.y.greaterThanEqual(rect.y.add(MARGIN)))
      .and(cell.x.lessThanEqual(rect.z.sub(MARGIN)))
      .and(cell.y.lessThanEqual(rect.w.sub(MARGIN)))
    const height = clamp(
      altitudeAt(body, offset).sub(base).div(slice),
      0,
      SLICES - 1,
    )
    const tau = this.#map
      .sample(vec3(cell.div(WIDTH), height.add(0.5).div(SLICES)))
      .level(float(0)).x
    return select(inside, tau, float(0))
  }

  /** One slice of cells: τ from each cell's center at the slice's height to the union's top, through the volume. */
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
      const exit = max(
        shellCrossingFrom(body, origin, body.sun, body.boundariesHigh.y).far,
        0,
      )
      const step = exit.div(SUN_GRID_STEPS)
      const tau = float(0).toVar()
      Loop(SUN_GRID_STEPS, ({ i }) => {
        const point = origin.add(body.sun.mul(float(i).add(0.5).mul(step)))
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
        // As the cascades: one optical depth a cell, the fraction folded in.
        tau.addAssign(medium.sigma.mul(medium.fraction).mul(step))
      })
      return vec4(tau, 0, 0, 1)
    })()
  }

  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    budget: CloudBudget,
  ): void {
    if (this.#disposed) return
    if (frame.levers.sunDepth !== 'grid') {
      this.#release(renderer)
      return
    }
    this.#allocate(renderer)
    const { served } = frame
    const levelOne = served.volume.frames[1]
    const { boundaries, eye } = served.shells
    const top = boundaries[boundaries.length - 1] ?? 0
    const idle =
      levelOne === undefined ||
      eye - top > CLOUD_VOLUME_SIZE * levelOne.texelMeters
    const sun = served.sun
    const everything =
      this.#last === null ||
      frame.frameIndex !== this.#last + 1 ||
      frame.jump ||
      budget.jump ||
      frame.scenario !== this.#scenario ||
      served.address !== this.#address ||
      served.volume.rebuilt[1] === true ||
      levelOne?.epoch !== this.#epoch ||
      (this.#idle && !idle) ||
      this.#sun === null ||
      dot3(this.#sun, sun) < TURN
    this.#scenario = frame.scenario
    this.#address = served.address
    this.#epoch = levelOne?.epoch ?? null
    this.#idle = idle
    this.#last = frame.frameIndex
    if (levelOne === undefined) return
    const grid = gridFrame(levelOne)
    if (everything) {
      for (const record of this.#slices) record.origin = null
      this.#sun = sun
    }
    if (idle) {
      this.#spent = 0
      this.#publish(grid)
      return
    }
    const work = this.#schedule(grid, budget.sunTexelSteps, frame.frameIndex)
    this.#spent = work.length * SLICE_STEPS
    if (work.length > 0) {
      this.#bakeAt(grid)
      runQuadPasses(
        renderer,
        this.#quad,
        // Each slice replaces every cell it covers: nothing to clear.
        { linear: true, autoClear: false },
        (draw) => {
          for (const k of work) {
            this.#slice.value = k
            draw(CLOUD_SUN_GRID_LABEL, this.#target, this.#material, k)
          }
        },
      )
    }
    this.#publish(grid)
  }

  /** The slices this frame draws, under the cap: missing ones first, then the oldest. */
  #schedule(grid: LevelFrame, cap: number, frameIndex: number): number[] {
    const fits = Math.floor(cap / SLICE_STEPS)
    const missing = this.#slices.flatMap((record, k) =>
      record.origin === null ? [k] : [],
    )
    const moved = this.#slices.some(
      ({ origin }) =>
        origin !== null &&
        (origin[0] !== grid.origin[0] || origin[1] !== grid.origin[1]),
    )
    const work =
      missing.length > 0
        ? missing.slice(0, fits)
        : this.#slices
            .map((record, k) => ({ k, at: record.frame }))
            .sort((a, b) => a.at - b.at || a.k - b.k)
            .slice(0, Math.min(fits, moved ? MOVING : STEADY))
            .map(({ k }) => k)
    for (const k of work)
      this.#slices[k] = {
        origin: [grid.origin[0], grid.origin[1]],
        frame: frameIndex,
      }
    return work
  }

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

  /** The reads trust the intersection of the slices' windows, and the frame's eye terms. */
  #publish(grid: LevelFrame): void {
    this.#bakeAt(grid)
    const rect = [-Infinity, -Infinity, Infinity, Infinity]
    let whole = !this.#idle
    let moved = false
    for (const { origin } of this.#slices) {
      if (origin === null) {
        whole = false
        break
      }
      rect[0] = Math.max(rect[0]!, origin[0])
      rect[1] = Math.max(rect[1]!, origin[1])
      rect[2] = Math.min(rect[2]!, origin[0] + WIDTH)
      rect[3] = Math.min(rect[3]!, origin[1] + HEIGHT)
      if (origin[0] !== grid.origin[0] || origin[1] !== grid.origin[1])
        moved = true
    }
    const [x0, y0, x1, y1] = whole ? rect : NOWHERE
    this.#trusted.value.set(x0!, y0!, x1!, y1!)
    this.#pending = !this.#idle && (!whole || moved)
  }

  #allocate(renderer: WebGPURenderer): void {
    this.#allocated = true
    if (this.#target.width === WIDTH) return
    this.#target.setSize(WIDTH, HEIGHT, SLICES)
    // At once: a resized target is made at its next binding, and a released
    // candidate has none, so what `textures()` lists is always on the device.
    renderer.initRenderTarget(this.#target)
    this.#forget()
  }

  /** Back to the 1 × 1 target warming built against, holding nothing. */
  #release(renderer: WebGPURenderer): void {
    if (this.#target.width !== 1) {
      this.#target.setSize(1, 1, 1)
      renderer.initRenderTarget(this.#target)
    }
    this.#forget()
    this.#pending = false
  }

  #forget(): void {
    for (const record of this.#slices) {
      record.origin = null
      record.frame = -1
    }
    this.#trusted.value.set(...NOWHERE)
    this.#epoch = null
    this.#sun = null
    this.#last = null
    this.#spent = 0
  }

  /** A slice missing, or at a window the grid has left. */
  get pending(): boolean {
    return this.#pending
  }

  /** Texel-steps the last frame spent: never over the cap it was given. */
  get spent(): number {
    return this.#spent
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
