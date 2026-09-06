import { LineBasicNodeMaterial } from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { integratedSkyGain, sensorRadiance } from './radiance.ts'

/*
 * The drop aid's ink.
 *
 * Three materials rather than one, because the aid makes three claims and only
 * one of them is about a place the camera can reach. They share the orbit
 * trace's argument in full — a mark drawn *over* the picture rather than lit
 * *in* it, so it carries the sensor's own inverse (`integratedSkyGain`) and
 * comes out of the response at the color written here at every exposure the
 * lens can reach. `render/orbitTrace.ts` has the whole reasoning; what differs
 * is stated below.
 */

/*
 * These sit well above 1, and that is the point rather than an oversight.
 *
 * Every line here is one device pixel wide — `LineBasicNodeMaterial` has no
 * width under WebGPU — so the only lever a mark has against a sunlit disk is
 * its radiance. An orbit trace is context and is allowed to sit quietly under
 * the picture at 0.32 alpha; this is a live answer to a gesture the hand is
 * making, drawn for the few seconds it is being made, and it has to be found
 * instantly against cloud, ocean and terminator alike. Measured against
 * Earth's day side at the flight lens, unity read as a hairline that
 * disappeared over cloud.
 */

/** The fall itself, and the brightest thing the aid draws. */
const FALL_COLOR = { r: 0.9, g: 2.1, b: 2.8 }

/** The part under the ground: a diagram, and never mistaken for the path. */
const THROUGH_COLOR = { r: 0.5, g: 0.95, b: 1.4 }

/** Where the camera lands. The one mark that is a promise. */
const RING_COLOR = { r: 1.6, g: 2.5, b: 3.0 }

/** The figure in the viewer's hand. The mark the pointer is inside. */
const HOLD_COLOR = { r: 1.4, g: 2.3, b: 2.9 }

function trace(
  color: { r: number; g: number; b: number },
  opacity: number,
  depthTest: boolean,
): LineBasicNodeMaterial {
  const line = sensorRadiance(new LineBasicNodeMaterial())
  line.colorNode = vec3(color.r, color.g, color.b).mul(integratedSkyGain)
  line.transparent = true
  line.opacity = opacity
  line.depthWrite = false
  line.depthTest = depthTest
  return line
}

/**
 * The three inks.
 *
 * **The fall and the ring are depth-tested and the continuation is not**, and
 * that difference is the drawing's whole grammar. The fall and the ring are
 * claims about somewhere the camera is going, so a limb passing in front of
 * them has to hide them or the aid is lying about which side of the world it
 * is on. The continuation is the opposite claim — it is *inside* the body by
 * construction, and depth-testing it would draw nothing at all — so it is an
 * x-ray, drawn faint enough that nobody reads it as a path.
 */
export function createEntryTraceMaterials(): {
  readonly fall: LineBasicNodeMaterial
  readonly through: LineBasicNodeMaterial
  readonly ring: LineBasicNodeMaterial
  readonly hold: LineBasicNodeMaterial
} {
  return {
    fall: trace(FALL_COLOR, 1, true),
    through: trace(THROUGH_COLOR, 0.42, false),
    ring: trace(RING_COLOR, 1, true),
    /*
     * The one mark that is never occluded. It is where the viewer's own hand
     * is, so a limb passing in front of it would be the interface hiding the
     * cursor — and unlike the fall and the ring it makes no claim about which
     * side of the world it is on.
     */
    hold: trace(HOLD_COLOR, 1, false),
  }
}
