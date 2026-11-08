import {
  HalfFloatType,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  type Texture,
  type TextureNode,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  ceil,
  clamp,
  dot,
  exp,
  exp2,
  float,
  floor,
  Fn,
  If,
  int,
  length,
  log2,
  Loop,
  max,
  min,
  normalize,
  oneMinus,
  saturate,
  screenCoordinate,
  select,
  sqrt,
  tan,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { CUBE_FACES, MAX_CLOUD_LAYERS } from '@inertialref/rendering'
import {
  type AirPhases,
  airMediumAt,
  clearedBeam,
  ORBIT_AIRLIGHT,
  phasesToward,
  stepShare,
  sunTableAt,
  sunThroughAt,
} from './air.ts'
import type { CloudFarDeps, CloudFarField } from './cloudFar.ts'
import type { CloudFrame } from './cloudFrame.ts'
import {
  cloudSample,
  cubeAtlasUv,
  shellCrossing,
  shellCrossingFrom,
  sunMuAt,
} from './cloudGeometry.ts'
import type { CloudFarKind } from './cloudLevers.ts'
import type {
  CloudFarFn,
  CloudFarResult,
  CloudMediumFn,
  CloudPhaseNodes,
  CloudRay,
  CloudResource,
  CloudSample,
} from './cloudNodes.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmSensorPass } from './warmup.ts'

/*
 * The layer atlas: 6 faces × 3 layers × 258² texels of (fraction, log
 * in-cloud τ, base, top), RGBA8, a 1548 × 774 2D atlas, baked from the field
 * over 4 × 4 sub-columns and marched as slabs, one texel a step, with
 * per-column mixing and depth moments (§3.13, §5.13).
 *
 * The arithmetic both far candidates share is here too, and the sphere caches
 * import it: the layout and its block schedule, a texel's column statistics,
 * the march's accumulation (light, blocked air, depth moments) and the
 * resource that bakes one block a frame. `cloudFar.ts` constructs both
 * candidates, so it cannot also be what they read from.
 *
 * Every texture is read at level 0. The served body's march runs inside the
 * trace's kernel, but the second body's runs in the composite's fragment, in
 * control flow that differs per pixel, where WGSL allows no implicit
 * derivative. The march and the bake build loops and variables, so each is
 * called from inside a kernel's or a material's `Fn`.
 */

type F = Node<'float'>
type I = Node<'int'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type B = Node<'bool'>

/* ------------------------------------------------------------------------- */
/* The layout and its schedule                                                */
/* ------------------------------------------------------------------------- */

/** Interior texels a face tile has, and the neighbor texels it carries each side. */
const FAR_TILE = 256
const FAR_GUTTER = 1
const FAR_SPAN = FAR_TILE + 2 * FAR_GUTTER
/** Six face tiles across; one row of them a layer. */
const FAR_COLUMNS = 6
const FAR_ROWS = MAX_CLOUD_LAYERS
export const FAR_WIDTH = FAR_COLUMNS * FAR_SPAN
export const FAR_HEIGHT = FAR_ROWS * FAR_SPAN

/** Texels: one scissored block a frame, 45 blocks a cycle. */
export const FAR_BLOCK = 192
export const FAR_STEPS_A_LAYER = 32

const BLOCKS_ACROSS = Math.ceil(FAR_WIDTH / FAR_BLOCK)
const BLOCKS_DOWN = Math.ceil(FAR_HEIGHT / FAR_BLOCK)
/** Blocks that cover the atlas once: 9 across and 5 down, the last of each row and column clipped. */
export const FAR_CYCLE = BLOCKS_ACROSS * BLOCKS_DOWN

/** A block's rectangle in texels, row 0 at the top as the scissor counts it. */
export interface FarBlock {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Block `index` of the cycle, row by row from the atlas's first row, clipped to the atlas. */
export function farBlock(index: number): FarBlock {
  const k = ((index % FAR_CYCLE) + FAR_CYCLE) % FAR_CYCLE
  const x = (k % BLOCKS_ACROSS) * FAR_BLOCK
  const y = Math.floor(k / BLOCKS_ACROSS) * FAR_BLOCK
  return {
    x,
    y,
    width: Math.min(FAR_BLOCK, FAR_WIDTH - x),
    height: Math.min(FAR_BLOCK, FAR_HEIGHT - y),
  }
}

/* ------------------------------------------------------------------------- */
/* What a texel holds                                                         */
/* ------------------------------------------------------------------------- */

/** Sub-columns along each side of a texel, and heights along each sub-column. */
const SUBCOLUMNS = 4
const HEIGHTS = 8
/** A sub-column whose column optical depth is under this is clear. */
const CLOUDY_TAU = 0.1
/**
 * Meters past each side of a layer that a texel's base and top are quantized
 * over, and that the march's shells reach.
 */
export const FAR_MARGIN = 500
/**
 * The log encoding the maps use for in-cloud τ (§3.9): log₂(1 + τ)/log₂(513),
 * τ up to 512 at 2.5% steps of 1 + τ. A deeper column is opaque at 512.
 */
const LOG_TAU = Math.log2(513)
/** A sub-column's spacing in warped units: a quarter of a texel, 2/(256·4). */
const SUBCOLUMN_WARPED = 2 / (FAR_TILE * SUBCOLUMNS)
/** The same spacing as an angle at a face's center, where the warp is π/4 a unit. */
const SUBCOLUMN_ANGLE = (Math.PI / 4) * SUBCOLUMN_WARPED

/** Level 0, named on every read: see the file comment. */
const LEVEL = { level: true } as const
const LEVEL0 = /*@__PURE__*/ float(0)

const encodeTau = (tau: F): F => saturate(log2(tau.add(1)).div(LOG_TAU))
const decodeTau = (code: F): F => exp2(code.mul(LOG_TAU)).sub(1)

/* ------------------------------------------------------------------------- */
/* TSL shapes the bake and the march share                                    */
/* ------------------------------------------------------------------------- */

/**
 * `Loop` with its variable named, which the typings do not admit and the
 * runtime honors: a nested `Loop` names its own variable `i` unless told, and
 * the outer index read inside it then silently reads the inner one.
 */
function loop(name: string, end: number | I, body: (index: I) => void): void {
  Loop(
    { start: 0, end, type: 'int', condition: '<', name } as never,
    (inputs: Record<string, I>) => body(inputs[name]!),
  )
}

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
export function faceDirection(face: F, a: F, b: F): V3 {
  const warp = Math.PI / 4
  return normalize(
    onFace(face, FACE_NORMALS)
      .add(onFace(face, FACE_A).mul(tan(a.mul(warp))))
      .add(onFace(face, FACE_B).mul(tan(b.mul(warp)))),
  )
}

/** The atlas texel a bake fragment draws: its face's column, its layer's row and its warped center. */
export interface FarTexel {
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
export function farTexel(): FarTexel {
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

/** A layer's heights over the datum and the eye's over them, by its index. */
export interface FarLayer {
  readonly base: F
  readonly top: F
  /** The eye's height over the base and the top, float64-formed on the CPU. */
  readonly eyeOverBase: F
  readonly eyeOverTop: F
}

/** Layer `k` of the body's shells, which `ShellHeights` lays out as [b₀, t₀, b₁, t₁, b₂, t₂]. */
export function farLayer(body: CloudBodyUniforms, k: number): FarLayer {
  if (k === 0)
    return {
      base: body.boundaries.x,
      top: body.boundaries.y,
      eyeOverBase: body.eyeOver.x,
      eyeOverTop: body.eyeOver.y,
    }
  if (k === 1)
    return {
      base: body.boundaries.z,
      top: body.boundaries.w,
      eyeOverBase: body.eyeOver.z,
      eyeOverTop: body.eyeOver.w,
    }
  return {
    base: body.boundariesHigh.x,
    top: body.boundariesHigh.y,
    eyeOverBase: body.eyeOverHigh.x,
    eyeOverTop: body.eyeOverHigh.y,
  }
}

/** The same layer's base and top chosen by an integer-valued float, as a bake fragment knows its row. */
export function farLayerAt(
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

/** A layer's effective radius, µm: the phase table's row for its light. */
function farRadius(uniforms: CloudUniforms, k: number): F {
  const radius = uniforms.layers.radius
  return k === 0 ? radius.x : k === 1 ? radius.y : radius.z
}

/**
 * The cosine to the vertical a path through a shell `thickness` thick at
 * `radius` is taken at, at least √(thickness/radius). A plane-parallel slant
 * τ/|μ| is infinite on a ray tangent to the shell, whose chord through the
 * shell's upper half is √(radius·thickness) each side of the tangent point:
 * τ over that floor is the chord's.
 */
export function slantCosine(mu: F, thickness: F, radius: F): F {
  return max(abs(mu), sqrt(max(thickness, 0).div(max(radius, 1))))
}

/** The eye's position from the body's center, body-fixed meters: float32, for coarse lookups only. */
export const centerOf = (body: CloudBodyUniforms): V3 =>
  body.up.mul(body.datumRadius.add(body.eye))

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
export interface FarColumn {
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
export function columnStatistics(
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
export function subColumnOf(face: F, a: F, b: F): (p: F, q: F) => V3 {
  return (p, q) =>
    faceDirection(
      face,
      a.add(p.sub(1.5).mul(SUBCOLUMN_WARPED)),
      b.add(q.sub(1.5).mul(SUBCOLUMN_WARPED)),
    )
}

/**
 * Sub-column (p, q) of a texel-sized column centered on `direction`, which
 * need not be a texel's center: the sub-columns' spacing at a face's center,
 * along any two axes square to the direction.
 */
export function subColumnAround(direction: V3): (p: F, q: F) => V3 {
  const center = direction.toVar()
  const helper = select(
    abs(center.y).lessThan(0.9),
    vec3(0, 1, 0),
    vec3(1, 0, 0),
  )
  const u = normalize(helper.cross(center)).mul(SUBCOLUMN_ANGLE).toVar()
  const v = center.cross(u).toVar()
  return (p, q) =>
    normalize(center.add(u.mul(p.sub(1.5))).add(v.mul(q.sub(1.5))))
}

/** The far atlases' read of layer `k` at a body-fixed direction: one level-0 read in the face tile. */
export function farRead(atlas: TextureNode, direction: V3, k: number): V4 {
  const uv = cubeAtlasUv(
    direction,
    FAR_TILE,
    FAR_GUTTER,
    FAR_COLUMNS,
    FAR_ROWS,
  ).add(vec2(0, k / FAR_ROWS))
  return atlas.sample(uv).level(LEVEL0)
}

/**
 * The footprint a far bake evaluates the field at: the handover's,
 * farFootprint = farDistance × pixelAngle. The far field takes over where a
 * trace texel spans that much, so it holds the field as the fine march sees it
 * there, and the sub-columns do the averaging a coarser footprint would.
 */
export const bakeFootprint = (uniforms: CloudUniforms): F =>
  uniforms.trace.farDistance.mul(uniforms.camera.pixelAngle)

/* ------------------------------------------------------------------------- */
/* The march's accumulation                                                   */
/* ------------------------------------------------------------------------- */

/** One body's air at a sample: `airMediumAt`'s shape, which a test replaces. */
export type AirMediumFn = typeof airMediumAt

/** What a far field may be built with besides its deps: the air a test injects. */
export interface FarOptions {
  /** The air's per-sample terms; `airMediumAt` unless a test needs an air the stub does not draw. */
  readonly air?: AirMediumFn
}

/** One column's crossing as the march takes it: a step [from, to] with its cloud inside it. */
export interface FarStep {
  readonly from: F
  readonly to: F
  /** Where the cloud starts along the ray, and how far it runs, meters. */
  readonly start: F
  readonly length: F
  /** The in-cloud optical depth over that run. */
  readonly tau: F
  readonly fraction: F
  /** The sun's light at the cloud per unit irradiance, phase not applied: T_sun times the beam. */
  readonly source: V3
}

/** The mean of a truncated exponential of rate τ on [0, 1], with its series under τ = 0.1. */
function exponentialMean(tau: F): F {
  const e = exp(tau.negate())
  const exact = float(1)
    .div(tau)
    .sub(e.div(oneMinus(e)))
  const series = float(0.5).sub(tau.div(12)).add(tau.mul(tau).mul(tau).div(720))
  return select(tau.lessThan(0.1), series, exact)
}

/** Its variance, with the series under τ = 0.1, where the exact form cancels in float32. */
function exponentialVariance(tau: F): F {
  const e = exp(tau.negate())
  const exact = float(1)
    .div(tau.mul(tau))
    .sub(e.div(oneMinus(e).mul(oneMinus(e))))
  const t2 = tau.mul(tau)
  const series = float(1 / 12)
    .sub(t2.div(240))
    .add(t2.mul(t2).div(6048))
  return select(tau.lessThan(0.1), series, max(exact, 0))
}

/** (1 − e^−τ)/τ, the mean transmittance across a uniform run, with the series under 0.01. */
function meanThrough(tau: F): F {
  const exact = oneMinus(exp(tau.negate())).div(max(tau, 0.01))
  const series = float(1).sub(tau.mul(0.5)).add(tau.mul(tau).div(6))
  return select(tau.lessThan(0.01), series, exact)
}

/**
 * The state one far march carries from `from` to the span's end, shared by
 * both candidates: the cloud's transmittance, the air's, each layer's light
 * before its phase, the blocked air, and the depth moments.
 *
 * The air is sampled once a step, at the step's middle, and once a gap
 * between steps, so the blocked air covers the whole span and not only the
 * shells: air behind a cloud the march has crossed is hidden wherever it is.
 * Its beam is the texel's class's (§5.11): the table's own for a sky texel,
 * cleared `ORBIT_AIRLIGHT` of the way for a surface texel, as the light the
 * composite takes for that class was built. The cloud's own beam is the one
 * the ground beside it takes, `sunThroughAt` at the whole `cleared`.
 *
 * The depth moments combine each step's own spread, the truncated
 * exponential its cloud's opacity follows, by the parallel-axis rule (a
 * weighted Welford update). With only each step's middle, a slab crossed in
 * one texel-long step reports a deviation of 0 m, and the composite's share
 * in front of the terrain becomes a hard edge at the slab's middle.
 */
export class FarMarch {
  readonly #ray: CloudRay
  readonly #body: CloudBodyUniforms
  readonly #sky: B
  readonly #air: AirMediumFn
  readonly #phases: AirPhases
  readonly #transmittance = float(1).toVar()
  readonly #airThrough = vec3(1).toVar()
  readonly #blocked = vec3(0).toVar()
  readonly #light = [vec3(0).toVar(), vec3(0).toVar(), vec3(0).toVar()]
  readonly #weight = float(0).toVar()
  readonly #mean: F
  readonly #spread = float(0).toVar()
  /** Where the march has reached along the ray. */
  readonly cursor: F

  /**
   * Everything the march reads in more than one of its blocks is declared
   * here, before any of them (see `farTexel`): the ray, the class, the air's
   * phases toward the sun.
   */
  constructor(
    ray: CloudRay,
    from: F,
    body: CloudBodyUniforms,
    sky: B,
    air: AirMediumFn,
  ) {
    this.#ray = {
      direction: ray.direction.toVar(),
      mu: ray.mu.toVar(),
      nu: ray.nu.toVar(),
      start: ray.start,
      end: ray.end,
    }
    this.#body = body
    this.#sky = sky.toVar()
    this.#air = air
    const phases = phasesToward(this.#ray.direction, body.sun)
    this.#phases = {
      rayleigh: phases.rayleigh.toVar(),
      mie: phases.mie.toVar(),
      forward: phases.forward.toVar(),
    }
    this.#mean = from.toVar()
    this.cursor = from.toVar()
  }

  /** The ray as the march reads it, its fields declared once. */
  get ray(): CloudRay {
    return this.#ray
  }

  /**
   * The air over [from, to]: its light, blocked by `cloudSeen` — the mean
   * cloud transmittance across the step relative to what stands in front of
   * it — and its optical depth, which the step's own light crosses part of.
   */
  #airOver(from: F, to: F, cloudSeen: F): Node<'vec3'> {
    const body = this.#body
    const air = body.air
    const sample = cloudSample(this.#ray, from.add(to).mul(0.5), body, float(0))
    const height = sample.altitude.div(body.datumRadius)
    const height01 = saturate(height.div(max(air.top.sub(1), 1e-6)))
    const table = sunTableAt(air, sample.sunMu, height01, LEVEL)
    const strength = select(
      this.#sky,
      float(0),
      body.cleared.mul(ORBIT_AIRLIGHT),
    )
    const beam = clearedBeam(air, table, height01, strength, LEVEL)
    const medium = this.#air(
      air,
      height,
      sample.sunMu,
      this.#phases,
      beam,
      LEVEL,
    )
    const span = max(to.sub(from), 0).div(body.datumRadius)
    const tau = medium.extinction.mul(span).toVar()
    const through = exp(tau.negate())
    const light = this.#airThrough
      .mul(medium.single.add(medium.multiple))
      .mul(span)
      .mul(stepShare(tau, through))
    this.#blocked.addAssign(
      light.mul(this.#transmittance.mul(cloudSeen).sub(1)),
    )
    return tau
  }

  /** Air alone from the cursor to `until`, which nothing in the march reaches past. */
  gap(until: F): void {
    const to = max(until, this.cursor).toVar()
    const tau = this.#airOver(this.cursor, to, float(1))
    this.#airThrough.mulAssign(exp(tau.negate()))
    this.cursor.assign(to)
  }

  /** One column's step, its cloud inside it; layer `k` takes its light. */
  step(step: FarStep, k: number): void {
    const c = step.fraction.toVar()
    const tau = step.tau.toVar()
    const run = step.length.toVar()
    const span = max(step.to.sub(step.from), 1e-3).toVar()
    const e = exp(tau.negate()).toVar()
    const through = oneMinus(c).add(c.mul(e)).toVar()
    // The step's air is spread along it and its cloud is a run inside it: the
    // air before the run sees nothing of it, the air in it the mean across
    // the run, the air after it the whole of it.
    const before = max(step.start.sub(step.from), 0)
    const after = max(step.to.sub(step.start).sub(run), 0)
    const seen = before
      .add(run.mul(oneMinus(c).add(c.mul(meanThrough(tau)))))
      .add(after.mul(through))
      .div(span)
    const center = step.start.add(run.mul(exponentialMean(tau))).toVar()
    // Every read of the march's state below comes before any write to it.
    const airTau = this.#airOver(step.from, step.to, seen)
    const weight = this.#transmittance.mul(c.mul(oneMinus(e))).toVar()
    // The cloud's light crosses the air from the step's start to its weight's center.
    const reach = clamp(center.sub(step.from).div(span), 0, 1)
    this.#light[k]!.addAssign(
      this.#airThrough
        .mul(exp(airTau.mul(reach).negate()))
        .mul(step.source)
        .mul(weight),
    )
    const total = this.#weight.add(weight).toVar()
    const share = weight.div(max(total, 1e-30)).toVar()
    const delta = center.sub(this.#mean).toVar()
    this.#spread.addAssign(
      weight
        .mul(run.mul(run).mul(exponentialVariance(tau)))
        .add(delta.mul(delta).mul(this.#weight).mul(share)),
    )
    this.#mean.addAssign(delta.mul(share))
    this.#weight.assign(total)
    this.#transmittance.mulAssign(through)
    this.#airThrough.mulAssign(exp(airTau.negate()))
    this.cursor.assign(max(step.to, this.cursor))
  }

  /** Each layer's light under its own droplets' phase; the moments as a mean and a deviation. */
  result(uniforms: CloudUniforms, phase: CloudPhaseNodes): CloudFarResult {
    const light = this.#light.reduce<V3>(
      (sum, layer, k) =>
        sum.add(
          layer.mul(phase.droplets(this.#ray.nu, farRadius(uniforms, k))),
        ),
      vec3(0),
    )
    const weighed = this.#weight.greaterThan(0)
    return {
      light,
      air: this.#blocked,
      transmittance: this.#transmittance,
      depthMean: this.#mean,
      depthDeviation: select(
        weighed,
        sqrt(max(this.#spread.div(max(this.#weight, 1e-30)), 0)),
        float(0),
      ),
    }
  }
}

/** The beam a cloud at an altitude takes: `sunThroughAt` at the whole `cleared`, as the ground's (§5.9). */
export function cloudBeam(body: CloudBodyUniforms, altitude: F, sunMu: F): V3 {
  const air = body.air
  const height01 = altitude.div(body.datumRadius).div(max(air.top.sub(1), 1e-6))
  return sunThroughAt(air, height01, sunMu, body.cleared, LEVEL)
}

/* ------------------------------------------------------------------------- */
/* The resource                                                               */
/* ------------------------------------------------------------------------- */

const LABELS = {
  atlas: 'cloud far atlas',
  spheres: 'cloud far spheres',
  second: 'cloud far second',
} as const

const NAMES = {
  atlas: 'farAtlas',
  spheres: 'farSpheres',
  second: 'farSecond',
} as const

const FORMATS = {
  rgba8: { type: UnsignedByteType, bytes: 4 },
  rgba16f: { type: HalfFloatType, bytes: 8 },
} as const

/**
 * The bake both candidates share: an atlas target, one scissored 192 × 192
 * block drawn a frame as one quad, so the bake is one pass on the timeline
 * and 45 blocks cover the atlas.
 *
 * It allocates at its real size only on a frame that selects it — the served
 * body's on `levers.far`, the second body's whenever there is one — and
 * shrinks back to 1 × 1 on a frame that does not, so a lever's A/B in one boot
 * declares one candidate's bytes and not both. A resize is followed at once by
 * `initRenderTarget`, which allocates without drawing, so what `textures()`
 * lists always exists on the GPU at the size `bytes` declares.
 *
 * The atlas is body-fixed, not eye-anchored, so a cut leaves it valid. It
 * starts the cycle over on a jump of the field's time, and when the scenario,
 * the body or the handover footprint it was baked at changes; until the cycle
 * is through it is `pending`. Between, it keeps baking a block a frame, which
 * refreshes the whole atlas every 45 frames for the field's time.
 */
export class FarBake implements CloudResource {
  readonly name: string
  readonly #label: string
  readonly #side: 'served' | 'second'
  readonly #kind: CloudFarKind
  readonly #texelBytes: number
  readonly #target: RenderTarget
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  #allocated = false
  #disposed = false
  #warm: Promise<void> | null = null
  #next = 0
  #due = 0
  #key: string | null = null

  constructor(
    deps: CloudFarDeps,
    kind: CloudFarKind,
    format: keyof typeof FORMATS,
    fragment: V4,
  ) {
    this.#side = deps.body
    this.#kind = kind
    const role = deps.body === 'second' ? 'second' : kind
    this.name = NAMES[role]
    this.#label = LABELS[role]
    this.#texelBytes = FORMATS[format].bytes
    this.#target = new RenderTarget(1, 1, {
      type: FORMATS[format].type,
      depthBuffer: false,
    })
    this.#target.texture.name = this.#label
    this.#material.fragmentNode = fragment
    this.#material.name = this.#label
  }

  /** What the march reads: the same texture object at every size, so no program rebinds. */
  get texture(): Texture {
    return this.#target.texture
  }

  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    return this.#target.width * this.#target.height * this.#texelBytes
  }

  get pending(): boolean {
    return !this.#disposed && this.#due > 0
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

  /**
   * One block, every frame that selects it, whatever the budget: the far
   * bake's cadence is fixed (§4.4), so its pass count on the timeline does not
   * move with the frame's other work.
   */
  render(renderer: WebGPURenderer, frame: CloudFrame): void {
    if (this.#disposed) return
    const body = this.#side === 'served' ? frame.served : frame.second
    if (
      body === null ||
      (this.#side === 'served' && frame.levers.far !== this.#kind)
    ) {
      this.#release(renderer)
      return
    }
    if (this.#target.width !== FAR_WIDTH || this.#target.height !== FAR_HEIGHT)
      this.#resize(renderer, FAR_WIDTH, FAR_HEIGHT)
    const key = `${frame.scenario.id} ${body.address} ${frame.levers.farFootprint}`
    if (key !== this.#key || frame.jump) {
      this.#key = key
      this.#next = 0
      this.#due = FAR_CYCLE
    }
    this.#draw(renderer)
  }

  #draw(renderer: WebGPURenderer): void {
    const block = farBlock(this.#next)
    const target = this.#target
    target.scissor.set(block.x, block.y, block.width, block.height)
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
    this.#next = (this.#next + 1) % FAR_CYCLE
    if (this.#due > 0) this.#due -= 1
  }

  #resize(renderer: WebGPURenderer, width: number, height: number): void {
    this.#target.setSize(width, height)
    renderer.initRenderTarget(this.#target)
    this.#allocated = true
  }

  #release(renderer: WebGPURenderer): void {
    this.#due = 0
    this.#key = null
    if (this.#target.width === 1 && this.#target.height === 1) return
    this.#resize(renderer, 1, 1)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#due = 0
    this.#target.dispose()
    this.#material.dispose()
  }
}

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

/** How far a ray runs inside a column's [base, top] over [from, to], and where that run starts. */
function cloudRun(
  body: CloudBodyUniforms,
  mu: F,
  from: F,
  to: F,
  base: F,
  top: F,
): { readonly start: F; readonly length: F } {
  // The eye's heights over this column's base and top: two heights, formed
  // here, never two radii.
  const upper = shellCrossing(body, mu, body.eye.sub(top), top)
  const lower = shellCrossing(body, mu, body.eye.sub(base), base)
  const overlap = (near: F, far: F): F =>
    max(min(to, far).sub(max(from, near)), 0)
  const inside = select(
    upper.hit,
    overlap(upper.near, upper.far),
    float(0),
  ).sub(select(lower.hit, overlap(lower.near, lower.far), float(0)))
  // The run starts where the ray first stands between the two spheres: past
  // the base's chord if the step begins inside it.
  const entry = max(from, upper.near)
  const underBase = lower.hit
    .and(entry.greaterThanEqual(lower.near))
    .and(entry.lessThan(lower.far))
  return {
    start: clamp(select(underBase, lower.far, entry), from, to),
    length: max(inside, 0),
  }
}

/** The shells a layer's march covers, [base − 500 m, top + 500 m], as their two intervals along the ray. */
function atlasIntervals(
  body: CloudBodyUniforms,
  ray: CloudRay,
  layer: FarLayer,
): {
  readonly near: readonly [F, F, B]
  readonly far: readonly [F, F, B]
} {
  const present = layer.top.greaterThan(layer.base)
  const high = shellCrossing(
    body,
    ray.mu,
    layer.eyeOverTop.sub(FAR_MARGIN),
    layer.top.add(FAR_MARGIN),
  )
  const low = shellCrossing(
    body,
    ray.mu,
    layer.eyeOverBase.add(FAR_MARGIN),
    layer.base.sub(FAR_MARGIN),
  )
  const met = present.and(high.hit)
  return {
    // Down into the shell and down out of it, or through it whole where the
    // ray never reaches its floor.
    near: [high.near, select(low.hit, low.near, high.far), met],
    // Back up out of the floor's chord and out through the top.
    far: [low.far, high.far, met.and(low.hit)],
  }
}

/**
 * The transmittance to the sun from a cloud sample in layer `k`: the layers
 * above along the sun, each one read at the sun ray's crossing of its
 * mid-height and mixed as one column, times half of its own column's depth
 * (§5.13 step 5). Times the beam, the light per unit irradiance there.
 */
function atlasSun(
  atlas: TextureNode,
  body: CloudBodyUniforms,
  sample: CloudSample,
  k: number,
  ownTau: F,
  thickness: F,
): V3 {
  const center = centerOf(body)
  const own = exp(
    ownTau
      .negate()
      .div(
        slantCosine(
          sample.sunMu,
          thickness,
          body.datumRadius.add(sample.altitude),
        ).mul(2),
      ),
  )
  let cloud: F = own
  for (let j = k + 1; j < FAR_ROWS; j += 1) {
    const above = farLayer(body, j)
    const middle = above.base.add(above.top).mul(0.5)
    const crossing = shellCrossingFrom(body, sample.offset, body.sun, middle)
    const point = sample.offset.add(body.sun.mul(crossing.far))
    const read = farRead(atlas, normalize(center.add(point)), j)
    const slant = slantCosine(
      sunMuAt(body, point),
      above.top.sub(above.base),
      body.datumRadius.add(middle),
    )
    const through = oneMinus(read.x).add(
      read.x.mul(exp(decodeTau(read.y).negate().div(slant))),
    )
    cloud = cloud.mul(
      select(above.top.greaterThan(above.base), through, float(1)),
    )
  }
  return cloudBeam(body, sample.altitude, sample.sunMu).mul(cloud)
}

/** The atlas's march: each layer's shells in t order, a texel a step, each step one column (§5.13). */
function atlasMarch(
  deps: CloudFarDeps,
  atlas: TextureNode,
  air: AirMediumFn,
): CloudFarFn {
  return (given, from, body, sky) => {
    const march = new FarMarch(given, from, body, sky, air)
    const ray = march.ray
    const end = given.end.toVar()
    const center = centerOf(body).toVar()
    const layers = [0, 1, 2].map((k) => farLayer(body, k))
    const shells = layers.map((layer) => atlasIntervals(body, ray, layer))
    /*
     * The shells are disjoint while the layers stand a kilometer apart, which
     * every scenario's do, so their intervals run in a fixed t order: down
     * through the top layer, the middle and the bottom, and back up through
     * the bottom, the middle and the top. A ray meets at most one of each.
     */
    const order = [
      [2, 'near'],
      [1, 'near'],
      [0, 'near'],
      [0, 'far'],
      [1, 'far'],
      [2, 'far'],
    ] as const
    for (const [k, side] of order) {
      const layer = layers[k]!
      const [enter, leave, met] = shells[k]![side]
      const start = max(enter, march.cursor).toVar()
      const stop = min(leave, end).toVar()
      If(met.and(stop.greaterThan(start)), () => {
        march.gap(start)
        const thickness = layer.top.sub(layer.base).toVar()
        // One texel a step: the face-center texel at the layer's height, the
        // largest on the face.
        const texel = body.datumRadius
          .add(layer.base.add(layer.top).mul(0.5))
          .mul(Math.PI / (2 * FAR_TILE))
        const span = stop.sub(start).toVar()
        const steps = clamp(ceil(span.div(texel)), 1, FAR_STEPS_A_LAYER).toVar()
        const delta = span.div(steps).toVar()
        loop(`farStep${k}${side}`, int(steps), (i) => {
          const t0 = start.add(float(i).mul(delta)).toVar()
          const t1 = t0.add(delta)
          const direction = normalize(
            center.add(ray.direction.mul(t0.add(delta.mul(0.5)))),
          )
          const read = farRead(atlas, direction, k).toVar()
          const floor = layer.base.sub(FAR_MARGIN)
          const range = thickness.add(2 * FAR_MARGIN)
          const base = floor.add(read.z.mul(range)).toVar()
          const top = floor.add(read.w.mul(range)).toVar()
          const run = cloudRun(body, ray.mu, t0, t1, base, top)
          const runStart = run.start.toVar()
          const runLength = run.length.toVar()
          const tau = decodeTau(read.y).toVar()
          const sample = cloudSample(
            ray,
            runStart.add(runLength.mul(0.5)),
            body,
            float(0),
          )
          march.step(
            {
              from: t0,
              to: t1,
              start: runStart,
              length: runLength,
              tau: tau.div(max(top.sub(base), 1e-3)).mul(runLength),
              fraction: read.x,
              source: atlasSun(atlas, body, sample, k, tau, thickness),
            },
            k,
          )
        })
      })
    }
    march.gap(end)
    return march.result(deps.uniforms, deps.phase)
  }
}

export class CloudFarAtlas extends FarBake implements CloudFarField {
  readonly far: CloudFarFn

  constructor(deps: CloudFarDeps, options: FarOptions = {}) {
    super(deps, 'atlas', 'rgba8', atlasBake(deps))
    this.far = atlasMarch(
      deps,
      texture(this.texture),
      options.air ?? airMediumAt,
    )
  }
}
