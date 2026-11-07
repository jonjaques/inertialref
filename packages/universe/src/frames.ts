import {
  GRAVITATIONAL_CONSTANT,
  invariant,
  type Radians,
  type Seconds,
} from '@inertialref/shared'
import { type OrbitalElements, stateVectorAt } from '@inertialref/physics'
import {
  type FrameGraph,
  type FrameId,
  frameId,
  type LocalPose,
  type Quat,
  Quaternion as Q,
  ROOT_FRAME,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  type EntityId,
  entityIdForAddress,
  formatAddress,
  isSystemId,
  parseAddress,
  type SystemId,
  type UniverseAddress,
} from './address.ts'
import type { OrbitalPlacement } from './stations.ts'
import { type Body, findBody, type StarSystem } from './system.ts'
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
 *   b:…   body-centered *inertial* — translates along the orbit, does not spin.
 *         Satellites and approaching ships live here.
 *   bf:…  body-*fixed* — spins with the body. Anything bolted to the surface.
 *   sf:…  surface — a local tangent frame at one latitude/longitude, +Y up.
 *         This is where meter-scale gameplay happens.
 *
 * And two per orbital placement, named by its identity alone:
 *
 *   a:…   centered on the station, in its parent's equatorial axes — the
 *         moon's orbit evaluator, translating and not turning.
 *   af:…  the station's own axes, turning with its attitude. What a pad, a
 *         docking port and a contact test hang off.
 */

export const systemFrameId = (system: SystemId): FrameId =>
  frameId(`s:${system}`)

/**
 * Read a system frame id back, or null for any other kind of frame.
 *
 * The inverse belongs beside the constructor because the grammar has exactly
 * one owner. Its absence was a live trap (ADR-0008): the debug overlay derived
 * an entity's authority partition by scanning the frame chain for an `s:`
 * prefix itself, which agreed with `partitionForAddress` only because the frame
 * grammar and the partition-key grammar happen to spell a system the same way.
 * Renaming either one would have made the overlay and the router disagree about
 * which authority owns a ship — and the overlay is the tool you would reach for
 * to diagnose that.
 */
export function systemOfFrameId(id: FrameId): SystemId | null {
  if (!id.startsWith('s:')) return null
  const rest = id.slice(2)
  return isSystemId(rest) ? rest : null
}
/*
 * Both memoized on the address object, for the reason `formatAddress` is.
 *
 * These are the other two strings `snapshot()` builds per body per frame, and
 * a body's frame ids are as immutable as its address — `frameId` is a cast, so
 * what is actually being cached is the concatenation. A `WeakMap` keyed by the
 * address keeps a region address, which is built fresh per call, from
 * accumulating.
 */
const bodyFrames = new WeakMap<UniverseAddress, FrameId>()
const bodyFixedFrames = new WeakMap<UniverseAddress, FrameId>()

export const bodyFrameId = (address: UniverseAddress): FrameId => {
  const hit = bodyFrames.get(address)
  if (hit !== undefined) return hit
  const id = frameId(`b:${formatAddress(address)}`)
  bodyFrames.set(address, id)
  return id
}
/**
 * Read a body-centered frame id back to its address, or null for any other
 * kind of frame. The inverse of `bodyFrameId`, beside it for the reason
 * `systemOfFrameId` is beside its constructor.
 */
export function bodyOfFrameId(
  id: FrameId,
): Extract<UniverseAddress, { kind: 'body' }> | null {
  if (!id.startsWith('b:')) return null
  const address = parseAddress(id.slice(2))
  return address.kind === 'body' ? address : null
}
export const bodyFixedFrameId = (address: UniverseAddress): FrameId => {
  const hit = bodyFixedFrames.get(address)
  if (hit !== undefined) return hit
  const id = frameId(`bf:${formatAddress(address)}`)
  bodyFixedFrames.set(address, id)
  return id
}
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
 * The frame's *geometry* is built from the quantized value too, not just its
 * name. Otherwise the id does not fully determine the frame: a landing site
 * rebuilt from a save landed half a meter from where it was written, because
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

  // Quantized on the way out as well as in. `formatAngle` collapses a
  // sub-precision negative to +0, so parsing has to land on the same value the
  // formatter would produce or the round trip is not a round trip.
  return {
    address,
    latitude: quantizeAngle(latitude as Radians),
    longitude: quantizeAngle(longitude as Radians),
  }
}

/**
 * A station's own frames, named by its identity and nothing else.
 *
 * The identity is the placement's id — `@<address>` for a derived station —
 * so one formatter serves every source a placement can come from, and a ship
 * saved or replicated "in `af:<id>`" names a frame any client can rebuild
 * from the string. A frame id that carried the orbit, or the parent, would
 * describe a frame the id does not determine.
 */
export const stationFrameId = (station: EntityId): FrameId =>
  frameId(`a:${station}`)
export const stationFixedFrameId = (station: EntityId): FrameId =>
  frameId(`af:${station}`)

/**
 * Read a station frame id back to the station it names, or null for any
 * other frame.
 *
 * Beside the formatters for the reason `parseSurfaceFrameId` is beside its
 * own. Only a derived station's id parses today — `@` and a satellite
 * address — because that is the only kind there is; a minted id joins it with
 * the first built station.
 */
export function parseStationFrameId(id: FrameId): {
  readonly station: EntityId
  readonly address: Extract<UniverseAddress, { kind: 'satellite' }>
  readonly fixed: boolean
} | null {
  const fixed = id.startsWith('af:')
  if (!fixed && !id.startsWith('a:')) return null
  const station = id.slice(fixed ? 3 : 2) as EntityId
  if (!station.startsWith('@')) return null
  let address: UniverseAddress
  try {
    address = parseAddress(station.slice(1))
  } catch {
    return null
  }
  // One spelling per frame: a second text for the same address would name a
  // second frame the graph has never heard of.
  return address.kind === 'satellite' && entityIdForAddress(address) === station
    ? { station, address, fixed }
    : null
}

/**
 * Orbit evaluator for a body about a primary with gravitational parameter `mu`.
 *
 * `mu` is `G(M + m)`, not `G·M`, and callers pass it that way. The relative
 * position vector in the two-body problem obeys `r̈ = −G(M+m)·r/|r|³` — both
 * bodies orbit their barycenter, and the frame graph measures from the primary's
 * center. Dropping the secondary's mass is a fine approximation for a planet
 * around a star and a measurable error for a large moon: the Moon is 1.2% of
 * Earth, and ignoring it puts its sidereal period at 27.45 days against a
 * published 27.3217.
 *
 * `planeTilt` is the *parent's* axial tilt. A moon's elements are measured
 * from its planet's equator (`solar/bodies.ts` documents them that way), but
 * this frame's parent is the planet's untilted orbital frame — so the equator
 * has to be erected here, with the same tilt-about-+X convention the spin
 * evaluator uses or the two planes disagree. Evaluating the elements directly
 * in the parent frame put Titan ~27° out of the ring plane it belongs to and
 * flattened Uranus's near-polar satellite system onto the ecliptic.
 */
function orbitEvaluator(
  elements: OrbitalElements,
  primaryMu: number,
  planeTilt: Radians,
): (t: Seconds) => LocalPose {
  if (planeTilt === 0) {
    return (t) => {
      const { position, velocity } = stateVectorAt(elements, primaryMu, t)
      return {
        position,
        orientation: Q.IDENTITY,
        velocity,
        angularVelocity: Vec.ZERO,
      }
    }
  }
  const tilt = Q.fromAxisAngle(vec3(1, 0, 0), planeTilt)
  return (t) => {
    const { position, velocity } = stateVectorAt(elements, primaryMu, t)
    return {
      position: Q.rotate(tilt, position),
      // The frame's axes are the parent's equatorial ones, so a satellite's
      // zero-tilt spin axis is the equator normal rather than the system's +Y
      // — which is what keeps a tidally locked moon's pole on its own orbit
      // normal.
      orientation: tilt,
      velocity: Q.rotate(tilt, velocity),
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
 * Attitude evaluator for local vertical, local horizontal: the `af:` frame
 * within its `a:` frame.
 *
 * `stateVectorAt`'s position and velocity are already in the `a:` frame's
 * axes — the parent's equatorial ones, which the orbit evaluator erects with
 * its tilt and applies to the frame's position alone — so the basis is built
 * from them as they come: zenith along `r`, starboard against the orbit
 * normal `r × v`, and back against the transverse direction rather than
 * against `v`, which leans off the horizontal by up to the eccentricity in
 * radians and would leave the three not quite orthogonal.
 *
 * The turn is `(r × v) / |r|²`, the rate the radius vector sweeps at: exactly
 * what keeps the keel on the parent's center through an eccentric orbit, and
 * the orbital rate on a circular one.
 */
function nadirEvaluator(
  elements: OrbitalElements,
  mu: number,
): (t: Seconds) => LocalPose {
  return (t) => {
    const { position: r, velocity: v } = stateVectorAt(elements, mu, t)
    const momentum = Vec.cross(r, v)
    const up = Vec.normalize(r)
    const normal = Vec.normalize(momentum)
    return {
      position: Vec.ZERO,
      orientation: Q.fromBasis(
        Vec.negate(normal),
        up,
        Vec.negate(Vec.cross(normal, up)),
      ),
      velocity: Vec.ZERO,
      angularVelocity: Vec.scale(momentum, 1 / Vec.dot(r, r)),
    }
  }
}

/** The pose law for a placement's attitude. Exhaustive over `Attitude`. */
function attitudeEvaluator(
  placement: OrbitalPlacement,
  mu: number,
): (t: Seconds) => LocalPose {
  switch (placement.attitude.kind) {
    case 'nadir':
      return nadirEvaluator(placement.orbit.elements, mu)
  }
}

/** The body a placement goes round, or undefined when it goes round the star. */
function placementParent(
  system: StarSystem,
  placement: OrbitalPlacement,
): Body | undefined {
  if (placement.parent.kind !== 'body') return undefined
  const parent = findBody(system, placement.parent.body)
  invariant(
    parent !== undefined,
    `${placement.name} goes round nothing in ${system.name}`,
  )
  return parent
}

/**
 * `G(M + m)` of a placement and what it goes round: the parameter its frame
 * is run on, as a moon's is. The period a page quotes and the trace a
 * planetarium draws read it here, so neither can disagree with where the
 * frame puts the station.
 */
export function placementMu(
  system: StarSystem,
  placement: OrbitalPlacement,
): number {
  const parent = placementParent(system, placement)
  return (
    (parent?.mu ?? system.star.mu) + GRAVITATIONAL_CONSTANT * placement.mass
  )
}

/**
 * Install a station's two frames under its parent's, which must already be
 * installed.
 *
 * The parent's axial tilt erects the equator its elements are measured from.
 * A station going round the star takes the system frame and no tilt, as a
 * planet does.
 */
function installStation(
  graph: FrameGraph,
  system: StarSystem,
  placement: OrbitalPlacement,
): void {
  const frame = stationFrameId(placement.id)
  if (graph.has(frame)) return
  const parent = placementParent(system, placement)
  const mu = placementMu(system, placement)
  graph.define({
    id: frame,
    parent:
      parent === undefined
        ? systemFrameId(system.id)
        : bodyFrameId(parent.address),
    kind: 'orbit',
    anchor: {
      kind: 'dynamic',
      evaluate: orbitEvaluator(
        placement.orbit.elements,
        mu,
        parent?.axialTilt ?? 0,
      ),
    },
  })
  graph.define({
    id: stationFixedFrameId(placement.id),
    parent: frame,
    kind: 'orbit',
    anchor: { kind: 'dynamic', evaluate: attitudeEvaluator(placement, mu) },
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
    planeTilt: Radians,
  ): void => {
    const frame = bodyFrameId(body.address)
    if (!graph.has(frame)) {
      graph.define({
        id: frame,
        parent: parentFrame,
        kind: 'body',
        anchor: {
          kind: 'dynamic',
          evaluate: orbitEvaluator(
            body.elements,
            primaryMu + body.mu,
            planeTilt,
          ),
        },
      })
      graph.define({
        id: bodyFixedFrameId(body.address),
        parent: frame,
        kind: 'body',
        anchor: { kind: 'dynamic', evaluate: spinEvaluator(body) },
      })
    }
    // Moons orbit in the parent's equatorial plane; planets orbit in the
    // system plane their elements are already measured from.
    for (const moon of body.moons)
      installBody(moon, frame, body.mu, body.axialTilt)
  }

  for (const planet of system.planets)
    installBody(planet, systemFrame, system.star.mu, 0)
  // After every body, because each hangs off its parent's frame.
  for (const station of system.stations) installStation(graph, system, station)
}

export function uninstallSystemFrames(
  graph: FrameGraph,
  system: StarSystem,
): void {
  // Stations first: `FrameGraph.remove` refuses a frame that still has
  // children, and a station's frames are children of a body's.
  for (const station of system.stations) {
    for (const frame of [
      stationFixedFrameId(station.id),
      stationFrameId(station.id),
    ])
      if (graph.has(frame)) graph.remove(frame)
  }
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

/** East, north and up at a surface point, and a heading turned about up. */
export interface CompassBasis {
  readonly up: BodyFixedDirection
  /** The direction `geodeticDirection`'s longitude increases along. */
  readonly east: Vec3
  /** The direction its latitude increases along. */
  readonly north: Vec3
  /**
   * Local axes into body-fixed ones: +X right, +Y up, −Z forward, with forward
   * at the heading — north at 0, swinging toward east.
   */
  readonly orientation: Quat
}

/**
 * The one answer to "which way is east" at a surface point.
 *
 * Every surface basis reads this: the surface frame, a placement, a walker's
 * spawn. Taken from the angles rather than from `up`, so it is defined at the
 * poles too: east there is the direction the given meridian's longitude would
 * increase along, where `cross(+Y, up)` has no length and any fallback is a
 * guess. Closed forms throughout, so the triad is orthonormal to rounding and
 * owes nothing to a normalization.
 */
export function compassBasis(
  latitude: Radians,
  longitude: Radians,
  heading: Radians,
): CompassBasis {
  const up = geodeticDirection(latitude, longitude)
  const sinLat = Math.sin(latitude)
  const cosLat = Math.cos(latitude)
  const sinLon = Math.sin(longitude)
  const cosLon = Math.cos(longitude)
  const east = vec3(-sinLon, 0, -cosLon)
  const north = vec3(-sinLat * cosLon, cosLat, sinLat * sinLon)
  const sin = Math.sin(heading)
  const cos = Math.cos(heading)
  const right = Vec.sub(Vec.scale(east, cos), Vec.scale(north, sin))
  const back = Vec.negate(Vec.add(Vec.scale(north, cos), Vec.scale(east, sin)))
  return { up, east, north, orientation: Q.fromBasis(right, up, back) }
}

/**
 * Install a local tangent frame on a body's surface.
 *
 * Axes are `compassBasis` at heading 0 — +X east, +Y up, −Z north — the same
 * axes a placement and a walker are built in, so a ship at `Q.IDENTITY` here
 * faces the way a pad at heading 0 does. Landed orientations are stored in
 * this frame and saved, so the axes are part of what a save means: the schema
 * version names them.
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

  const { up, orientation } = compassBasis(latitude, longitude, 0)
  // Elevation is derived here rather than passed in, for the same reason the
  // angles are quantized here: the id has to determine the frame completely.
  // A caller-supplied elevation sampled at the unrounded position put a
  // restored landing site 21 mm from the original.
  const elevation = surfaceRadius(body, up) - body.radius
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
