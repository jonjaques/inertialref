import type { Node } from 'three/webgpu'
import { abs, exp, float, int, max, mix, select, sqrt } from 'three/tsl'
import type { CloudSunDepths } from './cloudNodes.ts'
import type { CloudLayerUniforms } from './cloudUniforms.ts'

/*
 * How a ray's crossing of a partly cloudy level is mixed: the one law the
 * fine march and the far march both take, and the layers' statistics that
 * stand in for the sun's cache where it holds nothing.
 *
 * A ray is in the cloudy share of a column or out of it for the column's
 * whole crossing, and between columns the overlap is random, so a crossing
 * of `n` columns passes `((1 − c) + c·e^(−τ/n))ⁿ`. Both marches read the
 * law here, so across the handover they differ only in the resolution they
 * read the cover and the depth at.
 *
 * **A crossing is one column.** The exponent is one whatever the run, and a
 * step's mix is `(1 − c) + c·e^(−τ)`, as the fine march's segment closes.
 *
 * **The statistics are the same law at the sample's own column** (§5.5).
 * They draw wherever the sun's cache does not: from orbit, where it idles,
 * past its reach, and while it is coming back after the field changed. The
 * sample's own level passes by its column on the sun's side, and every
 * level beyond it on that side by one crossing of its cover and its mean
 * depth. The layers are read where the sample stands and not where the
 * sun's ray meets them, which under a low sun is another column.
 */

/**
 * The columns a crossing counts: from its horizontal run and the level's
 * sight length, meters. One.
 */
export function crossingExponent(
  _run: Node<'float'>,
  _sight: Node<'float'>,
): Node<'float'> {
  return float(1)
}

/**
 * What a step passes of the light behind it: `cover` the cloudy share it
 * reads, `depth` the in-cloud optical depth it crosses, `exponent` its share
 * of the crossing's exponent.
 */
export function crossingTransmittance(
  cover: Node<'float'>,
  depth: Node<'float'>,
  _exponent: Node<'float'>,
): Node<'float'> {
  return float(1)
    .sub(cover)
    .add(cover.mul(exp(depth.negate())))
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
