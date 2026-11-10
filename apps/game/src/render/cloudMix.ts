import type { Node } from 'three/webgpu'
import { exp, float } from 'three/tsl'
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
 * The statistics pass everything: no cloud past the taps.
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

/**
 * The cloud's transmittance to the sun past the taps, from the layers' own
 * statistics: the sample's level by its column on the sun's side, and each
 * level beyond it on that side by its cover and mean depth. One.
 */
export function sunStatistics(_input: SunStatisticsInput): Node<'float'> {
  return float(1)
}
