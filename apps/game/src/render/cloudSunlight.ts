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
  CloudSun,
  CloudSunDepthNodes,
} from './cloudNodes.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The sun a cloud sample sees (§5.4, §5.5): a few taps of the medium toward
 * the sun, mixed as one column, then the sun cache's depth past them or the
 * layers' own statistics where the cache holds nothing, and the air's own
 * beam at the sample's height, cleared from orbit as the ground's is.
 *
 * **The taps resolve the cloud the sample stands in, and the cache what
 * shades it from beyond.** The cache is 400 m cells: it says how much of the
 * sun a neighborhood passes, and nothing of a lit face inside one. So the
 * taps reach half a kilometer, about a cumulus's own depth toward the sun,
 * and the cache is read where they end.
 *
 * **Their ends are geometric, from one optical depth to the reach.** The
 * first tap is one depth wide, `1/σ` for the denser of the sample's own
 * extinction and its level's reference, and each next end is the last
 * times one ratio, the one that puts the last tap's end on the reach. All of
 * first order's light is within a depth or two of a lit face, and a tap
 * counts its medium whole by its midpoint: over where a face falls in the
 * first depth the mean transmittance is 8% high with a first tap of one
 * depth, and 50% high with one a quarter of a kilometer wide.
 *
 * **They end where the sun's ray leaves the sample's level,** its top under
 * a sun over the sample's horizon and its base under one below it. Under a
 * deck's top a tap laid past it reads clear air and tells the cloud below
 * it nothing; ended at the top, every tap stands in the level. The ratio is
 * never under two, so a sample close under the top takes one tap or two and
 * not four packed into its last meters.
 *
 * **A sample the cache calls dark takes no taps.** Where the cache is whole
 * and its depth at the sample is past `SUN_EARLY_OUT`, under a four
 * hundredth of the sun, the taps' loop runs no turn and the sample's sun is
 * the cache's there. Under a deck and inside one that is every sample, and
 * the taps were most of the trace. The loop's count carries it and no
 * branch stands about the taps: a branch there cost the rows that never
 * skip 0.23 ms a frame, more than the skips it bought them. **A 400 m cell
 * says nothing of a lit face inside it,** so a sample the cell calls dark
 * and a tap would have lit is drawn dark: under a 5° sun that is 0.4% to
 * 4% of first order's light by regime, and no more than 0.4% under a sun
 * 37.5° up (`cloudSunAccuracy.gpu.test.ts`, its early out's bill).
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
 * covers the whole path, or two to eight laid over the same reach. A tap
 * reads the field beside its step (`CloudSunDeps.tap`): the step's column,
 * and the profile and the noises at its own point. Statements: built inside
 * the march's `Fn`.
 */

/** The first tap's width, in optical depth of the denser of the sample's medium and its level's reference. */
export const LIGHT_TAP_DEPTH = 1
/** Meters toward the sun the taps reach at most. */
export const LIGHT_TAP_REACH = 500
/** The least one tap's end is of the last's: the taps are never finer than doubling. */
export const LIGHT_TAP_RATIO = 2
/**
 * The cached depth at a sample past which it takes no taps: the grid's own
 * knee (`SUN_GRID_KNEE`), under which a cell's read is the depth of the
 * mean transmittance to a half float, and past which the beam is under
 * e⁻⁶ of the sun.
 */
export const SUN_EARLY_OUT = 6
/** The least extinction a tap's width is formed from: a clear sample's first tap is the reach. */
const NO_EXTINCTION = 1e-9
/** The least the sun's cosine turns a column's depth by: the statistics' own floor. */
const SUN_MU_FLOOR = 0.05
/** The least the sun's cosine is taken as where a level's exit is found: past it the exit is beyond any reach. */
const EXIT_MU_FLOOR = 1e-3

export interface CloudSunDeps {
  readonly uniforms: CloudUniforms
  readonly medium: CloudMediumFn
  readonly depth: CloudSunDepthNodes
  /**
   * The medium at a tap, a point within the reach of the sample the march
   * last read: a field that holds its column over that reach reads only
   * what varies along it (`fieldMedia`). The whole medium when absent.
   */
  readonly tap?: CloudMediumFn
  /**
   * The cached depth past which a sample takes no taps, `SUN_EARLY_OUT`
   * when absent. An instrument's handle: past the deepest a cell holds,
   * 64, every sample takes its taps, which is the sun the early out is
   * billed against. A finite number: it is a constant of the program.
   */
  readonly earlyOut?: number
}

/**
 * What this sun answers beyond the contract, for the trace's counters: the
 * taps a sample read, and the taps its early out left unread.
 */
export interface CloudSunTaps extends CloudSun {
  readonly taken: Node<'float'>
  readonly skipped: Node<'float'>
}

export function cloudSunFn(
  deps: CloudSunDeps,
): (
  sample: CloudSample,
  medium: CloudMedium,
  body: CloudBodyUniforms,
) => CloudSunTaps {
  const taps = deps.uniforms.trace.lightTaps
  const tapMedium = deps.tap ?? deps.medium
  return (sample, medium, body) => {
    const fraction = float(0).toVar()
    const depth = float(0).toVar()
    const reach = float(0).toVar()
    const taken = float(0).toVar()
    /** A level's component of a per-level vector, by the sample's own level. */
    const ofLevel = (v: Node<'vec3'>): Node<'float'> =>
      select(
        medium.layer.equal(int(0)),
        v.x,
        select(medium.layer.equal(int(1)), v.y, v.z),
      )
    // The cache at the sample itself: where it is whole and calls the
    // sample dark, the loop below runs no turn.
    const here = deps.depth.depths(sample.offset)
    const dark = here.weight
      .greaterThanEqual(1)
      .and(here.toSun.greaterThan(deps.earlyOut ?? SUN_EARLY_OUT))
      .toVar()
    /** Meters along the sun the taps end at, the ratio of one tap's end to the last's, and the tap's far end. */
    const limit = float(0).toVar()
    const ratio = float(LIGHT_TAP_RATIO).toVar()
    const far = float(0).toVar()
    // Where the taps are laid, which a dark sample has no use for. Three
    // small branches stand about the laying, the loop and the read past
    // it, and none about the taps themselves.
    If(dark.not(), () => {
      // Spaced by the denser of the sample's own extinction and its
      // level's reference: at a cloud's ragged edge the sample's own falls
      // to nothing, and a depth of that is the whole reach in one tap.
      const first = float(LIGHT_TAP_DEPTH)
        .div(max(max(medium.sigma, ofLevel(body.layers.sigma)), NO_EXTINCTION))
        .toVar()
      // Where the sun's ray leaves the sample's level, meters along it: a
      // level's two heights and the sun's cosine, flat over half a
      // kilometer. A sample in no level, or in one with no thickness, has
      // no exit.
      const top = ofLevel(body.layers.top)
      const base = ofLevel(body.layers.base)
      const exit = select(
        sample.sunMu.greaterThanEqual(0),
        top.sub(sample.altitude),
        sample.altitude.sub(base),
      ).div(max(sample.sunMu.abs(), EXIT_MU_FLOOR))
      limit.assign(
        select(
          medium.layer.greaterThanEqual(int(0)).and(top.greaterThan(base)),
          max(min(float(LIGHT_TAP_REACH), exit), 0),
          float(LIGHT_TAP_REACH),
        ),
      )
      ratio.assign(
        max(
          pow(limit.div(first), float(1).div(max(float(taps).sub(1), 1))),
          LIGHT_TAP_RATIO,
        ),
      )
      far.assign(min(first, limit))
    })
    Loop(
      {
        start: int(0),
        end: select(dark, int(0), int(taps)),
        type: 'int',
        condition: '<',
      },
      () => {
        // Cut at the limit: a tap past it reads nothing and ends the taps.
        const span = min(far, limit).sub(reach)
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
        const tapped = tapMedium(at, body)
        fraction.assign(max(fraction, tapped.fraction))
        depth.addAssign(tapped.sigma.mul(span))
        reach.addAssign(span)
        taken.addAssign(1)
        far.mulAssign(ratio)
      },
    )
    // The cache where the taps end, which is the sample itself where none
    // was taken: there the read above is the read, and is not made again.
    // A read of the cache is as dear as a read of the field.
    const depths = deps.depth.depths(sample.offset.add(body.sun.mul(reach)))
    const cachedToSun = here.toSun.toVar()
    const cachedWeight = here.weight.toVar()
    If(reach.greaterThan(0), () => {
      const end = deps.depth.depths(sample.offset.add(body.sun.mul(reach)))
      cachedToSun.assign(end.toSun)
      cachedWeight.assign(end.weight)
    })
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
    const past = exp(cachedToSun.negate()).toVar()
    If(cachedWeight.lessThan(1), () => {
      past.assign(
        sunPastTaps({ toSun: cachedToSun, weight: cachedWeight }, statistics),
      )
    })
    const cloud: Node<'float'> = throughTaps(1).mul(past)
    // The sun's cosine the column's depths are turned along the ray by.
    const slant = float(1).div(max(sample.sunMu.abs(), SUN_MU_FLOOR))
    const above = sample.sunMu.greaterThanEqual(0)
    const column = medium.depth
    const columnToSun = select(above, column.x, column.y.sub(column.x))
    const columnBehind = select(above, column.y.sub(column.x), column.x)
    // The cache as the light after first order reads it: a depth to the
    // sun and the ray's whole. First order's transmittance, above, takes
    // the depth of the cell's mean transmittance, and today these two are
    // the same cell's, shallow as depths in broken cloud. A cache that
    // holds the depth itself beside the opacity answers here, and nothing
    // that reads `CloudSun.depth` changes.
    const deep = { toSun: depths.toSun, whole: depths.whole }
    const toSun = mix(
      columnToSun.mul(slant),
      depth.add(deep.toSun),
      depths.weight,
    )
    // The cache holds `behind` of what lies behind the point it is read at,
    // which is the taps' end: the taps' own stretch comes out of that, and
    // the statistics give the share the cache does not hold.
    const held = depths.weight.mul(depths.behind)
    const cached = depths.weight
      .mul(deep.whole.sub(deep.toSun))
      .sub(held.mul(depth))
    const behind = columnBehind
      .mul(slant)
      .mul(float(1).sub(held))
      .add(max(cached, 0))
    // The air's height, true meters: its top is in sea-level units.
    const airHeight = body.datumRadius.mul(max(body.air.top.sub(1), 1e-6))
    return {
      cloud,
      taken,
      skipped: select(dark, float(taps), float(0)),
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
