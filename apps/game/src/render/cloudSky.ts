import { max, saturate } from 'three/tsl'
import { skyTableAt } from './air.ts'
import type { CloudSkyNodes } from './cloudNodes.ts'

/*
 * The sky's light on a cloud sample: the sky table's node (design §5.6).
 * The table is a body's own, bound beside its air's two (`AirUniforms.sky`),
 * so the node reads it through the body it is handed and one node set
 * serves the served body and a second.
 *
 * It is one read of each of the table's three blocks a call, at the
 * sample's sun cosine and its height as a share of the air's: the
 * coordinates the march's air sample reads the transmittance and Ψ at
 * (`sampleAir` in `cloudMarch.ts`), so the cloud's sky and the air around
 * it are read at one point. The three vary over kilometers of height, so
 * the march takes one a segment, not one a step.
 *
 * A body whose table has not arrived reads its stand-in, which holds no sky:
 * L̄ at `MULTI_SCATTER_FLOOR` and no difference between any two sides.
 */

export function createCloudSky(): CloudSkyNodes {
  return {
    at(sample, body) {
      const height = max(sample.altitude, 0).div(body.datumRadius)
      const height01 = saturate(height.div(max(body.air.top.sub(1), 1e-6)))
      return skyTableAt(body.air, sample.sunMu, height01)
    },
  }
}
