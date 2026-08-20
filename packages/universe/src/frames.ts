import type { Radians, Seconds } from '@inertialref/shared'
import { stateVectorAt } from '@inertialref/physics'
import {
  type FrameGraph,
  type FrameId,
  frameId,
  type LocalPose,
  Quaternion as Q,
  ROOT_FRAME,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  formatAddress,
  parseAddress,
  type SystemId,
  type UniverseAddress,
} from './address.ts'
import type { Body, StarSystem } from './system.ts'
import { type BodyFixedDirection, surfaceRadius } from './terrain.ts'

/*
 * Where the universe meets the spatial package.
 *
 * Frames are installed as *definitions with evaluators*, not as pre-computed
 * poses: an orbital frame is a closure over Kepler elements, so asking where a
 * planet is at tick 10^9 costs one Kepler solve rather than 10^9 integration
 * steps. The spatial package never learns what an orbit is.
 *
 * Three frames exist per body, and the distinction matters:
 *
 *   b:…   body-centred *inertial* — translates along the orbit, does not spin.
 *         Satellites and approaching ships live here.
 *   bf:…  body-*fixed* — spins with the body. Anything bolted to the surface.
 *   sf:…  surface — a local tangent frame at one latitude/longitude, +Y up.
 *         This is where meter-scale gameplay happens.
 */

export const systemFrameId = (system: SystemId): FrameId =>
  frameId(`s:${system}`)
export const bodyFrameId = (address: UniverseAddress): FrameId =>
  frameId(`b:${formatAddress(address)}`)
export const bodyFixedFrameId = (address: UniverseAddress): FrameId =>
  frameId(`bf:${formatAddress(address)}`)
/**
 * Angles in a frame id are formatted through this, not through `toFixed`
 * directly.
 *
 * `(-1e-9).toFixed(6)` is "-0.000000" but `Number.parseFloat` of that is `-0`,
 * whose `toFixed(6)` is "0.000000" — so an id built at a latitude a hair south
 * of the equator did not survive being parsed and rebuilt, and a save with a
 * ship landed there failed to restore. Collapsing the sub-precision band to
 * zero makes the text form idempotent.
 */
const ANGLE_PRECISION = 1e-6

/**
 * Snap an angle to the precision the id records.
 *
 * The frame's *geometry* is built from the quantised value too, not just its
 * name. Otherwise the id does not fully determine the frame: a landing site
 * rebuilt from a save landed half a metre from where it was written, because
 * the original frame had used the unrounded latitude the id had thrown away.
 */
export const quantizeAngle = (radians: Radians): Radians =>
  Math.round(radians / ANGLE_PRECISION) * ANGLE_PRECISION

const formatAngle = (radians: Radians): string => {
  const snapped = quantizeAngle(radians)
  // `(-0).toFixed(6)` is "0.000000" while `(-1e-9).toFixed(6)` is "-0.000000",
  // so without collapsing the sign the text form is not idempotent.
  return (Object.is(snapped, -0) ? 0 : snapped).toFixed(6)
}

export const surfaceFrameId = (
  address: UniverseAddress,
  latitude: Radians,
  longitude: Radians,
): FrameId =>
  frameId(
    `sf:${formatAddress(address)}@${formatAngle(latitude)},${formatAngle(longitude)}`,
  )

/**
 * Read a surface frame id back into the three things that determine it.
 *
 * Lives beside `surfaceFrameId` because the grammar has exactly one owner and
 * the round trip is a property worth testing in one place. It was previously
 * open-coded in `World.ensureFrame` with `lastIndexOf('@')` and a `split(',')`,
 * one package down — on the load path for every save with a landed ship, and
 * with no counterpart to the `-0` collapse that `formatAngle` exists to provide.
 *
 * Returns null for anything that is not a surface frame id.
 */
export function parseSurfaceFrameId(id: FrameId): {
  address: Extract<UniverseAddress, { kind: 'body' }>
  latitude: Radians
  longitude: Radians
} | null {
  if (!id.startsWith('sf:')) return null
  const at = id.lastIndexOf('@')
  if (at < 0) return null

  const address = parseAddress(id.slice(3, at))
  if (address.kind !== 'body') return null

  const parts = id.slice(at + 1).split(',')
  if (parts.length !== 2) return null
  const latitude = Number.parseFloat(parts[0] as string)
  const longitude = Number.parseFloat(parts[1] as string)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  // Quantised on the way out as well as in. `formatAngle` collapses a
  // sub-precision negative to +0, so parsing has to land on the same value the
  // formatter would produce or the round trip is not a round trip.
  return {
    address,
    latitude: quantizeAngle(latitude as Radians),
    longitude: quantizeAngle(longitude as Radians),
  }
}

/** Orbit evaluator for a body about a primary with gravitational parameter `mu`. */
function orbitEvaluator(
  body: Body,
  primaryMu: number,
): (t: Seconds) => LocalPose {
  return (t) => {
    const { position, velocity } = stateVectorAt(body.elements, primaryMu, t)
    return {
      position,
      orientation: Q.IDENTITY,
      velocity,
      angularVelocity: Vec.ZERO,
    }
  }
}

/**
 * Spin evaluator: axial tilt about +X, then rotation about the body's own pole.
 *
 * A negative rotation period means retrograde, which falls out of the sign of
 * the angle rather than needing a flag.
 */
function spinEvaluator(body: Body): (t: Seconds) => LocalPose {
  const tilt = Q.fromAxisAngle(vec3(1, 0, 0), body.axialTilt)
  const rate = (2 * Math.PI) / body.rotationPeriod
  return (t) => ({
    position: Vec.ZERO,
    orientation: Q.multiply(tilt, Q.fromAxisAngle(vec3(0, 1, 0), rate * t)),
    velocity: Vec.ZERO,
    angularVelocity: Q.rotate(tilt, vec3(0, rate, 0)),
  })
}

/**
 * Install a whole system's frames.
 *
 * Cheap — it defines closures, it does not evaluate them — so a system can be
 * installed on approach and removed when it leaves the interest set without
 * any generation work happening at the boundary.
 */
export function installSystemFrames(
  graph: FrameGraph,
  system: StarSystem,
): void {
  const systemFrame = systemFrameId(system.id)
  if (!graph.has(systemFrame)) {
    graph.define({
      id: systemFrame,
      parent: ROOT_FRAME,
      kind: 'system',
      anchor: {
        kind: 'fixed',
        position: system.position,
        orientation: Q.IDENTITY,
      },
    })
  }

  const installBody = (
    body: Body,
    parentFrame: FrameId,
    primaryMu: number,
  ): void => {
    const frame = bodyFrameId(body.address)
    if (!graph.has(frame)) {
      graph.define({
        id: frame,
        parent: parentFrame,
        kind: 'body',
        anchor: { kind: 'dynamic', evaluate: orbitEvaluator(body, primaryMu) },
      })
      graph.define({
        id: bodyFixedFrameId(body.address),
        parent: frame,
        kind: 'body',
        anchor: { kind: 'dynamic', evaluate: spinEvaluator(body) },
      })
    }
    for (const moon of body.moons) installBody(moon, frame, body.mu)
  }

  for (const planet of system.planets)
    installBody(planet, systemFrame, system.star.mu)
}

export function uninstallSystemFrames(
  graph: FrameGraph,
  system: StarSystem,
): void {
  const removeBody = (body: Body): void => {
    for (const moon of body.moons) removeBody(moon)
    if (graph.has(bodyFixedFrameId(body.address)))
      graph.remove(bodyFixedFrameId(body.address))
    if (graph.has(bodyFrameId(body.address)))
      graph.remove(bodyFrameId(body.address))
  }
  for (const planet of system.planets) removeBody(planet)
  const systemFrame = systemFrameId(system.id)
  if (graph.has(systemFrame)) graph.remove(systemFrame)
}

/** Unit vector at a latitude/longitude in body-fixed axes (+Y is the pole). */
export function geodeticDirection(
  latitude: Radians,
  longitude: Radians,
): BodyFixedDirection {
  const cosLat = Math.cos(latitude)
  // Body-fixed by construction: a surface frame's parent is the `bf:` frame, so
  // lat/long here already mean "on the turning body".
  return vec3(
    cosLat * Math.cos(longitude),
    Math.sin(latitude),
    -cosLat * Math.sin(longitude),
  ) as BodyFixedDirection
}

/** Latitude/longitude of a direction in body-fixed axes. */
export function directionToGeodetic(direction: {
  x: number
  y: number
  z: number
}): { latitude: Radians; longitude: Radians } {
  const length = Math.hypot(direction.x, direction.y, direction.z)
  if (length === 0) return { latitude: 0, longitude: 0 }
  return {
    latitude: Math.asin(Math.min(1, Math.max(-1, direction.y / length))),
    longitude: Math.atan2(-direction.z, direction.x),
  }
}

/**
 * Install a local tangent frame on a body's surface.
 *
 * Axes are east / up / south — right-handed with +Y up, matching the rest of
 * the simulation, so "up" in a landing HUD is the same +Y the renderer uses and
 * nothing has to be flipped at the boundary.
 */
export function installSurfaceFrame(
  graph: FrameGraph,
  body: Body,
  requestedLatitude: Radians,
  requestedLongitude: Radians,
): FrameId {
  const latitude = quantizeAngle(requestedLatitude)
  const longitude = quantizeAngle(requestedLongitude)
  const id = surfaceFrameId(body.address, latitude, longitude)
  if (graph.has(id)) return id

  const up = geodeticDirection(latitude, longitude)
  // Elevation is derived here rather than passed in, for the same reason the
  // angles are quantised here: the id has to determine the frame completely.
  // A caller-supplied elevation sampled at the unrounded position put a
  // restored landing site 21 mm from the original.
  const elevation = surfaceRadius(body, up) - body.radius
  const east = Vec.normalize(vec3(-up.z, 0, up.x))
  // Degenerate at the poles, where "east" is undefined; fall back to +X.
  const eastSafe = Vec.lengthSquared(east) === 0 ? vec3(1, 0, 0) : east
  const south = Vec.cross(eastSafe, up)
  const orientation = Q.fromBasis(eastSafe, up, south)
  const position = Vec.scale(up, body.radius + elevation)

  graph.define({
    id,
    parent: bodyFixedFrameId(body.address),
    kind: 'surface',
    anchor: {
      kind: 'dynamic',
      // Static within the rotating body-fixed frame: the frame composition
      // supplies the 465 m/s of tangential velocity, nothing integrates it.
      evaluate: () => ({
        position,
        orientation,
        velocity: Vec.ZERO,
        angularVelocity: Vec.ZERO,
      }),
    },
  })
  return id
}
