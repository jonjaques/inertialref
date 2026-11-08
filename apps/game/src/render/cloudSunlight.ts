import { exp, max } from 'three/tsl'
import { sunThroughAt } from './air.ts'
import type {
  CloudMediumFn,
  CloudSunDepthNodes,
  CloudSunFn,
} from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * The sun a cloud sample sees: a few taps of the medium over the first
 * kilometer toward the sun, mixed as one segment, then the sun-depth
 * candidate's optical depth beyond them, and the air's own beam at the
 * sample's height, cleared from orbit as the ground's is (§5.9).
 *
 * Neutral here: no taps, the candidate's depth past the reach, and the
 * air's real beam, so a kernel compiled against it binds the sun depth's
 * texture and the air's transmittance table as the real one will.
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
  return (sample, _medium, body) => {
    const beyond = sample.offset.add(body.sun.mul(LIGHT_TAP_REACH))
    // The air's height, true meters: its top is in sea-level units.
    const airHeight = body.datumRadius.mul(max(body.air.top.sub(1), 1e-6))
    return {
      cloud: exp(deps.depth.opticalDepth(beyond).negate()),
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
