import {
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  type Texture,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  dot,
  float,
  floor,
  Fn,
  If,
  length,
  max,
  min,
  normalize,
  screenCoordinate,
  select,
  tan,
  texture,
  vec3,
  vec4,
} from 'three/tsl'
import {
  CUBE_FACES,
  type CubeFace,
  type FarAtlasLayout,
  type FarAtlasState,
  farAtlasState,
  type FarBlockPlan,
  farBlockPlans,
  farOwed,
  farViewCap,
  stepFarAtlas,
} from '@inertialref/rendering'
import { airMediumAt } from './air.ts'
import {
  atlasMarch,
  centerOf,
  encodeTau,
  type F,
  FAR_GUTTER,
  FAR_HEIGHT,
  FAR_MARGIN,
  FAR_ROWS,
  FAR_SPAN,
  FAR_TILE,
  FAR_WIDTH,
  type FarOptions,
  loop,
  type V3,
  type V4,
} from './cloudFar.ts'
import type { CloudBodyFrame, CloudFrame } from './cloudFrame.ts'
import type {
  CloudFarFn,
  CloudMediumFn,
  CloudPhaseNodes,
  CloudResource,
  CloudSample,
} from './cloudNodes.ts'
import type { CloudCubeFreshness } from './cloudMaps.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'
import { cloudFieldTravel } from './cloudVolume.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmSensorPass } from './warmup.ts'

export {
  type AirMediumFn,
  FAR_HEIGHT,
  FAR_MARGIN,
  FAR_WIDTH,
} from './cloudFar.ts'

/*
 * The far field: the march past the handover, where a trace texel spans more
 * than `farFootprint` and the fine march's steps would be finer than the
 * picture. It is the layer atlas: 6 faces × 3 layers × 258² texels of
 * (fraction, log in-cloud τ, base, top), RGBA8, a 1548 × 774 2D atlas, baked
 * from the field over 4 × 4 sub-columns and marched as slabs, one texel a
 * step, with per-column mixing and depth moments (§3.13, §5.13). The served
 * body bakes one from the cube's coverage and the second clouded body one
 * from the analytic medium.
 *
 * Every texture is read at level 0. The served body's march runs inside the
 * trace's kernel, but the second body's runs in the composite's fragment, in
 * control flow that differs per pixel, where WGSL allows no implicit
 * derivative. The march and the bake build loops and variables, so each is
 * called from inside a kernel's or a material's `Fn`.
 */

export interface CloudFarField extends CloudResource {
  /**
   * The march past the handover, for the body these uniforms describe.
   * Level-0 reads. It declares variables and loops where it is called, so it
   * is called inside a kernel's or a material's `Fn`, and its result is read
   * in the block it was called in: called inside an `If` and read after it,
   * the result names variables out of scope, which the stand-in's far
   * function, declaring none, never shows. With `from` at or past the span's
   * end it returns the empty result itself, so it needs no branch around it.
   */
  readonly far: CloudFarFn
}

interface CloudFarDeps {
  readonly uniforms: CloudUniforms
  /**
   * What it bakes from: `synopticMedium` for the served body (the cube's
   * coverage, the whole body), `analyticMedium` for the second (§3.10).
   */
  readonly field: CloudMediumFn
  readonly phase: CloudPhaseNodes
  readonly body: 'served' | 'second'
  /**
   * How fresh each face of the cube under `field` is, where it reads one:
   * a block is fresh only from fresh faces. Absent over a source with no
   * cube, and the atlas's own generation is then the field's.
   */
  readonly freshness?: CloudCubeFreshness
  /** The profile and statistics table `field` reads: a level's statistics landing is a new field. */
  readonly profile?: { readonly generation: number }
}

/* ------------------------------------------------------------------------- */
/* The layout and its schedule                                                */
/* ------------------------------------------------------------------------- */

/**
 * Texels along a block's side: what one bake draws, scissored. The blocks
 * are laid over the whole atlas, 17 across and 9 down, the last of each row
 * and column clipped.
 *
 * The smallest of the three the pace was to choose among, and declared: no
 * block of 192, 128 or 96 texels holds the bar, a frame that bakes one no
 * more than a millisecond over one that bakes none. On the Mac mini
 * (Mac18,5, Apple M6) a bake finishes a 32 × 32 tile of the target at a
 * time, 2.1 ms for a whole tile of 128 reads of the field a texel, and as
 * many tiles at once as a block of 128 holds: by the wall a block of 64, 96
 * or 128 texels reads 2.1 to 2.3 ms and one of 192 reads 4.8, and on the
 * pass timeline the dearest frame of a cycle stands 3.8 ms over its median
 * in blocks of 96 (`cloudTraceCost.gpu.test.ts`, the far atlas's bake). A
 * smaller block buys nothing until a tile is cheaper: what a texel reads is
 * the lever.
 */
export const FAR_BLOCK = 96

/** The atlas as its schedule lays it out (`cloudFarSchedule.ts`). */
export const FAR_LAYOUT: FarAtlasLayout = {
  tile: FAR_TILE,
  gutter: FAR_GUTTER,
  rows: FAR_ROWS,
  block: FAR_BLOCK,
}

/* ------------------------------------------------------------------------- */
/* What a texel holds                                                         */
/* ------------------------------------------------------------------------- */

/** Sub-columns along each side of a texel, and heights along each sub-column. */
const SUBCOLUMNS = 4
const HEIGHTS = 8
/**
 * A sub-column whose column optical depth is under this is clear. An
 * unscaled depth, the droplets' whole extinction, whatever medium the march
 * draws: taken in a scaled depth, about half of it, the same cut would
 * clear cirrus-over-cumulus's cirrus, 0.12 unscaled, out of the far field
 * while the fine march still draws it.
 */
const CLOUDY_TAU = 0.1
/** A sub-column's spacing in warped units: a quarter of a texel, 2/(256·4). */
const SUBCOLUMN_WARPED = 2 / (FAR_TILE * SUBCOLUMNS)

/* ------------------------------------------------------------------------- */
/* TSL shapes the bake and the march share                                    */
/* ------------------------------------------------------------------------- */

const faceVectors = (axis: 'normal' | 'a' | 'b'): readonly V3[] =>
  CUBE_FACES.map((face) => vec3(face[axis].x, face[axis].y, face[axis].z))

const FACE_NORMALS = /*@__PURE__*/ faceVectors('normal')
const FACE_A = /*@__PURE__*/ faceVectors('a')
const FACE_B = /*@__PURE__*/ faceVectors('b')

/**
 * Face `face`'s vector, the face an integer-valued float. No integer index: a
 * float of a select of integers is the conversion r185 drops.
 */
function onFace(face: F, values: readonly V3[]): V3 {
  let chosen = values[values.length - 1]!
  for (let f = values.length - 2; f >= 0; f -= 1)
    chosen = select(face.lessThan(f + 0.5), values[f]!, chosen)
  return chosen
}

/** The unit direction at warped coordinates on a face, `cubeDirection`'s tangent warp. */
function faceDirection(face: F, a: F, b: F): V3 {
  const warp = Math.PI / 4
  return normalize(
    onFace(face, FACE_NORMALS)
      .add(onFace(face, FACE_A).mul(tan(a.mul(warp))))
      .add(onFace(face, FACE_B).mul(tan(b.mul(warp)))),
  )
}

/** The atlas texel a bake fragment draws: its face's column, its layer's row and its warped center. */
interface FarTexel {
  readonly face: F
  readonly layer: F
  readonly a: F
  readonly b: F
}

/**
 * The fragment's own texel, row 0 at the top as WebGPU's framebuffer and the
 * scissor both count it, so a block's rectangle and the texels it bakes are
 * one set. The warped center is `cubeTexelCoordinate`'s, so a gutter texel
 * sits half a texel past its face's edge, in the neighbor's directions.
 *
 * Each is a variable, declared where this is called: the bake reads them
 * inside several loops, and a shared node first built inside one loop is
 * declared in that loop's scope, where the next cannot see it.
 */
function farTexel(): FarTexel {
  const x = floor(screenCoordinate.x)
  const y = floor(screenCoordinate.y)
  const face = floor(x.div(FAR_SPAN)).toVar()
  const layer = floor(y.div(FAR_SPAN)).toVar()
  const warped = (index: F): F =>
    index.sub(FAR_GUTTER).mul(2).add(1).div(FAR_TILE).sub(1).toVar()
  return {
    face,
    layer,
    a: warped(x.sub(face.mul(FAR_SPAN))),
    b: warped(y.sub(layer.mul(FAR_SPAN))),
  }
}

/** The same layer's base and top chosen by an integer-valued float, as a bake fragment knows its row. */
function farLayerAt(
  body: CloudBodyUniforms,
  layer: F,
): { readonly base: F; readonly top: F } {
  const pick = (low: F, middle: F, high: F): F =>
    select(layer.lessThan(0.5), low, select(layer.lessThan(1.5), middle, high))
  return {
    base: pick(body.boundaries.x, body.boundaries.z, body.boundariesHigh.x),
    top: pick(body.boundaries.y, body.boundaries.w, body.boundariesHigh.y),
  }
}

/**
 * The field's sample at `height` over the datum straight above `direction`.
 * The offset is (R + h)·d − e in float32, about half a meter of error at
 * 2,000 km: under 10⁻³ of a base cell, and the sub-columns sample the noise
 * statistically rather than as a lattice decision (§3.10). The altitude is the
 * height itself, and the sun's cosine over the horizontal there is d·ŝ.
 */
function bakeSample(
  body: CloudBodyUniforms,
  direction: V3,
  height: F,
  footprint: F,
): CloudSample {
  const offset = direction.mul(body.datumRadius.add(height)).sub(centerOf(body))
  return {
    offset,
    distance: length(offset),
    altitude: height,
    sunMu: dot(direction, body.sun),
    footprint,
  }
}

/** What a texel's column holds: the bake's four numbers before their encoding. */
interface FarColumn {
  /** The cloudy share of the column. */
  readonly fraction: F
  /** The in-cloud column optical depth, the mean over the cloudy share. */
  readonly tau: F
  /** The lowest and highest cloud over the cloudy sub-columns, meters over the datum. */
  readonly base: F
  readonly top: F
}

/**
 * A column's statistics over 4 × 4 sub-columns × 8 heights (§3.13): a
 * sub-column is cloudy when its optical depth through the layer passes 0.1,
 * the column's fraction is the cloudy share, its τ the mean over that share,
 * and its base and top the extremes of the cloudy sub-columns' cloud.
 *
 * A sub-column counts as much of a column as the medium says is cloudy there
 * (the largest fraction it met, as a segment does): 1 for a resolved field,
 * which is the design's count, and the medium's own share where it reports
 * cloud it cannot resolve. `at(p, q)` places sub-column (p, q), p and q from 0
 * to 3; `name` keeps three nested loops' variables apart. What the loops share
 * is declared before them (see `farTexel`).
 */
function columnStatistics(
  field: CloudMediumFn,
  body: CloudBodyUniforms,
  base: F,
  top: F,
  footprint: F,
  at: (p: F, q: F) => V3,
  name: string,
): FarColumn {
  const bottom = base.toVar()
  const ceiling = top.toVar()
  const reach = footprint.toVar()
  const slice = max(ceiling.sub(bottom), 0).div(HEIGHTS).toVar()
  const share = float(0).toVar()
  const sum = float(0).toVar()
  const low = ceiling.toVar()
  const high = bottom.toVar()
  loop(`${name}P`, SUBCOLUMNS, (p) => {
    loop(`${name}Q`, SUBCOLUMNS, (q) => {
      const direction = at(float(p), float(q)).toVar()
      const tau = float(0).toVar()
      const cover = float(0).toVar()
      const first = float(HEIGHTS).toVar()
      const last = float(-1).toVar()
      loop(`${name}H`, HEIGHTS, (k) => {
        const index = float(k).toVar()
        const height = bottom.add(index.add(0.5).mul(slice))
        const medium = field(bakeSample(body, direction, height, reach), body)
        const sigma = max(medium.sigma, 0).toVar()
        tau.addAssign(sigma.mul(slice))
        If(sigma.greaterThan(0), () => {
          cover.assign(max(cover, medium.fraction))
          first.assign(min(first, index))
          last.assign(max(last, index))
        })
      })
      If(tau.greaterThan(CLOUDY_TAU), () => {
        share.addAssign(cover)
        sum.addAssign(cover.mul(tau))
        low.assign(min(low, bottom.add(first.mul(slice))))
        high.assign(max(high, bottom.add(last.add(1).mul(slice))))
      })
    })
  })
  const cloudy = share.greaterThan(0)
  return {
    fraction: share.div(SUBCOLUMNS * SUBCOLUMNS),
    tau: select(cloudy, sum.div(max(share, 1e-6)), float(0)),
    // A clear column keeps its layer's own range, so a filtered read beside a
    // cloudy one widens toward the layer rather than collapsing to a sliver.
    base: select(cloudy, low, bottom),
    top: select(cloudy, high, ceiling),
  }
}

/** Sub-column (p, q) of the texel at warped (a, b) on `face`. */
function subColumnOf(face: F, a: F, b: F): (p: F, q: F) => V3 {
  return (p, q) =>
    faceDirection(
      face,
      a.add(p.sub(1.5).mul(SUBCOLUMN_WARPED)),
      b.add(q.sub(1.5).mul(SUBCOLUMN_WARPED)),
    )
}

/**
 * The footprint a far bake evaluates the field at: the handover's,
 * farFootprint = farDistance × pixelAngle. The far field takes over where a
 * trace texel spans that much, so it holds the field as the fine march sees it
 * there, and the sub-columns do the averaging a coarser footprint would.
 */
const bakeFootprint = (uniforms: CloudUniforms): F =>
  uniforms.trace.farDistance.mul(uniforms.camera.pixelAngle)

/* ------------------------------------------------------------------------- */
/* The march's accumulation                                                   */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* The atlas                                                                  */
/* ------------------------------------------------------------------------- */

/** (fraction, log in-cloud τ, base, top), base and top over [base − 500 m, top + 500 m]. */
function atlasBake(deps: CloudFarDeps): V4 {
  return Fn(() => {
    const body = deps.uniforms[deps.body]
    const texel = farTexel()
    const { base, top } = farLayerAt(body, texel.layer)
    const column = columnStatistics(
      deps.field,
      body,
      base,
      top,
      bakeFootprint(deps.uniforms),
      subColumnOf(texel.face, texel.a, texel.b),
      'farAtlas',
    )
    const floor = base.sub(FAR_MARGIN)
    const range = top.sub(base).add(2 * FAR_MARGIN)
    return vec4(
      column.fraction,
      encodeTau(column.tau),
      column.base.sub(floor).div(range),
      column.top.sub(floor).div(range),
    )
  })() as V4
}

/* ------------------------------------------------------------------------- */
/* The resource                                                               */
/* ------------------------------------------------------------------------- */

const LABELS = {
  served: 'cloud far atlas',
  second: 'cloud far second',
} as const
const NAMES = { served: 'farAtlas', second: 'farSecond' } as const
/** RGBA8. */
const TEXEL_BYTES = 4

const FACES: readonly CubeFace[] = [0, 1, 2, 3, 4, 5]

/** Which of a body's three levels have any thickness: the rows of the atlas it holds. */
const levelsOf = (body: CloudBodyFrame): readonly boolean[] => {
  const { boundaries } = body.shells
  return Array.from(
    { length: FAR_ROWS },
    (_, k) => (boundaries[2 * k + 1] ?? 0) > (boundaries[2 * k] ?? 0),
  )
}

/**
 * One body's atlas: a target baked a scissored block at a time, each block
 * one quad and one pass on the timeline, and the march that reads it.
 *
 * It allocates at its real size only on a frame that has its body — the
 * served body's always, the second body's whenever there is one — and
 * shrinks back to 1 × 1 on a frame that does not. A resize is followed at
 * once by `initRenderTarget`, which allocates without drawing, so what
 * `textures()` lists always exists on the GPU at the size `bytes` declares.
 *
 * **What a frame bakes is the schedule's** (`stepFarAtlas` in
 * `packages/rendering/src/cloudFarSchedule.ts`). The atlas is body-fixed,
 * not eye-anchored, so a cut leaves it valid. A discontinuity of its field
 * leaves every block behind, and the blocks come back `farBlocks` a frame,
 * the ones in view first, each once the cube faces it reads hold the new
 * field. A whole atlas is redrawn at the pace its field moves, the block
 * baked longest ago first, and under a clock that stands still it bakes
 * nothing. A block holds only the rows of the levels the body has.
 *
 * The field's discontinuities are the cube's generations where the atlas is
 * baked from one, and its own beside them: a jump of the field's time, the
 * weather, the body, the handover footprint the bake reads the field at,
 * and a level's statistics landing.
 */
export class CloudFarAtlas implements CloudFarField {
  readonly name: string
  readonly far: CloudFarFn
  readonly #label: string
  readonly #side: 'served' | 'second'
  readonly #freshness: CloudCubeFreshness | null
  readonly #profile: { readonly generation: number } | null
  readonly #target = new RenderTarget(1, 1, {
    type: UnsignedByteType,
    depthBuffer: false,
  })
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #plans = farBlockPlans(FAR_LAYOUT)
  #state: FarAtlasState = farAtlasState(this.#plans)
  #allocated = false
  #disposed = false
  #warm: Promise<void> | null = null
  #renders = 0
  /** The atlas's own generation, and what it was last formed from. */
  #generation = 0
  #key: string | null = null
  #tables = -1
  #pending = false
  #pendingInView = 0

  constructor(deps: CloudFarDeps, options: FarOptions = {}) {
    this.#side = deps.body
    this.#freshness = deps.freshness ?? null
    this.#profile = deps.profile ?? null
    this.name = NAMES[deps.body]
    this.#label = LABELS[deps.body]
    this.#target.texture.name = this.#label
    this.#material.fragmentNode = atlasBake(deps)
    this.#material.name = this.#label
    this.far = atlasMarch(
      deps,
      texture(this.texture),
      options.air ?? airMediumAt,
    )
  }

  /** What the march reads: the same texture object at every size, so no program rebinds. */
  get texture(): Texture {
    return this.#target.texture
  }

  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    return this.#target.width * this.#target.height * TEXEL_BYTES
  }

  /** Whether a block of a level the body has holds an older field than the frame's. */
  get pending(): boolean {
    return !this.#disposed && this.#pending
  }

  /** Of the blocks that hold an older field, the ones with a column in view of the eye. */
  get pendingInView(): number {
    return this.#disposed ? 0 : this.#pendingInView
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated ? [] : [this.#target.texture]
  }

  /**
   * Compiles the bake against its 1 × 1 target of the real format: a pipeline
   * is keyed on the format, not the size. Off WebGPU there is nothing to
   * compile — the clouds are WebGPU's alone (§4.6) — and a renderer with no
   * WebGPU backend, which the contracts' stub test hands it, warms nothing.
   */
  warm(renderer: WebGPURenderer): Promise<void> {
    const backend = (renderer as { backend?: { isWebGPUBackend?: boolean } })
      ?.backend
    if (this.#disposed || backend?.isWebGPUBackend !== true)
      return Promise.resolve()
    this.#warm ??= this.#compile(renderer)
    return this.#warm
  }

  #compile(renderer: WebGPURenderer): Promise<void> {
    renderer.initRenderTarget(this.#target)
    this.#allocated = true
    return warmSensorPass(renderer, this.#quad, [
      { target: this.#target, material: this.#material },
    ])
  }

  /** This frame's blocks, on a frame that has its body: none, or the schedule's. */
  render(renderer: WebGPURenderer, frame: CloudFrame): void {
    if (this.#disposed) return
    const body = this.#side === 'served' ? frame.served : frame.second
    if (body === null) {
      this.#release(renderer)
      return
    }
    const now = this.#renders
    this.#renders += 1
    if (
      this.#target.width !== FAR_WIDTH ||
      this.#target.height !== FAR_HEIGHT
    ) {
      this.#resize(renderer, FAR_WIDTH, FAR_HEIGHT)
      // A new target holds nothing: every block is to be baked.
      this.#state = farAtlasState(this.#plans)
    }
    const key = `${body.weatherKey} ${body.address} ${frame.levers.farFootprint}`
    const tables = this.#profile?.generation ?? 0
    if (key !== this.#key || tables !== this.#tables || frame.jump)
      this.#generation += 1
    this.#key = key
    this.#tables = tables
    const levels = levelsOf(body)
    const { eye, datumRadius } = body
    const distance = Math.hypot(eye.x, eye.y, eye.z)
    const { boundaries } = body.shells
    const top = boundaries[boundaries.length - 1] ?? 0
    const freshness = this.#freshness
    const step = stepFarAtlas(this.#plans, this.#state, {
      frame: now,
      generation: this.#generation,
      source:
        freshness === null
          ? null
          : {
              generation: freshness.generation,
              faces: FACES.map((face) => freshness.faceGeneration(face)),
            },
      levels,
      eye:
        distance > 0
          ? { x: eye.x / distance, y: eye.y / distance, z: eye.z / distance }
          : { x: 0, y: 1, z: 0 },
      cap: farViewCap(datumRadius, distance - datumRadius, top + FAR_MARGIN),
      // The travel is the served field's by name and any body's by what it
      // reads: the wind and the levels' turn over the frame's step of time.
      owed: farOwed(
        cloudFieldTravel({ ...frame, served: body }),
        FAR_TILE,
        datumRadius,
      ),
      blocks: frame.levers.farBlocks,
    })
    this.#state = step.state
    this.#pending = step.pending
    this.#pendingInView = step.pendingInView
    for (const k of step.bake) this.#draw(renderer, this.#plans[k]!, levels)
  }

  /** One block, clipped to the rows of the levels the body has. */
  #draw(
    renderer: WebGPURenderer,
    plan: FarBlockPlan,
    levels: readonly boolean[],
  ): void {
    const held = plan.levels.filter((level) => levels[level] === true)
    if (held.length === 0) return
    const y0 = Math.max(plan.y, held[0]! * FAR_SPAN)
    const y1 = Math.min(
      plan.y + plan.height,
      (held[held.length - 1]! + 1) * FAR_SPAN,
    )
    const target = this.#target
    target.scissor.set(plan.x, y0, plan.width, y1 - y0)
    target.scissorTest = true
    try {
      runQuadPasses(
        renderer,
        this.#quad,
        // Each block replaces the texels it covers and no others: a clear
        // would erase every block before it, since a load clear ignores the
        // scissor, and three reads the scissor's enable from the renderer and
        // its rectangle from the target.
        { linear: true, autoClear: false, scissor: true },
        (draw) => draw(this.#label, target, this.#material),
      )
    } finally {
      target.scissorTest = false
    }
  }

  #resize(renderer: WebGPURenderer, width: number, height: number): void {
    this.#target.setSize(width, height)
    renderer.initRenderTarget(this.#target)
    this.#allocated = true
  }

  #release(renderer: WebGPURenderer): void {
    this.#pending = false
    this.#pendingInView = 0
    this.#key = null
    if (this.#target.width === 1 && this.#target.height === 1) return
    this.#resize(renderer, 1, 1)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#pending = false
    this.#pendingInView = 0
    this.#target.dispose()
    this.#material.dispose()
  }
}

/**
 * A body's far atlas: the served body's baked from the cube's coverage, a
 * second body's from the analytic one.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change.
 */
export function createCloudFarAtlas(
  deps: {
    readonly uniforms: CloudUniforms
    readonly phase: CloudPhaseNodes
    /** The media a far bake reads: the cube's coverage for the served body, the analytic for a second. */
    readonly media: {
      readonly synoptic: CloudMediumFn
      readonly analytic: CloudMediumFn
    }
    /** The weather cube the synoptic medium reads: the served atlas is fresh only from its fresh faces. */
    readonly maps: {
      readonly nodes: { readonly freshness?: CloudCubeFreshness }
    }
    readonly profile: { readonly generation: number }
  },
  body: 'served' | 'second',
): CloudFarAtlas {
  const freshness = body === 'served' ? deps.maps.nodes.freshness : undefined
  return new CloudFarAtlas({
    uniforms: deps.uniforms,
    field: body === 'served' ? deps.media.synoptic : deps.media.analytic,
    phase: deps.phase,
    body,
    profile: deps.profile,
    ...(freshness === undefined ? {} : { freshness }),
  })
}
