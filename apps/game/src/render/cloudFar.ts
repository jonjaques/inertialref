import type { Node, TextureNode } from 'three/webgpu'
import {
  abs,
  ceil,
  clamp,
  dot,
  exp,
  exp2,
  float,
  If,
  int,
  length,
  log,
  log2,
  Loop,
  max,
  min,
  normalize,
  oneMinus,
  saturate,
  select,
  sqrt,
  uint,
  vec2,
  vec3,
} from 'three/tsl'
import { MAX_CLOUD_LAYERS } from '@inertialref/rendering'
import {
  type AirPhases,
  airMediumAt,
  clearedBeam,
  ORBIT_AIRLIGHT,
  phasesToward,
  psiTableAt,
  stepShare,
  sunTableAt,
  sunThroughAt,
} from './air.ts'
import {
  cloudSample,
  cubeAtlasUv,
  shellCrossing,
  shellCrossingFrom,
  sunMuAt,
} from './cloudGeometry.ts'
import { CLOUD_TRANSPORTS } from './cloudLevers.ts'
import {
  crossingDepth,
  crossingExponent,
  skySource,
  spreadDepth,
  statisticalSlab,
  stepLightBand,
  stepRamp,
  stepShare as opacityShare,
  stepWeights,
  sunStatistics,
} from './cloudMix.ts'
import type {
  CloudFarFn,
  CloudFarResult,
  CloudPhaseNodes,
  CloudRay,
  CloudSample,
  CloudSkyAt,
  CloudSkyNodes,
  CloudSourceNodes,
} from './cloudNodes.ts'
import {
  CLOUD_CLIMATE_KINDS,
  type CloudBodyUniforms,
  type CloudUniforms,
} from './cloudUniforms.ts'

/*
 * The far march: a ray past the handover, marched through a body's layer
 * atlas (`cloudFarAtlas.ts`) as slabs, one texel a step, with the air
 * between and behind its cloud and the depth moments the composite places
 * the cloud by (§5.9).
 *
 * Every texture is read at level 0. The served body's march runs inside the
 * trace's kernel, but the second body's runs in the composite's fragment, in
 * control flow that differs per pixel, where WGSL allows no implicit
 * derivative. A march builds loops and variables, so it is called from
 * inside a kernel's or a material's `Fn`.
 */

export type F = Node<'float'>
export type I = Node<'int'>
export type V3 = Node<'vec3'>
export type V4 = Node<'vec4'>
export type B = Node<'bool'>

/* ------------------------------------------------------------------------- */
/* The atlas's layout, and what a texel's numbers are coded by                */
/* ------------------------------------------------------------------------- */

/** Interior texels a face tile has, and the neighbor texels it carries each side. */
export const FAR_TILE = 256

export const FAR_GUTTER = 1

export const FAR_SPAN = FAR_TILE + 2 * FAR_GUTTER

/** Six face tiles across; one row of them a layer. */
export const FAR_COLUMNS = 6

export const FAR_ROWS = MAX_CLOUD_LAYERS

export const FAR_WIDTH = FAR_COLUMNS * FAR_SPAN

export const FAR_HEIGHT = FAR_ROWS * FAR_SPAN

export const FAR_STEPS_A_LAYER = 32

/**
 * Meters past each side of a layer that a texel's base and top are quantized
 * over, and that the march's shells reach.
 */
export const FAR_MARGIN = 500

/**
 * The log encoding the maps use for in-cloud τ (§3.9): log₂(1 + τ)/log₂(513),
 * τ up to 512 at 2.5% steps of 1 + τ. A deeper column is opaque at 512. The
 * τ encoded is the unscaled one, so the code's steps sit where a column's
 * depth is measured; a march of a scaled medium scales what it decodes.
 */
export const LOG_TAU = Math.log2(513)

/** Level 0, named on every read: see the file comment. */
const LEVEL = { level: true } as const

export const LEVEL0 = /*@__PURE__*/ float(0)

export const encodeTau = (tau: F): F => saturate(log2(tau.add(1)).div(LOG_TAU))

export const decodeTau = (code: F): F => exp2(code.mul(LOG_TAU)).sub(1)

/* ------------------------------------------------------------------------- */
/* TSL shapes the bake and the march share                                    */
/* ------------------------------------------------------------------------- */

/**
 * `Loop` with its variable named, which the typings do not admit and the
 * runtime honors: a nested `Loop` names its own variable `i` unless told, and
 * the outer index read inside it then silently reads the inner one.
 */
export function loop(
  name: string,
  end: number | I,
  body: (index: I) => void,
): void {
  Loop(
    { start: 0, end, type: 'int', condition: '<', name } as never,
    (inputs: Record<string, I>) => body(inputs[name]!),
  )
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

/** A layer's effective radius, µm: the phase table's row for its light. */
function farRadius(body: CloudBodyUniforms, k: number): F {
  const radius = body.layers.radius
  return k === 0 ? radius.x : k === 1 ? radius.y : radius.z
}

/**
 * The cosine to the vertical a path through a shell `thickness` thick at
 * `radius` is taken at, at least √(thickness/radius). A plane-parallel slant
 * τ/|μ| is infinite on a ray tangent to the shell, whose chord through the
 * shell's upper half is √(radius·thickness) each side of the tangent point:
 * τ over that floor is the chord's.
 */
function slantCosine(mu: F, thickness: F, radius: F): F {
  return max(abs(mu), sqrt(max(thickness, 0).div(max(radius, 1))))
}

/** The eye's position from the body's center, body-fixed meters: float32, for coarse lookups only. */
export const centerOf = (body: CloudBodyUniforms): V3 =>
  body.up.mul(body.datumRadius.add(body.eye))

/** The atlas's read of layer `k` at a body-fixed direction: one level-0 read in the face tile. */
function farRead(atlas: TextureNode, direction: V3, k: number): V4 {
  const uv = cubeAtlasUv(
    direction,
    FAR_TILE,
    FAR_GUTTER,
    FAR_COLUMNS,
    FAR_ROWS,
  ).add(vec2(0, k / FAR_ROWS))
  return atlas.sample(uv).level(LEVEL0)
}

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
interface FarStep {
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
  /**
   * The light the cloud sends that no phase multiplies, per unit of the
   * step's opacity: the sun's orders past the first and the sky's. Absent
   * from a march that draws first order alone.
   */
  readonly rest?: V3
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
 * The sun's share a run of a homogeneous column sends back along the ray,
 * first order, over the run's opacity 1 − e^(−τ_s) that the step already
 * weighs it by: the run lit through the rest of its own column, an optical
 * depth `entry` toward the sun where the ray enters it and `exit` where it
 * leaves, linear between (plane-parallel):
 *
 *     ∫₀^τ_s e^(−τ − entry − (exit − entry)·τ/τ_s) dτ
 *       = τ_s·(e^(−entry) − e^(−(τ_s + exit)))/(τ_s + exit − entry)
 *
 * A column lit through half its own depth instead, e^(−τ_col/2μ_s), is right
 * to second order while it is thin and dark once it is not: a cumulus
 * column of τ 30 to 90 passes 10⁻¹⁰ to 10⁻³⁰ of the sun that way, where its
 * face toward the sun sends back μ_s/(μ_s + μ_v) of it; from orbit, where the
 * far march draws every ray, every cumulus cell would be a hole. Both exponents
 * stay at or under zero, `entry` and `exit` being depths, so nothing
 * overflows whichever way a ray runs through the column.
 */
function runSunShare(tau: F, entry: F, exit: F): F {
  const spread = tau.add(exit).sub(entry).toVar()
  const lit = exp(entry.negate())
  const integral = select(
    abs(spread).lessThan(1e-3),
    lit.mul(float(1).sub(spread.mul(0.5)).add(spread.mul(spread).div(6))),
    lit.sub(exp(tau.add(exit).negate())).div(spread),
  )
  // τ_s/(1 − e^(−τ_s)), with its series where the subtraction cancels.
  const perOpacity = select(
    tau.lessThan(1e-3),
    float(1).add(tau.mul(0.5)).add(tau.mul(tau).div(12)),
    tau.div(oneMinus(exp(tau.negate()))),
  )
  return integral.mul(perOpacity)
}

/**
 * Where a step's run enters and leaves its column, as optical depths toward
 * the sun through the rest of the column: σ·(top − h)/μ_s at either end's
 * height, σ the column's extinction a meter of height.
 */
function runDepths(
  body: CloudBodyUniforms,
  ray: CloudRay,
  run: { readonly start: F; readonly length: F },
  column: { readonly sigma: F; readonly top: F; readonly slant: F },
): { readonly entry: F; readonly exit: F } {
  const depth = (t: F): F =>
    column.sigma
      .mul(max(column.top.sub(cloudSample(ray, t, body, float(0)).altitude), 0))
      .div(column.slant)
  return {
    entry: depth(run.start),
    exit: depth(run.start.add(run.length)),
  }
}

/**
 * The state one far march carries from `from` to the span's end: the
 * cloud's transmittance, the air's, each layer's light
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
class FarMarch {
  readonly #ray: CloudRay
  readonly #body: CloudBodyUniforms
  readonly #sky: B
  readonly #air: AirMediumFn
  readonly #phases: AirPhases
  readonly #transmittance = float(1).toVar()
  readonly #airThrough = vec3(1).toVar()
  readonly #blocked = vec3(0).toVar()
  readonly #airLight = vec3(0).toVar()
  readonly #light = [vec3(0).toVar(), vec3(0).toVar(), vec3(0).toVar()]
  /** The light after first order so far, in a march that draws it: a register a first-order march never declares. */
  readonly #rest: V3 | null
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
    lit = false,
  ) {
    this.#rest = lit ? vec3(0).toVar() : null
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
    this.#airLight.addAssign(light)
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
    if (this.#rest !== null && step.rest !== undefined)
      this.#rest.addAssign(
        this.#airThrough
          .mul(exp(airTau.mul(reach).negate()))
          .mul(step.rest)
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

  /**
   * Each layer's light under its phase, and the moments as a mean and a
   * deviation. A march that draws first order alone takes every level's
   * phase as droplets'. One that draws every order takes the level's own
   * class with its gain, as the fine march does, and adds the light no
   * phase multiplies.
   */
  result(phase: CloudPhaseNodes): CloudFarResult {
    const lit = this.#rest
    const phased = this.#light.reduce<V3>((sum, layer, k) => {
      if (lit === null)
        return sum.add(
          layer.mul(phase.droplets(this.#ray.nu, farRadius(this.#body, k))),
        )
      const fetched = phase
        .phase(this.#ray.nu, this.#body.layers, k, farRadius(this.#body, k))
        .toVar()
      return sum.add(layer.mul(fetched.rgb.mul(fetched.a)))
    }, vec3(0))
    const light = lit === null ? phased : phased.add(lit)
    const weighed = this.#weight.greaterThan(0)
    return {
      light,
      air: this.#blocked,
      airLight: this.#airLight,
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
function cloudBeam(body: CloudBodyUniforms, altitude: F, sunMu: F): V3 {
  const air = body.air
  const height01 = altitude.div(body.datumRadius).div(max(air.top.sub(1), 1e-6))
  return sunThroughAt(air, height01, sunMu, body.cleared, LEVEL)
}

/* ------------------------------------------------------------------------- */
/* The march of a field that draws first order alone                          */
/* ------------------------------------------------------------------------- */

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
 * The sun's light at a cloud sample in layer `k` from above its own column:
 * the layers above along the sun, each one read at the sun ray's crossing of
 * its mid-height and mixed as one column (§5.13 step 5), times the beam. The
 * column's own depth above the sample is the step's (`runSunShare`).
 */
function atlasSun(
  atlas: TextureNode,
  body: CloudBodyUniforms,
  sample: CloudSample,
  k: number,
): V3 {
  const center = centerOf(body)
  let cloud: F = float(1)
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
export function atlasMarch(
  deps: { readonly phase: CloudPhaseNodes },
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
          const sigma = decodeTau(read.y)
            .div(max(top.sub(base), 1e-3))
            .toVar()
          const runTau = sigma.mul(runLength).toVar()
          const sample = cloudSample(
            ray,
            runStart.add(runLength.mul(0.5)),
            body,
            float(0),
          )
          const { entry, exit } = runDepths(
            body,
            ray,
            { start: runStart, length: runLength },
            {
              sigma,
              top,
              slant: slantCosine(
                sample.sunMu,
                thickness,
                body.datumRadius.add(sample.altitude),
              ),
            },
          )
          march.step(
            {
              from: t0,
              to: t1,
              start: runStart,
              length: runLength,
              tau: runTau,
              fraction: read.x,
              source: atlasSun(atlas, body, sample, k).mul(
                runSunShare(runTau, entry, exit),
              ),
            },
            k,
          )
        })
      })
    }
    march.gap(end)
    return march.result(deps.phase)
  }
}

/* ------------------------------------------------------------------------- */
/* The march of a field that draws every order                                */
/* ------------------------------------------------------------------------- */

/*
 * The served body's far march. Past the handover a cloud draws with the
 * light it drew before it: the sun's first order, its orders past the first
 * and the sky's, mixed by the one crossing's law (`cloudMix.ts`), every
 * rule imported from where the fine march reads it and none rewritten here.
 *
 * **A step passes the crossing's law by its share of the level's chord.** A
 * texel holds a cloudy share and the depth whose transmittance is its
 * cloudy columns' mean (`cloudFarAtlas.ts`). A level's crossing counts
 * `n = crossingExponent(ℓ, c)` columns over its chord, both known from the
 * level's two spheres before any step, and a step takes `n` in the share of
 * the chord its run inside the texel's cloud covers. Under one share and one
 * depth the product over any cut of the chord is the crossing's own, so a
 * level crossed in one step and in five passes the same.
 *
 * **The depth a run crosses is the level's profile's share of the column,**
 * read at the run's two heights: the share of the column between them,
 * times the run over the height it falls. A run that turns inside its step,
 * which only a ray grazing the level does, stands at one height, and
 * crosses the profile's extinction there along its length.
 *
 * **A step's light is its opacity times the source's mean over it,** each
 * source weighed as the step's own opacity weighs it: at Gauss points of
 * the opacity's cumulative share, `u = (1 − e^(−τ·x))/(1 − e^(−τ))` for a
 * place `x` along the run and the step's mixed depth `τ`. The fine march
 * takes tens of steps across a level and joins each one's two ends; a far
 * step crosses it in one, where two ends join the lit face to the far one
 * and read a deck's light after first order 10% to 32% low. In `u` the
 * source of a deck is nearly a line, and one point reads it within 2% at a
 * depth of 50 and 12% at worst, two within 2.5%, against the integral on
 * the plane slab's table. First order and the sky's light are closed forms
 * and take two points; the light after first order is the table's, four
 * fetches a point, and takes `HIGHER_POINTS`.
 *
 * **Each source is the fine march's statistical step's:** the sun through
 * `sunStatistics` with no taps, the sample's own column by the texel's
 * share and depth and the levels on the sun's side by the climate's; the
 * light after first order by `statisticalSlab`'s two points about the
 * level's true mean; the sky by `skySource` on the column's transport
 * depths. The view is laid in the sample's own frame.
 */

/** A level's numbers at a far crossing, which the crossing's law and the light after first order read. */
export interface FarLevelNodes {
  /** The gamma its cloudy columns' depths are spread by. */
  readonly shape: F
  /** Its sight length, meters. */
  readonly sight: F
  /** Its cloudy columns' true mean scaled depth: the level's, and no place's. */
  readonly mean: F
}

/** What a far field that draws every order reads beside its atlas. */
export interface FarLight {
  /** The trace's uniforms: the transport lever says whether the factor of the sun is taken. */
  readonly uniforms: CloudUniforms
  /**
   * The sky's light at a sample, from the body's sky table; null in a
   * system built without the sky's term, where a step draws the fine
   * march's placeholder and the kernel binds no sky table.
   */
  readonly sky: CloudSkyNodes | null
  readonly source: CloudSourceNodes
  /** Level `k`'s statistics at the level's own cover and cumuliform share: formed once a crossing. */
  level(body: CloudBodyUniforms, k: number): FarLevelNodes
  /**
   * Level `k`'s profile at a height, 0 at its base and 1 at its top: the
   * extinction's share there, that share's mean up the column, the share of
   * the column above, and the radius's share of the level's. One read.
   */
  profile(body: CloudBodyUniforms, k: number, h01: F): V4
}

/** Points the light after first order is read at across a step: Gauss points of the opacity's cumulative share. */
const HIGHER_POINTS: 1 | 2 = 2
/** Gauss–Legendre points on [0, 1], one and two. */
const GAUSS_ONE = [0.5] as const
const GAUSS_TWO = [0.2113248654, 0.7886751346] as const
/** `cloudMarch.ts`'s: the least a bearing is taken from, and the least sine the sky's sunward lean is divided by. */
const NO_BEARING = 1e-6
const SUN_OVERHEAD = 1e-3
/** `cloudMarch.ts`'s placeholder for the sky's light: Ψ × ½, isotropic. */
const SKY_SHARE = 0.5
const ISOTROPIC = 1 / (4 * Math.PI)
const SLAB_TRANSPORT = CLOUD_TRANSPORTS.indexOf('slab')
/** The least a depth or a length is divided by. */
const LEAST = 1e-9
/** The share of a level's thickness a run must fall for its two heights to say what it crossed. */
const LEVEL_RUN = 0.01
/** The share of a level's thickness inside which a height stands on its top or its base. */
const LEVEL_EDGE = 1e-3

/** A level's component of a per-level vector. */
const ofLevel = (v: V3, k: number): F => (k === 0 ? v.x : k === 1 ? v.y : v.z)

/** One crossing of a level proper, base to top: its chord and its horizontal run, meters (`cloudMarch.ts`, `levelCrossings`). */
function levelChords(
  body: CloudBodyUniforms,
  mu: F,
  layer: FarLayer,
): { readonly near: readonly [F, F]; readonly far: readonly [F, F] } {
  const base = shellCrossing(body, mu, layer.eyeOverBase, layer.base)
  const top = shellCrossing(body, mu, layer.eyeOverTop, layer.top)
  const thickness = layer.top.sub(layer.base)
  const reached = top.hit.and(thickness.greaterThan(0))
  const enter = max(top.near, 0)
  const leave = max(top.far, 0)
  const ahead = base.hit.and(base.far.greaterThan(0))
  const crossing = (valid: B, start: F, end: F, rise: F): readonly [F, F] => {
    const chord = select(valid, max(end.sub(start), 0), float(0))
    return [chord, sqrt(max(chord.mul(chord).sub(rise.mul(rise)), 0))]
  }
  const fall = select(
    top.near.greaterThan(0),
    select(ahead, thickness, float(0)),
    select(ahead, layer.eyeOverBase, layer.eyeOverTop),
  )
  return {
    near: crossing(
      reached,
      enter,
      select(ahead, max(base.near, 0), leave),
      fall,
    ),
    far: crossing(reached.and(ahead), max(base.far, 0), leave, thickness),
  }
}

/** The lit march: each layer's shells in t order, a texel a step, each step the crossing's law and the three sources. */
export function litMarch(
  deps: { readonly phase: CloudPhaseNodes; readonly light: FarLight },
  atlas: TextureNode,
  air: AirMediumFn,
): CloudFarFn {
  const { light } = deps
  return (given, from, body, sky) => {
    const march = new FarMarch(given, from, body, sky, air, true)
    const ray = march.ray
    const end = given.end.toVar()
    const center = centerOf(body).toVar()
    // The sample's frame, formed once a ray as the fine march forms it.
    const eyeRadius = body.datumRadius.add(body.eye).toVar()
    const sun = body.sun.toVar()
    const datum = body.datumRadius.toVar()
    // Each level's cumuliform share, which the factor of the sun and the
    // sky's light both read: a regime's own, and none under another climate.
    const shares = select(
      body.climate.kind.equal(uint(CLOUD_CLIMATE_KINDS.regime)),
      saturate(body.climate.convective),
      vec3(0),
    ).toVar()
    const factor = select(
      light.uniforms.trace.transport.equal(uint(SLAB_TRANSPORT)),
      float(1),
      float(0),
    ).toVar()
    const layers = [0, 1, 2].map((k) => farLayer(body, k))
    const shells = layers.map((layer) => atlasIntervals(body, ray, layer))
    const chords = layers.map((layer) => {
      const { near, far } = levelChords(body, ray.mu, layer)
      return {
        near: [near[0].toVar(), near[1].toVar()] as const,
        far: [far[0].toVar(), far[1].toVar()] as const,
      }
    })
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
      const [chord, run] = chords[k]![side]
      const start = max(enter, march.cursor).toVar()
      const stop = min(leave, end).toVar()
      If(met.and(stop.greaterThan(start)), () => {
        march.gap(start)
        const thickness = max(layer.top.sub(layer.base), 1e-3).toVar()
        // The level's own numbers, once a crossing.
        const level = light.level(body, k)
        const shape = level.shape.toVar()
        const mean = level.mean.toVar()
        const sight = level.sight.toVar()
        const exponent = crossingExponent(run, sight).toVar()
        const sourceLevel = light.source.level(int(k)).toVar()
        const gain = max(ofLevel(body.layers.gain, k), LEAST).toVar()
        const transport = ofLevel(body.layers.transport, k).toVar()
        const sigmaLevel = max(ofLevel(body.layers.sigma, k), LEAST).toVar()
        const radiusLevel = ofLevel(body.layers.radius, k).toVar()
        const cumuliform = ofLevel(shares, k).toVar()
        // One texel a step: the face-center texel at the layer's height, the
        // largest on the face.
        const texel = body.datumRadius
          .add(layer.base.add(layer.top).mul(0.5))
          .mul(Math.PI / (2 * FAR_TILE))
        const span = stop.sub(start).toVar()
        const steps = clamp(ceil(span.div(texel)), 1, FAR_STEPS_A_LAYER).toVar()
        const delta = span.div(steps).toVar()
        loop(`litStep${k}${side}`, int(steps), (i) => {
          const t0 = start.add(float(i).mul(delta)).toVar()
          const t1 = t0.add(delta)
          const direction = normalize(
            center.add(ray.direction.mul(t0.add(delta.mul(0.5)))),
          )
          const read = farRead(atlas, direction, k).toVar()
          const floor = layer.base.sub(FAR_MARGIN)
          const range = layer.top.sub(layer.base).add(2 * FAR_MARGIN)
          const base = floor.add(read.z.mul(range)).toVar()
          const top = floor.add(read.w.mul(range)).toVar()
          const inside = cloudRun(body, ray.mu, t0, t1, base, top)
          const runStart = inside.start.toVar()
          const runLength = inside.length.toVar()
          const depth = float(0).toVar()
          const first = vec3(0).toVar()
          const rest = vec3(0).toVar()
          If(read.x.greaterThan(0).and(runLength.greaterThan(0)), () => {
            // The texel's depth is coded unscaled, and the medium is the scaled one.
            const column = decodeTau(read.y).div(gain).toVar()
            const spread = select(
              column.greaterThan(LEAST),
              spreadDepth(column, shape).div(max(column, LEAST)),
              float(1),
            ).toVar()
            /** The ray's cosine to the local vertical where it stands `t` along it, and that height's own numbers. */
            const standing = (t: F) => {
              const sample = cloudSample(ray, t, body, float(0))
              const altitude = sample.altitude.toVar()
              const radius = max(datum.add(altitude), 1).toVar()
              return {
                sample,
                altitude,
                radius,
                rise: eyeRadius.mul(ray.mu).add(t).div(radius).toVar(),
              }
            }
            const head = standing(runStart)
            const tail = standing(runStart.add(runLength))
            const middle = standing(runStart.add(runLength.mul(0.5)))
            const h01 = (altitude: F): F =>
              saturate(altitude.sub(layer.base).div(thickness))
            // The level's profile, read once a step, at the run's middle:
            // the extinction's share there, its mean up the column, the
            // share of the column above, and the radius's share.
            const middle01 = h01(middle.altitude).toVar()
            const profile = light.profile(body, k, middle01).toVar()
            const meanShare = max(profile.y, LEAST).toVar()
            const slope = profile.x.div(meanShare).toVar()
            /**
             * The share of the column above one of the run's two ends: none
             * above the level's top and all of it under its base, where it
             * is known, so a run that crosses the level whole crosses the
             * whole column whatever the profile; and inside the level the
             * read's own at the run's middle, carried to the end's height
             * by the extinction there.
             */
            const aboveEnd = (altitude: F): F => {
              const at = h01(altitude).toVar()
              return select(
                at.greaterThanEqual(1 - LEVEL_EDGE),
                float(0),
                select(
                  at.lessThanEqual(LEVEL_EDGE),
                  float(1),
                  saturate(profile.z.sub(slope.mul(at.sub(middle01)))),
                ),
              )
            }
            const aboveHead = aboveEnd(head.altitude).toVar()
            const aboveTail = aboveEnd(tail.altitude).toVar()
            /**
             * The share above a place `x` along the run: a line from each
             * end to the middle's own read. Carried from the middle alone
             * by the extinction there, a level whose profile is a hump
             * reads its lit face at every place a step's light is taken.
             */
            const above = (x: F): F =>
              select(
                x.lessThan(0.5),
                aboveHead.add(profile.z.sub(aboveHead).mul(x.mul(2))),
                profile.z.add(aboveTail.sub(profile.z).mul(x.mul(2).sub(1))),
              )
            // What the run crosses of the column: the share between its two
            // heights over the height it falls, or, where it stands at one
            // height, the profile's extinction there.
            const fall = abs(head.altitude.sub(tail.altitude)).toVar()
            const flat = head.rise
              .mul(tail.rise)
              .lessThan(0)
              .or(fall.lessThan(thickness.mul(LEVEL_RUN)))
            const along = select(
              flat,
              slope.div(thickness),
              abs(aboveHead.sub(aboveTail)).div(max(fall, 1e-3)),
            )
              .mul(runLength)
              .toVar()
            depth.assign(
              crossingDepth(
                read.x,
                column.mul(spread).mul(along),
                exponent.mul(runLength).div(max(chord, 1e-3)),
                shape,
              ),
            )
            const opacity = depth.mul(opacityShare(depth)).toVar()
            // The level's nominal column, as the fine march's medium holds it.
            const nominal = sigmaLevel.mul(meanShare).mul(thickness).toVar()
            const beam = cloudBeam(
              body,
              middle.altitude,
              middle.sample.sunMu,
            ).toVar()
            const skyAt = light.sky?.at(middle.sample, body)
            const skyMean = skyAt?.mean.toVar()
            const sides =
              skyAt === undefined
                ? undefined
                : {
                    up: skyAt.up.toVar(),
                    sunward: skyAt.sunward.toVar(),
                    upper: skyAt.upper.toVar(),
                  }
            /** A place a share `x` of the way along the run. */
            const placeAt = (x: F) => {
              const at = standing(runStart.add(runLength.mul(x)))
              return { ...at, x, over: above(x).toVar() }
            }
            /** The place with a share `u` of the step's opacity in front of it. */
            const place = (u: number) =>
              placeAt(
                select(
                  depth.lessThan(1e-3),
                  float(u),
                  log(max(float(1).sub(opacity.mul(u)), LEAST))
                    .negate()
                    .div(max(depth, LEAST)),
                ).toVar(),
              )
            type Place = ReturnType<typeof place>
            /** First order's transmittance to the sun: the sample's column and the levels on the sun's side. */
            const sunAt = (at: Place): F =>
              sunStatistics({
                layers: body.layers,
                level: int(k),
                cover: body.climate.cover,
                convective: body.climate.convective,
                depth: vec2(at.over.mul(nominal), nominal),
                sunMu: at.sample.sunMu,
                taps: float(0),
                own: { fraction: read.x, depth: column, shape, sight },
              })
            /** The sky's light as a source: the column's transport depths over and under the sample. */
            const skyOf = (
              at: Place,
              skyMean: V3,
              sides: Pick<CloudSkyAt, 'up' | 'sunward' | 'upper'>,
            ): V3 => {
              const sigma = column.mul(slope).div(thickness)
              const scale = transport.mul(saturate(sigma.div(sigmaLevel)))
              const sunMu = at.sample.sunMu
              const sunward = ray.nu
                .sub(at.rise.mul(sunMu))
                .div(
                  max(
                    sqrt(max(float(1).sub(sunMu.mul(sunMu)), 0)),
                    SUN_OVERHEAD,
                  ),
                )
              return skyMean.mul(
                skySource(
                  sides,
                  at.over.mul(nominal).mul(scale),
                  float(1).sub(at.over).mul(nominal).mul(scale),
                  cumuliform,
                  float(1).sub(transport),
                  at.rise,
                  sunward,
                ),
              )
            }
            /** The sun's light past first order, per unit of its irradiance: two points of the tilted gamma. */
            const higherOf = (at: Place): F => {
              const sunMu = at.sample.sunMu
              const above = sunMu.greaterThanEqual(0)
              const up = center.add(at.sample.offset).div(at.radius)
              const eyeLaid = up.mul(at.rise).sub(ray.direction)
              const sunLaid = up.mul(sunMu).sub(sun)
              const laid = length(eyeLaid).mul(length(sunLaid))
              const bearing = select(
                laid.greaterThan(NO_BEARING),
                dot(eyeLaid, sunLaid).div(max(laid, NO_BEARING)),
                float(0),
              )
              const view = light.source.view(
                select(above, at.rise.negate(), at.rise),
                bearing,
              )
              const down = at.rise.lessThan(0)
              const seen = select(down, at.over, float(1).sub(at.over))
              const litSide = down.and(above).or(down.not().and(above.not()))
              const radius = radiusLevel.mul(profile.w)
              const convective = cumuliform.mul(factor)
              const point = (which: 0 | 1): F => {
                const gauss = statisticalSlab(
                  { shape, mean },
                  seen,
                  abs(at.rise),
                  litSide,
                  sunMu,
                  which,
                  2,
                )
                return gauss.weight.mul(
                  light.source.source(
                    { ...gauss.slab, convective },
                    radius,
                    sourceLevel,
                    view,
                  ),
                )
              }
              return point(0).add(point(1))
            }
            const ends = [placeAt(float(0)), placeAt(float(1))] as const
            const two = GAUSS_TWO.map(place)
            /*
             * First order joins four places as the fine march joins its
             * steps' ends, log-linear between each pair: exact where the
             * sun's depth grows along the run, which a slab's does. The
             * sky's light is a ramp between the run's two ends, as it is
             * between a fine step's.
             */
            const across = [ends[0], two[0]!, two[1]!, ends[1]]
            const suns = across.map((at) => sunAt(at).toVar())
            const lit = float(0).toVar()
            for (let j = 0; j < 3; j += 1) {
              const from = across[j]!.x
              const piece = depth.mul(across[j + 1]!.x.sub(from)).toVar()
              lit.addAssign(
                exp(depth.mul(from).negate()).mul(
                  stepLightBand(suns[j]!, suns[j + 1]!, piece),
                ),
              )
            }
            const share = float(1).div(max(opacity, LEAST)).toVar()
            first.assign(beam.mul(lit.mul(share)))
            const higher =
              HIGHER_POINTS === 2
                ? higherOf(two[0]!).add(higherOf(two[1]!)).mul(0.5)
                : higherOf(place(GAUSS_ONE[0]))
            // Without the sky's term, the fine march's placeholder: Ψ at a
            // half, isotropic, the same over the step.
            const skyLight =
              skyMean === undefined || sides === undefined
                ? psiTableAt(
                    body.air,
                    middle.sample.sunMu,
                    saturate(
                      middle.altitude
                        .div(datum)
                        .div(max(body.air.top.sub(1), 1e-6)),
                    ),
                    LEVEL,
                  ).mul(SKY_SHARE * ISOTROPIC)
                : stepRamp(
                    skyOf(ends[0], skyMean, sides),
                    skyOf(ends[1], skyMean, sides),
                    stepWeights(depth),
                  ).mul(share)
            rest.assign(beam.mul(higher).add(skyLight))
          })
          march.step(
            {
              from: t0,
              to: t1,
              start: runStart,
              length: runLength,
              tau: depth,
              fraction: float(1),
              source: first,
              rest,
            },
            k,
          )
        })
      })
    }
    march.gap(end)
    return march.result(deps.phase)
  }
}
