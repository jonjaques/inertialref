import type { Node } from 'three/webgpu'
import {
  abs,
  clamp,
  exp,
  float,
  int,
  log,
  max,
  min,
  mix,
  select,
  sqrt,
  vec2,
  vec3,
} from 'three/tsl'
import { UNSPREAD_SHAPE } from '@inertialref/rendering'
import type {
  CloudLevelStatistics,
  CloudSourceSlab,
  CloudSunDepths,
} from './cloudNodes.ts'
import type { CloudLayerUniforms } from './cloudUniforms.ts'

/*
 * How a ray's crossing of a partly cloudy level is mixed, and what light a
 * step of it adds: the one law the fine march and the far march both take,
 * and the layers' statistics that stand in for the sun's cache where it
 * holds nothing, and the slab a sample stands in for the light after first
 * order. `packages/rendering/src/cloudOverlap.ts` is the same arithmetic on
 * the CPU, and `cloudTrace.gpu.test.ts` and `cloudSource.gpu.test.ts` hold
 * each function here to it.
 *
 * A ray is in the cloudy share of a column or out of it for the column's
 * whole crossing, and between columns the overlap is random, so a crossing
 * of `n` columns, each cloudy with probability `F`, passes
 * `((1 − F) + F·t(τ/n))ⁿ`, with `t(x) = (1 + x/k)^(−k)` the mean
 * transmittance of a column whose depth is spread as a gamma of shape `k`
 * about a mean `x`: one depth cannot stand for a spread of depths on a
 * slant, and a deck is mostly its thin places there. A crossing counts
 * `n = √(1 + (ℓ/c)²)` columns for a horizontal run `ℓ` and a sight length
 * `c`, and a step takes its share of that by its share of the chord. Both
 * marches read the law here, so across the handover they differ only in the
 * resolution they read the level's numbers at.
 *
 * **A level's four numbers at a column** are its cloudy share `F`, the
 * vertical depth `τ′` whose transmittance is the cloudy columns' mean, the
 * shape `k` and the sight length `c`. A crossing at a path factor `m` is
 * `crossingTransmittance(F, spreadDepth(τ′, k)·m, crossingExponent(ℓ, c), k)`.
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
 * The columns a crossing counts, `√(1 + (ℓ/c)²)`: from its horizontal run
 * and the level's sight length, meters.
 */
export function crossingExponent(
  run: Node<'float'>,
  sight: Node<'float'>,
): Node<'float'> {
  const ratio = run.div(max(sight, 1))
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

/** A shape from which a column's depths do not spread, as a node. */
const unspread = (shape: Node<'float'>): Node<'bool'> =>
  shape.greaterThanEqual(UNSPREAD_SHAPE)

/**
 * The mean of the gamma-spread depth whose mean transmittance is that of
 * one depth `depth`: `k·(e^(τ′/k) − 1)`, and `depth` itself where the depths
 * do not spread. A slant path scales this mean, not the depth it stands for.
 */
export function spreadDepth(
  depth: Node<'float'>,
  shape: Node<'float'>,
): Node<'float'> {
  // e⁸⁰ is the most a float32 holds short of infinity with room to multiply.
  const folds = min(depth.div(max(shape, TINY)), 80)
  return select(
    unspread(shape),
    depth,
    shape.mul(folds).mul(stepShare(folds.negate())),
  )
}

/**
 * −ln of a cloudy column's mean transmittance, its depth spread as a gamma
 * of `shape` about a mean `depth`: `k·ln(1 + x/k)`, and `depth` itself where
 * the depths do not spread.
 *
 * The logarithm is taken by its series under `x/k` of a hundredth: a
 * float32's `1 + x/k` holds four digits of `x/k` at a shape of a thousand,
 * and the exponent would carry that loss whole.
 */
export function gammaDepth(
  depth: Node<'float'>,
  shape: Node<'float'>,
): Node<'float'> {
  const u = depth.div(max(shape, TINY))
  const logarithm = select(
    u.lessThan(SERIES_BELOW),
    u.mul(u.mul(u.div(3).sub(0.5)).add(1)),
    log(u.add(1)),
  )
  return select(unspread(shape), depth, shape.mul(logarithm))
}

/**
 * The optical depth a step's mix is worth, −ln of what it passes: `cover`
 * the cloudy share it reads, `depth` the mean in-cloud optical depth it
 * crosses, `exponent` its share of the crossing's exponent, and `shape` the
 * gamma its columns' depths are spread by, none when absent.
 *
 * At a cover of one with depths that do not spread it is `depth` itself, so
 * a resolved cloud is Beer's law at any step and any exponent. Under it the
 * depth of one column, `depth/exponent` through `gammaDepth`, is mixed and
 * the exponent multiplies the result. Three forms, because the mix is
 * `1 − c·(1 − t)` and a float32 loses a thin column's opacity against the
 * one and a deep column's `t` against `1 − c`: a series under an opacity of
 * a hundredth, the clear share alone past a column depth of 40, and the
 * logarithm between.
 */
export function crossingDepth(
  cover: Node<'float'>,
  depth: Node<'float'>,
  exponent: Node<'float'>,
  shape: Node<'float'> = float(UNSPREAD_SHAPE),
): Node<'float'> {
  const n = max(exponent, TINY)
  const column = gammaDepth(depth.div(n), shape)
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
  return select(
    cover.greaterThanEqual(1),
    select(unspread(shape), depth, n.mul(column)),
    n.mul(mixed),
  )
}

/**
 * What a step passes of the light behind it: `cover` the cloudy share it
 * reads, `depth` the mean in-cloud optical depth it crosses, `exponent` its
 * share of the crossing's exponent, `shape` the gamma its columns' depths
 * are spread by, none when absent.
 */
export function crossingTransmittance(
  cover: Node<'float'>,
  depth: Node<'float'>,
  exponent: Node<'float'>,
  shape: Node<'float'> = float(UNSPREAD_SHAPE),
): Node<'float'> {
  return exp(crossingDepth(cover, depth, exponent, shape).negate())
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

/**
 * `stepLight` for one value that the three bands share: a source that is
 * one number for the three, which a caller multiplies by its bands after.
 */
export function stepLightBand(
  start: Node<'float'>,
  end: Node<'float'>,
  depth: Node<'float'>,
): Node<'float'> {
  const through = exp(depth.negate())
  const thin = depth.lessThan(SERIES_BELOW)
  const safe = select(thin, float(1), depth)
  const ramp = select(
    thin,
    depth.mul(depth.mul(depth.div(8).sub(1 / 3)).add(0.5)),
    float(1).sub(safe.add(1).mul(through)).div(safe),
  )
  return bandLight(start, end, depth, through, ramp)
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
  /**
   * The sample's own level's statistics at its column, where the medium
   * answers them: its cloudy share in place of the climate's mean cover, and
   * the gamma its columns' depths are spread by.
   */
  readonly own?: CloudLevelStatistics
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
  // With the level's statistics it is cloudy by their share, and its depth
  // along the sun is the spread's mean in the share the column holds of the
  // level's own, as a slant crossing's is.
  const { own: statistics } = input
  const slant = column.div(mu)
  let through =
    statistics === undefined
      ? crossingTransmittance(own, max(slant.sub(input.taps), 0), float(1))
      : crossingTransmittance(
          statistics.fraction,
          max(
            slant
              .mul(
                spreadDepth(statistics.depth, statistics.shape).div(
                  max(statistics.depth, TINY),
                ),
              )
              .sub(input.taps),
            0,
          ),
          float(1),
          statistics.shape,
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

/* ------------------------------------------------------------------------- */
/* The slab a sample stands in                                                */
/* ------------------------------------------------------------------------- */

/*
 * The light after first order is a plane slab's source, read at the slab a
 * sample stands in (`CloudSourceNodes.source`). What that slab is, is a
 * rule, and the two here are the only ones: both marches import them, so
 * across the handover they differ in the statistics they were handed and
 * never in what "depth" means.
 */

/** The least a view's cosine to the vertical is taken as where a column's depths are tilted by it. */
const VIEW_MU_FLOOR = 0.02
/** The least a level's mean depth is divided by. */
const NO_DEPTH = 1e-6

/**
 * A resolved step's slab (design §5.5): the sample's depth along the sun's
 * ray and the whole of that ray's (`CloudSun.depth`), each times the sun's
 * cosine to the local vertical, which is exact in a deck. `sunMu` is the
 * sample's own, signed: under the sample's horizon the lit face is the
 * base, the depths are already sided that way, and the cosine is its size.
 * A whole depth under the depth to the sun leaves nothing behind.
 */
export function resolvedSlab(
  sun: Node<'vec2'>,
  sunMu: Node<'float'>,
): CloudSourceSlab {
  const mu = max(abs(sunMu), SUN_MU_FLOOR)
  return {
    sunMu: mu,
    depth: vec2(sun.x, max(sun.y.sub(sun.x), 0)).mul(mu),
  }
}

/**
 * A statistical step's slab at one Gauss point of the tilted gamma, and
 * that point's weight.
 *
 * A sample that stands for a footprint stands for a spread of columns, and
 * one read at any one depth is wrong by a factor: at the level's nominal
 * column the light after first order reads +39% to +93% from above over
 * broken cloud, and at the depth the statistics' transmittance carries
 * −45% to −59%. Under independent columns the march's own sum is exact
 * when the source at a sample is the table's mean over the columns as the
 * ray has weighed them by then: a column of depth `τ` is seen through
 * `e^(−s·τ/μ_v)` of itself and adds in proportion to `τ`, so the columns a
 * gamma of shape `k` and mean `m` spreads are weighed as a gamma of shape
 * `k + 1` and scale `1/(k/m + s/μ_v)`. Its Gauss points:
 *
 *     one:  τ = (k + 1)/(k/m + s/μ_v), weight 1
 *     two:  τ = ((k + 2) ∓ √(k + 2))/(k/m + s/μ_v), weights ½ ± 1/(2·√(k + 2))
 *
 * `point` 0 is the shallower. A column of depth `τ` holds the sample at
 * `h·τ` under its lit face, `h = s` where the eye's face is the lit one and
 * `1 − s` where it is not. The depths are a column's and go to the node as
 * they are: no cosine of the sun turns them.
 *
 * `mean` is the level's true mean depth (`CloudLevelStatistics.mean`),
 * never the mean its transmittance implies, which is 1.3 to 3 times it.
 * The crossing's exponent has no place in the weight: on a slant it reads
 * +18% to +21% over fair cumulus where one column reads within 2%.
 */
export function statisticalSlab(
  statistics: {
    readonly shape: Node<'float'>
    readonly mean: Node<'float'>
  },
  /** The share of the level's column between the eye's face and the sample. */
  seen: Node<'float'>,
  /** |cosine| of the view to the local vertical. */
  viewMu: Node<'float'>,
  /** Whether the eye's face is the lit one. */
  litSide: Node<'bool'>,
  sunMu: Node<'float'>,
  point: 0 | 1,
  points: 1 | 2,
): { readonly slab: CloudSourceSlab; readonly weight: Node<'float'> } {
  const { shape } = statistics
  const share = clamp(seen, 0, 1)
  const rate = shape
    .div(max(statistics.mean, NO_DEPTH))
    .add(share.div(max(viewMu, VIEW_MU_FLOOR)))
  const spread = sqrt(shape.add(2))
  const sign = point === 0 ? -1 : 1
  const column = (
    points === 1 ? shape.add(1) : shape.add(2).add(spread.mul(sign))
  ).div(rate)
  const under = select(litSide, share, float(1).sub(share))
  return {
    slab: {
      sunMu: max(abs(sunMu), SUN_MU_FLOOR),
      depth: vec2(under, float(1).sub(under)).mul(column),
    },
    weight:
      points === 1 ? float(1) : float(0.5).sub(float(0.5 * sign).div(spread)),
  }
}
