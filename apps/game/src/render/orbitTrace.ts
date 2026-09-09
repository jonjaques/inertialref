import { LineBasicNodeMaterial } from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { integratedSkyGain, sensorRadiance } from './radiance.ts'

/*
 * An orbit trace is context drawn over the picture, not light in it.
 *
 * Left at unit gain a trace sits 53× below its neighbors under Direct and
 * follows the meter under Neutral, so it vanishes exactly when the picture
 * is exposed for a body — which is why it went through the scene's
 * pre-exposure with everything else. The other end of that range is the
 * galaxy instrument: at f/2, 2,400 s, ISO 400 a pre-exposed trace is tens
 * of thousands of times over white, and the interior plate at Earth orbit
 * was three blooming white bands with the sky somewhere behind them.
 *
 * So the trace carries the sensor's own inverse — `integratedSkyGain`, the
 * gain the naked-eye star sprites already present through — and comes out of
 * the response at the color written here at every exposure the lens can
 * reach. It still draws inside the scene pass, depth-tested against the
 * bodies and blended over the sky, which a pass after the response could
 * not be.
 *
 * The sensor's instrument mask excludes covered pixels from metering.
 */

/** The trace's color on screen, at every exposure. */
const TRACE_COLOR = { r: 0.35, g: 0.62, b: 0.85 }

export function createOrbitTraceMaterial(): LineBasicNodeMaterial {
  const line = sensorRadiance(new LineBasicNodeMaterial(), true, true)
  line.colorNode = vec3(TRACE_COLOR.r, TRACE_COLOR.g, TRACE_COLOR.b).mul(
    integratedSkyGain,
  )
  line.transparent = true
  // Additive would bloom into a bright wash where the inner planets' orbits
  // overlap; a low-alpha normal blend keeps ten traces readable as ten.
  line.opacity = 0.32
  line.depthWrite = false
  return line
}
