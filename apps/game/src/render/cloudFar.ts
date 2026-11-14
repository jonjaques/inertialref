import type { Node, TextureNode } from 'three/webgpu'
import {
  abs,
  ceil,
  clamp,
  exp,
  exp2,
  float,
  If,
  int,
  log2,
  Loop,
  max,
  min,
  normalize,
  oneMinus,
  saturate,
  select,
  sqrt,
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
import type {
  CloudFarFn,
  CloudFarResult,
  CloudPhaseNodes,
  CloudRay,
  CloudSample,
} from './cloudNodes.ts'
import type { CloudBodyUniforms } from './cloudUniforms.ts'

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
  result(phase: CloudPhaseNodes): CloudFarResult {
    const light = this.#light.reduce<V3>(
      (sum, layer, k) =>
        sum.add(
          layer.mul(phase.droplets(this.#ray.nu, farRadius(this.#body, k))),
        ),
      vec3(0),
    )
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
