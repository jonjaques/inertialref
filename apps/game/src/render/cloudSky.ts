import { vec3 } from 'three/tsl'
import type { CloudSkyNodes } from './cloudNodes.ts'

/*
 * The sky's light on a cloud sample: the sky table's node. The table is a
 * body's own, bound beside its air's two (`AirUniforms.sky`), so the node
 * reads it through the body it is handed and one node set serves the served
 * body and a second.
 *
 * **It reads no table and draws no sky.** The mean and both differences are
 * zero at every sample, so a graph built on it binds nothing.
 */

export function createCloudSky(): CloudSkyNodes {
  return {
    at: () => ({ mean: vec3(0), up: vec3(0), sunward: vec3(0) }),
  }
}
