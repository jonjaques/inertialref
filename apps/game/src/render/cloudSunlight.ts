import type { Node } from 'three/webgpu'
import { exp, float, If, length, max, select } from 'three/tsl'
import { sunThroughAt } from './air.ts'
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import type {
  CloudMediumFn,
  CloudSample,
  CloudSunDepthNodes,
  CloudSunFn,
} from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * The sun a cloud sample sees (§5.9): a few taps of the medium over the
 * first kilometer toward the sun, mixed as one segment, then the sun
 * grid's optical depth beyond them, and the air's own beam at the
 * sample's height, cleared from orbit as the ground's is.
 *
 * The taps are one segment because they are one column: mixed tap by tap,
 * each tap's (1 − c) would count the column's clear share again, and a
 * half-clear column at τ 20 crossed by two taps would pass a quarter of the
 * sun where it passes half (plan §3's example). Past them the grid answers
 * in optical depth alone — a grid cell is coarser than any column — so the
 * two multiply:
 * T = ((1 − c) + c·e^(−τ_taps))·e^(−τ_beyond).
 *
 * The tap set is the `lightTaps` lever, a uniform, so changing it rebuilds
 * nothing: two, four, or none, when the grid's depth is read at the sample
 * itself and covers the whole path. A tap is a sample of the same medium at
 * the view sample's footprint, its height from `altitudeAt` (rule 52), so
 * the field's reads are the march's own and bind nothing new. Statements: built inside the march's `Fn`.
 */

/** Tap midpoints and widths, meters, over the first kilometer toward the sun (§5.9). */
export const LIGHT_TAPS = {
  2: [
    [125, 250],
    [625, 750],
  ],
  4: [
    [50, 100],
    [200, 200],
    [450, 300],
    [800, 400],
  ],
} as const
export const LIGHT_TAP_REACH = 1000

export interface CloudSunDeps {
  readonly uniforms: CloudUniforms
  readonly medium: CloudMediumFn
  readonly depth: CloudSunDepthNodes
}

export function cloudSunFn(deps: CloudSunDeps): CloudSunFn {
  const taps = deps.uniforms.trace.lightTaps
  return (sample, _medium, body) => {
    const fraction = float(0).toVar()
    const depth = float(0).toVar()
    const tap = (midpoint: number, width: number): void => {
      const offset = sample.offset.add(body.sun.mul(midpoint))
      const at: CloudSample = {
        offset,
        distance: length(offset),
        altitude: altitudeAt(body, offset),
        sunMu: sunMuAt(body, offset),
        footprint: sample.footprint,
      }
      const medium = deps.medium(at, body)
      fraction.assign(max(fraction, medium.fraction))
      depth.addAssign(medium.sigma.mul(width))
    }
    If(taps.equal(2), () => {
      for (const [midpoint, width] of LIGHT_TAPS[2]) tap(midpoint, width)
    }).ElseIf(taps.equal(4), () => {
      for (const [midpoint, width] of LIGHT_TAPS[4]) tap(midpoint, width)
    })
    const throughTaps = float(1)
      .sub(fraction)
      .add(fraction.mul(exp(depth.negate())))
    const reach = select(taps.greaterThan(0), float(LIGHT_TAP_REACH), float(0))
    const beyond = deps.depth.opticalDepth(
      sample.offset.add(body.sun.mul(reach)),
    )
    // The air's height, true meters: its top is in sea-level units.
    const airHeight = body.datumRadius.mul(max(body.air.top.sub(1), 1e-6))
    const cloud: Node<'float'> = throughTaps.mul(exp(beyond.negate()))
    return {
      cloud,
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
