/*
 * A ray's crossing of a partly cloudy level, as the trace's kernel and the
 * far march are both held to it (plan §3): the CPU reference of
 * `apps/game/src/render/cloudMix.ts`.
 *
 * A ray is in the cloudy share of a column or out of it for the column's
 * whole crossing, and between columns the overlap is random, so a crossing
 * that counts `n` columns, each cloudy with probability `F`, passes
 *
 *     T = ((1 − F) + F·t(τ/n))ⁿ,   t(x) = (1 + x/k)^(−k)
 *
 * with `τ` the crossing's mean in-cloud depth along the ray and `t` the mean
 * transmittance of a column whose depth is spread as a gamma of shape `k`
 * about a mean `x`. **One depth cannot stand for a spread of depths on a
 * slant:** `(mean e^(−τ))^m` is under `mean e^(−m·τ)` for every path factor
 * over one, and with the cloudy columns all at one depth the form misses a
 * deck's resolved field by up to 32% (`weatherField.ts`, where each level's
 * four numbers are measured). As the shape grows the spread closes and
 * `t(x)` is `e^(−x)`.
 *
 * A march does not know where a column ends, so a step takes its share of
 * the crossing's exponent by its share of the chord, `n_i = n·s_i/s`, and
 * passes the same expression with its own numbers: under one cover, one
 * extinction and one shape `τ_i/n_i` is the same for every step, and the
 * product over any cut of the chord is the crossing's own.
 *
 * Mixing every step as its own column instead counts a half-clear layer's
 * clear share once a step: at a depth of 20, crossed in two steps, it passes
 * a quarter of the light where it passes half.
 *
 * **From a level's statistics** (`fraction` F, `depth` τ′, `shape` k and
 * `sight` c, the vertical depth being the one whose transmittance is the
 * cloudy columns' mean) a crossing of a level `thickness` thick at a zenith
 * angle θ is
 * `crossingTransmittance(F, spreadDepth(τ′, k)/cos θ, crossingExponent(thickness·tan θ, c), k)`:
 * straight down, `1 − F + F·e^(−τ′)` at any shape.
 *
 * **`crossingForm` in `weatherField.ts` is this file's oracle, and this file
 * is the kernel's.** `crossingForm` is the form a level's four numbers are
 * measured against, a whole crossing at one zenith angle, written once
 * there. The functions here are the same form cut so a march can take it a
 * step at a time, in arithmetic that holds where the whole form does not: a
 * thin column's opacity against one, a deep column's transmittance against
 * the clear share. `cloudOverlap.test.ts` holds their composition to
 * `crossingForm`, and `cloudTrace.gpu.test.ts` holds the kernel's functions
 * to these and the march itself to `crossingForm`. A level's shape is taken
 * as depths that do not spread from `UNSPREAD_SHAPE` up, the table's own
 * value for a level of one depth, where a column passes `e^(−x)`.
 */

import { UNSPREAD_SHAPE } from './weatherField.ts'

/**
 * The columns a crossing counts: `√(1 + (ℓ/c)²)` for a horizontal run `ℓ`
 * and a sight length `c`, meters. One for a vertical crossing; the run over
 * the sight length for a grazing one. The clear-line-of-sight form for
 * clouds with sides, which block from the side before the run reaches a
 * whole cell.
 */
export function crossingExponent(run: number, sight: number): number {
  const ratio = run / sight
  return Math.sqrt(1 + ratio * ratio)
}

/**
 * The mean of the gamma-spread depth whose mean transmittance is that of
 * one depth `depth`: `k·(e^(τ′/k) − 1)`, and `depth` itself where the
 * depths do not spread. A level's statistics hold the vertical depth whose
 * transmittance is the cloudy columns' mean; a slant path scales the mean
 * depth, not that one.
 */
export function spreadDepth(depth: number, shape: number): number {
  return shape >= UNSPREAD_SHAPE ? depth : shape * Math.expm1(depth / shape)
}

/**
 * −ln of a cloudy column's mean transmittance, its depth spread as a gamma
 * of `shape` about a mean `depth`: `k·ln(1 + x/k)`, and `depth` itself where
 * the depths do not spread.
 */
export function gammaDepth(depth: number, shape: number): number {
  return shape >= UNSPREAD_SHAPE ? depth : shape * Math.log1p(depth / shape)
}

/** Where air.ts's series takes over from the quotient. */
const SERIES_BELOW = 0.01

/**
 * (1 − e^−y)/y at any sign of y, with the series inside |y| = 0.01, as
 * air.ts's `stepShare`.
 *
 * One term past the shader's. In float32 the series' first dropped term,
 * y⁴/120, is below the arithmetic's own rounding; in float64 it is 8 × 10⁻¹¹
 * of a step at y = 0.01, which would show through the 10⁻¹² a split crossing
 * is held to. With y⁴/120 kept the first dropped term is y⁵/720, 1.4 × 10⁻¹³.
 * Outside the series, `expm1` takes the quotient without the subtraction
 * that cancels near zero.
 */
export function stepShare(y: number): number {
  if (Math.abs(y) < SERIES_BELOW)
    return 1 - y / 2 + (y * y) / 6 - (y ** 3 / 24 - y ** 4 / 120)
  return -Math.expm1(-y) / y
}

/**
 * The optical depth a step's mix is worth, −ln of what it passes: `cover`
 * the cloudy share it reads, `depth` the mean in-cloud optical depth it
 * crosses, `exponent` its share of the crossing's exponent, and `shape` the
 * gamma its columns' depths are spread by.
 *
 * At a cover of one with depths that do not spread it is `depth` whatever
 * the exponent, so a resolved cloud is Beer's law at any step. As the
 * exponent grows it tends to `cover·depth`, the mean medium: many thin
 * columns overlapped at random.
 */
export function crossingDepth(
  cover: number,
  depth: number,
  exponent: number,
  shape: number = UNSPREAD_SHAPE,
): number {
  if (depth <= 0 || cover <= 0) return 0
  if (cover >= 1 && shape >= UNSPREAD_SHAPE) return depth
  const column = gammaDepth(depth / exponent, shape)
  if (cover >= 1) return exponent * column
  // (1 − c) + c·t. A thin column's opacity is taken without the sum that
  // loses it against one; a deep column's `t` is added to the clear share
  // as it is, where forming `1 − c·(1 − t)` would lose it against `1 − c`.
  const mixed =
    column < 1
      ? Math.log1p(cover * Math.expm1(-column))
      : Math.log(1 - cover + cover * Math.exp(-column))
  return -exponent * mixed
}

/** What a step passes of the light behind it: `e^(−crossingDepth)`. */
export function crossingTransmittance(
  cover: number,
  depth: number,
  exponent: number,
  shape: number = UNSPREAD_SHAPE,
): number {
  return Math.exp(-crossingDepth(cover, depth, exponent, shape))
}

/**
 * The light a step adds per unit of what reaches its start, for a source
 * `start` at its near end and `end` at its far end, over a mixed optical
 * depth `depth` (`crossingDepth`).
 *
 * **The source is log-linear between the step's two ends.** Under a sun
 * whose own depth grows along the step the source falls exponentially, and
 * `∫ S₀·e^(−κt)·e^(−t) dt` over the step is
 * `S₀·(1 − e^(−(1 + κ)·τ))/(1 + κ)` with `κ = ln(S₀/S₁)/τ`: exact on a
 * uniform slab at any step length. A source taken at the step's start alone
 * is high by `k·(1 − e^(−τ))/(1 − e^(−k·τ))` with `k = 1 + μ/μ₀`: 15% at a
 * depth of 0.3 under equal sun and view angles, 52% at 1.16.
 *
 * **It is taken from whichever end leaves no exponential to overflow.** With
 * `y = τ + ln(S₀/S₁)` the integral is `S₀·τ·share(y)`, and where the source
 * grows along the step faster than the step dims it, `y < 0`, the same
 * integral is `S₁·e^(−τ)·τ·share(−y)`: the share's argument is never
 * negative, so two ends any number of e-folds apart are one form with no
 * step between them.
 *
 * Where an end is dark there is no logarithm to take, and the source is a
 * ramp between the two.
 */
export function stepLight(start: number, end: number, depth: number): number {
  if (start > 0 && end > 0) {
    const y = depth + (Math.log(start) - Math.log(end))
    return y >= 0
      ? start * depth * stepShare(y)
      : end * Math.exp(-depth) * depth * stepShare(-y)
  }
  const opacity = depth * stepShare(depth)
  // (1 − (1 + τ)·e^−τ)/τ: the weight of a ramp's far end.
  const ramp =
    depth < SERIES_BELOW
      ? depth * (1 / 2 - depth / 3 + (depth * depth) / 8 - depth ** 3 / 30)
      : (opacity - depth * Math.exp(-depth)) / depth
  return start * opacity + (end - start) * ramp
}

/* ------------------------------------------------------------------------- */
/* The slab a sample stands in                                                */
/* ------------------------------------------------------------------------- */

/**
 * A plane slab a sample stands in, as the source table reads it
 * (`slabSourceRead.ts`): the sun's cosine to its lit face, and the scaled
 * depths normal to it from the lit face to the sample and from the sample
 * to the far face.
 */
export interface SourceSlab {
  readonly sunMu: number
  readonly top: number
  readonly bottom: number
}

/** The least the sun's cosine is taken as: the source table's first row. */
export const SOURCE_SUN_FLOOR = 0.05
/** The least a view's cosine to the vertical is taken as where a column's depths are tilted by it. */
export const SOURCE_VIEW_FLOOR = 0.02
/** The least a level's mean depth is divided by. */
const NO_DEPTH = 1e-6

/**
 * A resolved step's slab: the depth along the sun's ray to the sun, and the
 * whole of that ray's, each times the sun's cosine to the local vertical,
 * its size where the sun stands under the sample's horizon. The CPU
 * reference of `resolvedSlab` in `apps/game/src/render/cloudMix.ts`.
 */
export function resolvedSlab(
  toSun: number,
  whole: number,
  sunMu: number,
): SourceSlab {
  const mu = Math.max(Math.abs(sunMu), SOURCE_SUN_FLOOR)
  return {
    sunMu: mu,
    top: mu * toSun,
    bottom: mu * Math.max(whole - toSun, 0),
  }
}

/**
 * A statistical step's slab at one Gauss point of the tilted gamma, and
 * that point's weight: the columns of a level whose depths are spread as a
 * gamma of `shape` about `mean`, weighed as a ray that has crossed the
 * share `seen` of the level at a cosine `viewMu` has weighed them, which is
 * a gamma of shape `k + 1` and scale `1/(k/m + s/μ_v)`. `point` 0 is the
 * shallower of two. The CPU reference of `statisticalSlab` in
 * `apps/game/src/render/cloudMix.ts`, which states the rule.
 */
export function statisticalSlab(
  statistics: { readonly shape: number; readonly mean: number },
  seen: number,
  viewMu: number,
  litSide: boolean,
  sunMu: number,
  point: 0 | 1,
  points: 1 | 2,
): { readonly slab: SourceSlab; readonly weight: number } {
  const { shape } = statistics
  const share = Math.min(Math.max(seen, 0), 1)
  const rate =
    shape / Math.max(statistics.mean, NO_DEPTH) +
    share / Math.max(viewMu, SOURCE_VIEW_FLOOR)
  const spread = Math.sqrt(shape + 2)
  const sign = point === 0 ? -1 : 1
  const column = (points === 1 ? shape + 1 : shape + 2 + sign * spread) / rate
  const under = litSide ? share : 1 - share
  return {
    slab: {
      sunMu: Math.max(Math.abs(sunMu), SOURCE_SUN_FLOOR),
      top: under * column,
      bottom: (1 - under) * column,
    },
    weight: points === 1 ? 1 : 0.5 - (0.5 * sign) / spread,
  }
}
