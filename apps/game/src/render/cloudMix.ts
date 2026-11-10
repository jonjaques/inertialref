import type { Node } from 'three/webgpu'
import {
  abs,
  exp,
  float,
  int,
  log,
  max,
  min,
  mix,
  select,
  sqrt,
  vec3,
} from 'three/tsl'
import { SIGHT_CELLS } from '@inertialref/rendering'
import type { CloudSunDepths } from './cloudNodes.ts'
import type { CloudLayerUniforms } from './cloudUniforms.ts'

/*
 * How a ray's crossing of a partly cloudy level is mixed, and what light a
 * step of it adds: the one law the fine march and the far march both take,
 * and the layers' statistics that stand in for the sun's cache where it
 * holds nothing. `packages/rendering/src/cloudOverlap.ts` is the same
 * arithmetic on the CPU, and `cloudTrace.gpu.test.ts` holds each function
 * here to it.
 *
 * A ray is in the cloudy share of a column or out of it for the column's
 * whole crossing, and between columns the overlap is random, so a crossing
 * of `n` columns passes `((1 − c) + c·e^(−τ/n))ⁿ`. A crossing counts
 * `n = √(1 + (ℓ/c)²)` columns for a horizontal run `ℓ` and a sight length
 * `c`, and a step takes its share of that by its share of the chord. Both
 * marches read the law here, so across the handover they differ only in the
 * resolution they read the cover and the depth at.
 *
 * **The statistics are the same law at the sample's own column** (§5.5).
 * They draw wherever the sun's cache does not: from orbit, where it idles,
 * past its reach, and while it is coming back after the field changed. The
 * sample's own level passes by its column on the sun's side, and every
 * level beyond it on that side by one crossing of its cover and its mean
 * depth. The layers are read where the sample stands and not where the
 * sun's ray meets them, which under a low sun is another column.
 */

/** The least a logarithm or a quotient here is taken of. */
const TINY = 1e-30
/** Where the series take over from the quotients that cancel in float32. */
const SERIES_BELOW = 0.01
/**
 * A column this deep passes nothing a float32 can add to its clear share:
 * e⁻⁴⁰ is 4 × 10⁻¹⁸, and a float's step under one is 6 × 10⁻⁸.
 */
const OPAQUE_COLUMN = 40

/**
 * The columns a crossing counts: from its horizontal run and the level's
 * noise cell, meters. The sight length is `SIGHT_CELLS` of the cell, the
 * ratio the clear lines of sight counted through the field fit
 * (`weatherField.test.ts`); a level carries no fitted length of its own.
 */
export function crossingExponent(
  run: Node<'float'>,
  cell: Node<'float'>,
): Node<'float'> {
  const ratio = run.div(max(cell, 1).mul(SIGHT_CELLS))
  return sqrt(ratio.mul(ratio).add(1))
}

/**
 * (1 − e^−y)/y at either sign of y, by its series inside |y| = 0.01, where
 * the subtraction cancels in float32.
 */
export function stepShare(y: Node<'float'>): Node<'float'> {
  const near = abs(y).lessThan(SERIES_BELOW)
  const safe = select(near, float(1), y)
  return select(
    near,
    y.mul(y.div(6).sub(0.5)).add(1),
    float(1).sub(exp(safe.negate())).div(safe),
  )
}

/**
 * The optical depth a step's mix is worth, −ln of what it passes: `cover`
 * the cloudy share it reads, `depth` the in-cloud optical depth it crosses,
 * `exponent` its share of the crossing's exponent.
 *
 * At a cover of one it is `depth` itself, so a resolved cloud is Beer's law
 * at any step and any exponent. Under it the depth of one column,
 * `depth/exponent`, is mixed and the exponent multiplies the result. Three
 * forms, because the mix is `1 − c·(1 − e^(−τ))` and a float32 loses a thin
 * column's opacity against the one and a deep column's `e^(−τ)` against
 * `1 − c`: a series under an opacity of a hundredth, the clear share alone
 * past a column depth of 40, and the logarithm between.
 */
export function crossingDepth(
  cover: Node<'float'>,
  depth: Node<'float'>,
  exponent: Node<'float'>,
): Node<'float'> {
  const n = max(exponent, TINY)
  const column = depth.div(n)
  const opacity = cover.mul(column).mul(stepShare(column))
  const thin = opacity.lessThan(SERIES_BELOW)
  const series = opacity.mul(opacity.mul(opacity.div(3).add(0.5)).add(1))
  const through = float(1)
    .sub(cover)
    .add(cover.mul(exp(min(column, OPAQUE_COLUMN).negate())))
  const mixed = select(
    thin,
    series,
    select(
      column.greaterThanEqual(OPAQUE_COLUMN),
      log(max(float(1).sub(cover), TINY)).negate(),
      log(max(through, TINY)).negate(),
    ),
  )
  return select(cover.greaterThanEqual(1), depth, n.mul(mixed))
}

/**
 * What a step passes of the light behind it: `cover` the cloudy share it
 * reads, `depth` the in-cloud optical depth it crosses, `exponent` its share
 * of the crossing's exponent.
 */
export function crossingTransmittance(
  cover: Node<'float'>,
  depth: Node<'float'>,
  exponent: Node<'float'>,
): Node<'float'> {
  return exp(crossingDepth(cover, depth, exponent).negate())
}

/** One band of `stepLight`. */
function bandLight(
  start: Node<'float'>,
  end: Node<'float'>,
  depth: Node<'float'>,
  through: Node<'float'>,
  ramp: Node<'float'>,
): Node<'float'> {
  const lit = start.greaterThan(0).and(end.greaterThan(0))
  const y = depth.add(log(max(start, TINY)).sub(log(max(end, TINY))))
  const falling = start.mul(depth).mul(stepShare(max(y, 0)))
  const rising = end
    .mul(through)
    .mul(depth)
    .mul(stepShare(max(y.negate(), 0)))
  const opacity = float(1).sub(through)
  return select(
    lit,
    select(y.greaterThanEqual(0), falling, rising),
    start.mul(opacity).add(end.sub(start).mul(ramp)),
  )
}

/**
 * The light a step adds per unit of what reaches its start, each band: its
 * source `start` at its near end and `end` at its far end, over the mixed
 * optical depth `depth` (`crossingDepth`).
 *
 * **The source is log-linear between the two ends** (§5.4): the integral of
 * `S₀·e^(−κt)·e^(−t)` over the step, with `κ` from the two ends, which is
 * exact where the sun's own depth grows along the step, at any step length.
 * A source held at the step's start is 15% high at a depth of 0.3 under
 * equal sun and view angles and 52% at 1.16, and no step count sees it.
 *
 * It is taken from whichever end leaves no exponential to overflow: with
 * `y = τ + ln(S₀/S₁)`, `S₀·τ·share(y)` where `y ≥ 0` and
 * `S₁·e^(−τ)·τ·share(−y)` where the source grows faster than the step dims
 * it. A band dark at either end has no logarithm to take and is a ramp
 * between the two.
 */
export function stepLight(
  start: Node<'vec3'>,
  end: Node<'vec3'>,
  depth: Node<'float'>,
): Node<'vec3'> {
  const through = exp(depth.negate())
  // (1 − (1 + τ)·e^−τ)/τ, the weight of a ramp's far end, by its series
  // where the quotient cancels.
  const thin = depth.lessThan(SERIES_BELOW)
  const safe = select(thin, float(1), depth)
  const ramp = select(
    thin,
    depth.mul(depth.mul(depth.div(8).sub(1 / 3)).add(0.5)),
    float(1).sub(safe.add(1).mul(through)).div(safe),
  )
  const band = (s: Node<'float'>, e: Node<'float'>): Node<'float'> =>
    bandLight(s, e, depth, through, ramp)
  return vec3(band(start.x, end.x), band(start.y, end.y), band(start.z, end.z))
}

/** What the layers' statistics read at a sample's own column. */
export interface SunStatisticsInput {
  readonly layers: CloudLayerUniforms
  /** The sample's level; −1 outside every one. */
  readonly level: Node<'int'>
  /** Each level's cover and cumuliform share at the sample's column. */
  readonly cover: Node<'vec3'>
  readonly convective: Node<'vec3'>
  /** `CloudMedium.depth`: the level's column above the sample, and whole. */
  readonly depth: Node<'vec2'>
  /** The sun's cosine over the sample's horizontal. */
  readonly sunMu: Node<'float'>
  /** The optical depth the light taps crossed toward the sun. */
  readonly taps: Node<'float'>
}

/** The least the sun's cosine is taken as: the slab source's first row. */
const SUN_MU_FLOOR = 0.05

/**
 * The cloud's transmittance to the sun past the taps, from the layers' own
 * statistics: the sample's level by its column on the sun's side, less what
 * the taps crossed, and each level beyond it on that side by its cover and
 * its mean depth, stratiform and cumuliform blended by the column's
 * cumuliform share.
 *
 * The sun's side is up while the sun stands over the sample's horizon, and
 * down under it: there the light comes in from below, the sample's column is
 * the part under it, and no level above shades. A sample outside every level
 * has no level to side the others by and is unshadowed.
 */
export function sunStatistics(input: SunStatisticsInput): Node<'float'> {
  const { layers, level, depth } = input
  const above = input.sunMu.greaterThanEqual(0)
  const mu = max(abs(input.sunMu), SUN_MU_FLOOR)
  // The level's horizontal run a unit of its thickness, along the sun.
  const lean = sqrt(max(float(1).sub(mu.mul(mu)), 0)).div(mu)
  const parts = (v: Node<'vec3'>): readonly Node<'float'>[] => [v.x, v.y, v.z]
  const cover = parts(input.cover)
  const convective = parts(input.convective)
  const stratiform = parts(layers.depthStratiform)
  const cumuliform = parts(layers.depthCumuliform)
  const thickness = parts(max(layers.top.sub(layers.base), 0) as Node<'vec3'>)
  const cell = parts(layers.cell)

  const column = select(above, depth.x, depth.y.sub(depth.x))
  let own: Node<'float'> = float(0)
  for (let k = 0; k < 3; k += 1)
    own = select(level.equal(int(k)), cover[k]!, own)
  // One column: the sample's own, whatever the sun's run across the level.
  let through = crossingTransmittance(
    own,
    max(column.div(mu).sub(input.taps), 0),
    float(1),
  )
  for (let j = 0; j < 3; j += 1) {
    const beyond = select(
      above,
      level.lessThan(int(j)),
      level.greaterThan(int(j)),
    )
    const crossing = crossingTransmittance(
      cover[j]!,
      mix(stratiform[j]!, cumuliform[j]!, convective[j]!).div(mu),
      crossingExponent(thickness[j]!.mul(lean), cell[j]!),
    )
    through = through.mul(select(beyond, crossing, float(1)))
  }
  return select(level.greaterThanEqual(int(0)), through, float(1))
}

/**
 * The cloud's transmittance to the sun past the taps, the cache's and the
 * statistics' mixed by the cache's weight: `w·e^(−τ) + (1 − w)·T_stat`. A
 * mix of transmittances and not of depths, so a sample at half weight is
 * half lit by each, and across the cache's ramp no two neighbors differ by
 * more than the weight's step times what the two disagree by.
 */
export function sunPastTaps(
  depths: Pick<CloudSunDepths, 'toSun' | 'weight'>,
  statistics: Node<'float'>,
): Node<'float'> {
  return mix(statistics, exp(depths.toSun.negate()), depths.weight)
}
