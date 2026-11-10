import type { Node } from 'three/webgpu'
import {
  Break,
  exp,
  float,
  If,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  pow,
  select,
  vec2,
} from 'three/tsl'
import { sunThroughAt } from './air.ts'
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import { sunPastTaps, sunStatistics } from './cloudMix.ts'
import type {
  CloudMedium,
  CloudMediumFn,
  CloudSample,
  CloudSunDepthNodes,
  CloudSunFn,
} from './cloudNodes.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The sun a cloud sample sees (§5.4, §5.5): a few taps of the medium toward
 * the sun, mixed as one column, then the sun cache's depth past them or the
 * layers' own statistics where the cache holds nothing, and the air's own
 * beam at the sample's height, cleared from orbit as the ground's is.
 *
 * **The taps are spaced in optical depth.** The first is half a depth wide,
 * `0.5/σ` for the denser of the sample's own extinction and its level's
 * reference, and each next one twice the last, to a kilometer's reach. All of first order's light is within a depth or two of
 * a lit face, and taps at fixed distances count their medium whole by its
 * midpoint: one 250 m wide puts a face up to `σ·125 m` out, a depth of 4.4
 * in fair cumulus, where the transmittance is wrong by its exponential.
 * Spaced by depth, the error at a face is bounded by the first tap's half,
 * a depth of 0.25. Four taps reach `7.5/σ`, 210 m in fair cumulus; six reach
 * `31.5/σ`; eight are cut at the kilometer in any cloud thicker than a
 * cirrus.
 *
 * **What the taps do not reach is the cache's, and the cache is 400 m
 * cells.** On broken cloud the count is therefore the reach: against a march
 * of the field, fair cumulus under a 37.5° sun is 0.156 RMS of the sun at
 * four taps, 0.081 at six and 0.045 at eight, where four taps a kilometer
 * long in meters are 0.056 (`cloudSunAccuracy.gpu.test.ts`, on the Mac
 * mini's M6).
 *
 * The taps are one column: mixed tap by tap, each tap's (1 − c) would count
 * the column's clear share again, and a half-clear column of depth 20
 * crossed by two taps would pass a quarter of the sun where it passes half.
 * Past them the two multiply:
 * T = ((1 − c) + c·e^(−τ_taps))·(w·e^(−τ_cache) + (1 − w)·T_statistics).
 *
 * **The cache is read through its weight, never bare.** After the field
 * changes the cache holds nothing until it is whole again, and it ends 24 km
 * from the eye; a depth of zero read there is a sample lit as though nothing
 * stood past its taps, which then appears shadowed at once when the cache
 * returns, and a step in the light at its edge. The statistics draw across
 * both.
 *
 * The tap count is the `lightTaps` lever, a uniform, so changing it rebuilds
 * nothing: none, when the cache's depth is read at the sample itself and
 * covers the whole path, or two to eight. A tap is a sample of the same
 * medium at the view sample's footprint, its height from `altitudeAt`
 * (rule 52), so the field's reads are the march's own and bind nothing new.
 * Statements: built inside the march's `Fn`.
 */

/** The first tap's width, in optical depth of the sample's own medium; each next one doubles. */
export const LIGHT_TAP_DEPTH = 0.5
/** Meters toward the sun the taps reach at most. */
export const LIGHT_TAP_REACH = 1000
/** The least extinction a tap's width is formed from: a clear sample's taps are the reach. */
const NO_EXTINCTION = 1e-9
/** The least the sun's cosine turns a column's depth by: the statistics' own floor. */
const SUN_MU_FLOOR = 0.05

export interface CloudSunDeps {
  readonly uniforms: CloudUniforms
  readonly medium: CloudMediumFn
  readonly depth: CloudSunDepthNodes
  /**
   * The medium at a tap, given the step's own: a field that holds its cover
   * over the taps' reach reads only what varies along them. The whole medium
   * when absent.
   */
  readonly tap?: (
    sample: CloudSample,
    step: CloudMedium,
    body: CloudBodyUniforms,
  ) => CloudMedium
}

export function cloudSunFn(deps: CloudSunDeps): CloudSunFn {
  const taps = deps.uniforms.trace.lightTaps
  const tapMedium = deps.tap ?? ((at, _step, body) => deps.medium(at, body))
  return (sample, medium, body) => {
    const fraction = float(0).toVar()
    const depth = float(0).toVar()
    const reach = float(0).toVar()
    // Spaced by the denser of the sample's own extinction and its level's
    // reference: at a cloud's ragged edge the sample's own falls to nothing,
    // and half a depth of that is the whole reach in one tap.
    const { sigma: reference } = body.layers
    const levelSigma = select(
      medium.layer.equal(int(0)),
      reference.x,
      select(medium.layer.equal(int(1)), reference.y, reference.z),
    )
    const width = float(LIGHT_TAP_DEPTH)
      .div(max(max(medium.sigma, levelSigma), NO_EXTINCTION))
      .toVar()
    Loop({ start: int(0), end: int(taps), type: 'int', condition: '<' }, () => {
      // Cut at the reach: a tap past it reads nothing and ends the taps.
      const span = min(width, float(LIGHT_TAP_REACH).sub(reach))
      If(span.lessThanEqual(0), () => {
        Break()
      })
      const offset = sample.offset.add(body.sun.mul(reach.add(span.mul(0.5))))
      const at: CloudSample = {
        offset,
        distance: length(offset),
        altitude: altitudeAt(body, offset),
        sunMu: sunMuAt(body, offset),
        footprint: sample.footprint,
        // The ray's own, so a tap reads the representation its step reads.
        ...(sample.dither === undefined ? {} : { dither: sample.dither }),
      }
      const tapped = tapMedium(at, medium, body)
      fraction.assign(max(fraction, tapped.fraction))
      depth.addAssign(tapped.sigma.mul(span))
      reach.addAssign(span)
      width.mulAssign(2)
    })
    const depths = deps.depth.depths(sample.offset.add(body.sun.mul(reach)))
    // The sample's own level by its statistics at its column, where the
    // medium answers them. The levels beyond it are read nowhere along the
    // sun's ray, and take the climate's mean cover and cumuliform share.
    const statistics = sunStatistics({
      layers: body.layers,
      level: medium.layer,
      cover: body.climate.cover,
      convective: body.climate.convective,
      depth: medium.depth,
      sunMu: sample.sunMu,
      taps: depth,
      ...(medium.statistics === undefined ? {} : { own: medium.statistics }),
    })
    /** The taps' column at a depth scaled by `a`. */
    const throughTaps = (a: number): Node<'float'> =>
      float(1)
        .sub(fraction)
        .add(fraction.mul(exp(depth.mul(-a))))
    // Past the taps: the cache's depth where its weight is one, and
    // `sunPastTaps` where it is less, so the statistics' arithmetic runs
    // only where the weight leaves them a share.
    const past = exp(depths.toSun.negate()).toVar()
    If(depths.weight.lessThan(1), () => {
      past.assign(sunPastTaps(depths, statistics))
    })
    const cloud: Node<'float'> = throughTaps(1).mul(past)
    // The sun's cosine the column's depths are turned along the ray by.
    const slant = float(1).div(max(sample.sunMu.abs(), SUN_MU_FLOOR))
    const above = sample.sunMu.greaterThanEqual(0)
    const column = medium.depth
    const columnToSun = select(above, column.x, column.y.sub(column.x))
    const columnBehind = select(above, column.y.sub(column.x), column.x)
    const toSun = mix(
      columnToSun.mul(slant),
      depth.add(depths.toSun),
      depths.weight,
    )
    // The cache holds `behind` of what lies behind the point it is read at,
    // which is the taps' end: the taps' own stretch comes out of that, and
    // the statistics give the share the cache does not hold.
    const held = depths.weight.mul(depths.behind)
    const cached = depths.weight
      .mul(depths.whole.sub(depths.toSun))
      .sub(held.mul(depth))
    const behind = columnBehind
      .mul(slant)
      .mul(float(1).sub(held))
      .add(max(cached, 0))
    // The air's height, true meters: its top is in sea-level units.
    const airHeight = body.datumRadius.mul(max(body.air.top.sub(1), 1e-6))
    return {
      cloud,
      depth: vec2(toSun, toSun.add(behind)),
      octave: (a) =>
        throughTaps(a).mul(
          mix(
            pow(max(statistics, 0), float(a)),
            exp(depths.toSun.mul(-a)),
            depths.weight,
          ),
        ),
      air: sunThroughAt(
        body.air,
        sample.altitude.div(airHeight),
        sample.sunMu,
        body.cleared,
        { level: true },
      ),
    }
  }
}
