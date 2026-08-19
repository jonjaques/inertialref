import type { Meters, Radians, Seconds } from '@inertialref/shared'
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
import { formatAddress, type SystemId, type UniverseAddress } from './address.ts'
import type { Body, StarSystem } from './system.ts'

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

export const systemFrameId = (system: SystemId): FrameId => frameId(`s:${system}`)
export const bodyFrameId = (address: UniverseAddress): FrameId =>
  frameId(`b:${formatAddress(address)}`)
export const bodyFixedFrameId = (address: UniverseAddress): FrameId =>
  frameId(`bf:${formatAddress(address)}`)
export const surfaceFrameId = (
  address: UniverseAddress,
  latitude: Radians,
  longitude: Radians,
): FrameId =>
  frameId(`sf:${formatAddress(address)}@${latitude.toFixed(6)},${longitude.toFixed(6)}`)

/** Orbit evaluator for a body about a primary with gravitational parameter `mu`. */
function orbitEvaluator(body: Body, primaryMu: number): (t: Seconds) => LocalPose {
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
export function installSystemFrames(graph: FrameGraph, system: StarSystem): void {
  const systemFrame = systemFrameId(system.id)
  if (!graph.has(systemFrame)) {
    graph.define({
      id: systemFrame,
      parent: ROOT_FRAME,
      kind: 'system',
      anchor: { kind: 'fixed', position: system.position, orientation: Q.IDENTITY },
    })
  }

  const installBody = (body: Body, parentFrame: FrameId, primaryMu: number): void => {
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

  for (const planet of system.planets) installBody(planet, systemFrame, system.star.mu)
}

export function uninstallSystemFrames(graph: FrameGraph, system: StarSystem): void {
  const removeBody = (body: Body): void => {
    for (const moon of body.moons) removeBody(moon)
    if (graph.has(bodyFixedFrameId(body.address))) graph.remove(bodyFixedFrameId(body.address))
    if (graph.has(bodyFrameId(body.address))) graph.remove(bodyFrameId(body.address))
  }
  for (const planet of system.planets) removeBody(planet)
  const systemFrame = systemFrameId(system.id)
  if (graph.has(systemFrame)) graph.remove(systemFrame)
}

/** Unit vector at a latitude/longitude in body-fixed axes (+Y is the pole). */
export function geodeticDirection(latitude: Radians, longitude: Radians) {
  const cosLat = Math.cos(latitude)
  return vec3(cosLat * Math.cos(longitude), Math.sin(latitude), -cosLat * Math.sin(longitude))
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
  latitude: Radians,
  longitude: Radians,
  elevation: Meters = 0,
): FrameId {
  const id = surfaceFrameId(body.address, latitude, longitude)
  if (graph.has(id)) return id

  const up = geodeticDirection(latitude, longitude)
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
