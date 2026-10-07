import {
  AU,
  deg,
  type Degrees,
  degreesToRadians,
  getLogger,
  radiansToDegrees,
  type Radians,
} from '@inertialref/shared'
import { circularSpeed } from '@inertialref/physics'
import {
  type FrameId,
  type FrameState,
  Quaternion as Q,
  type UniverseVector,
  UV,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  type Body,
  bodyFrameId,
  bodyOfFrameId,
  type EntityId,
  findBody,
  formatAddress,
  installSurfaceFrame,
  parseAddress,
  systemFrameId,
  systemId,
  type SystemId,
} from '@inertialref/universe'
import { verticalFovDegrees } from '@inertialref/rendering'
import { findShot, placeShot } from './shots.ts'
import {
  currentSystemOf,
  resolveDestination,
  viewingAltitudeKm,
} from './travel.ts'
import { OnFoot, type Stage } from './onFoot.ts'
import type { Host } from './harness.ts'

/*
 * The flying verbs: put the player's ship somewhere, aim it, light it.
 *
 * Two-body speed, sunward placement, orbit-rate spin, the sphere-of-influence
 * clamp and nose-on-target, over the same `Host` the observatory is built on.
 * Each verb returns what it promises — the state it wrote, the nose, the
 * phase it framed — so a test asks the verb rather than rebuilding a dot
 * product out of the world. The harness forwards to it and keeps answering
 * with its status, which is what the console and the photo metadata read.
 *
 * Every verb here is a teleport, and `teleport` drops the rails epoch by
 * construction (ADR-0025); `droppedEpoch` reads the entity afterward rather
 * than restating that, so a teleport that kept one would say so. A walker is
 * boarded first: `onFoot.ts` says why that is the one answer.
 */

const log = getLogger('devtools.maneuvers')

/**
 * Where `land` puts a ship when nobody says otherwise: the `surface`
 * scenario's site and the dock's Land button's. One constant, so the click
 * and `pnpm sim --scenario surface` are the same landing by construction —
 * a discrepancy between them would be invisible and would waste an afternoon.
 */
export const DEBUG_LANDING_SITE: {
  readonly latitude: Degrees
  readonly longitude: Degrees
} = {
  latitude: radiansToDegrees(0.35),
  longitude: radiansToDegrees(-1.1),
}

export interface ManeuverResult {
  /** The state the verb wrote, in the frame it wrote it in. */
  readonly state: FrameState
  /** The nose, frame-local: `headingOf(state)`. */
  readonly heading: Vec3
  /** The sun–body–eye angle; null outside a `b:` frame. */
  readonly phase: Degrees | null
  /** Whether the ship is off rails after the move. Every teleport drops them. */
  readonly droppedEpoch: boolean
}

/** The nose in its frame's axes. Forward is −Z, as everywhere here. */
export function headingOf(state: FrameState): Vec3 {
  return Q.rotate(state.orientation, vec3(0, 0, -1))
}

/**
 * The unit vector toward the star, in the given frame, at a given instant.
 *
 * The *star*, not the frame's parent. For a planet the two agree — its
 * parent is the system frame, whose origin is the star — but a moon's parent
 * is its **planet**: composed against that, `full-face` on Luna frames the
 * earthlit side at whatever phase Earth is in, and `sunset` chases Earth's
 * azimuth instead of the sun's.
 *
 * The instant is a parameter because two callers disagree about it: a shot
 * places the *ship* at the simulation's own time, while the observatory
 * holds a photographic instant of its own — and the sun over a stance is a
 * fact about the picture's time, not the clock's.
 */
export function sunDirection(
  world: World,
  system: SystemId,
  frame: FrameId,
  time: number,
): Vec3 {
  const pose = world.frames.pose(frame, time)
  const star = world.frames.pose(systemFrameId(system), time).position
  const offset = UV.difference(star, pose.position)
  // The star's own frame asking for the star: no direction exists. The +X
  // convention matches goToSystem's placement axis.
  if (Vec.length(offset) < 1) return vec3(1, 0, 0)
  return Vec.normalize(Q.rotateInverse(pose.orientation, offset))
}

/**
 * The angle at a body between an eye and the star: zero for the full face,
 * 180 for a silhouette.
 *
 * A function of a time and an eye, not of an entity, because `ir.light()`
 * asks about an eye that need not be the player's. Only a body frame has a
 * phase: a landing's `sf:`, an interstellar hold-off and a star orbit's `s:`
 * all answer null, and so does an eye at the body's center.
 */
export function orbitalPhase(
  world: World,
  frame: FrameId,
  eye: UniverseVector,
  time: number,
): Degrees | null {
  const address = bodyOfFrameId(frame)
  if (address === null) return null
  const body = world.frames.pose(frame, time).position
  const star = world.frames.pose(systemFrameId(address.system), time).position
  const toEye = UV.difference(eye, body)
  const toStar = UV.difference(star, body)
  if (Vec.length(toEye) < 1 || Vec.length(toStar) < 1) return null
  const cosine = Vec.dot(Vec.normalize(toEye), Vec.normalize(toStar))
  return radiansToDegrees(Math.acos(Math.max(-1, Math.min(1, cosine))))
}

/**
 * The body whose frame an entity is inside, as an address.
 *
 * The frame chain, not a stored field, for the same reason
 * `currentSystemOf` walks it: containment is what makes the player *at* a
 * body. A surface frame's parent is the body frame, so landing still counts,
 * and so does a walker's `bf:`.
 */
export function currentBodyAddress(world: World, id: EntityId | null): string {
  const entity = id === null ? undefined : world.entities.get(id)
  if (entity !== undefined)
    for (const frame of world.frames.chain(entity.state.frame)) {
      const body = bodyOfFrameId(frame)
      if (body !== null) return formatAddress(body)
    }
  throw new Error(
    'The player is not at a body — pass an address, e.g. ir.shot("full-face", "b:2")',
  )
}

export class Maneuvers {
  readonly #host: Host
  /** Stepping out and back in; the verbs board through it. */
  readonly onFoot: OnFoot

  /**
   * `stage` is the harness's cutscene and observatory, which the walker asks
   * about and the pad fixture clears; a bare session has neither.
   */
  constructor(
    host: Host,
    stage: Stage = { playing: () => false, clear: () => {} },
  ) {
    this.#host = host
    // The pad fixture parks the ship before it steps out, through the same
    // landing rule `land` uses; in radians, because the pad is stored in them.
    this.onFoot = new OnFoot(
      host,
      (address, latitude, longitude) => {
        this.#land(address, latitude, longitude)
      },
      stage,
    )
  }

  /**
   * Put the player in a circular orbit around a body — or, given a system
   * address, around its star.
   *
   * Named for what it does physically rather than "teleport": it sets a state
   * that is a valid solution of the two-body problem, so the ship stays there.
   */
  orbit(address: string, altitudeKm?: number): ManeuverResult {
    const world = this.#host.world
    const parsed = parseAddress(address)
    // A star is somewhere you can orbit too: a system address names one, and
    // refusing it forced "orbit the star" through goToSystem's hold-off in the
    // dark. The star lives at its system frame's origin, so this is the same
    // maneuver with the system frame standing in for a body frame.
    if (parsed.kind === 'system')
      return this.#orbitStar(parsed.system, altitudeKm)
    if (parsed.kind !== 'body')
      throw new Error(`${address} is not a body address`)
    const system = world.loadSystem(parsed.system)
    const body = findBody(system, parsed.body)
    if (body === undefined) throw new Error(`No body at ${address}`)

    const radius = body.radius + (altitudeKm ?? 400) * 1000
    const speed = circularSpeed(body.mu, radius)
    const player = this.#ship()
    const frame = bodyFrameId(body.address)

    // Placed on the sunward side, and pointing along the orbit. A debug tool
    // that drops you on the night side of an unlit world, facing away from
    // everything, is technically correct and useless.
    const toStar = sunDirection(world, parsed.system, frame, world.clock.time)
    const alongOrbit = Vec.normalize(Vec.cross(vec3(0, 1, 0), toStar))

    world.teleport(player, {
      frame,
      position: Vec.scale(toStar, radius),
      // Nose along the direction of travel: forward is −Z.
      orientation: Q.fromUnitVectors(vec3(0, 0, -1), alongOrbit),
      velocity: Vec.scale(alongOrbit, speed),
      angularVelocity: Vec.ZERO,
    })
    this.#handsOff(player)
    log.info('placed in orbit', { address, altitudeKm, speed })
    return this.#result(player)
  }

  /**
   * Frame a named, repeatable composition of a body — a camera bookmark.
   *
   * `orbit` places you for flying; this places you for looking, at the
   * distances and phase angles the reference photographs were taken from. The
   * ship is left in a circular orbit through the bookmark position so the
   * composition holds instead of falling, and the nose — which is the camera —
   * is aimed by the shot itself: the body's center, the sunward horizon, or
   * the star's reflection off the surface.
   *
   * With no address it re-frames the body whose frame the player is already
   * in, so `ir.shot('crescent')` after any arrival does what it sounds like.
   */
  shot(name = 'full-face', address?: string): ManeuverResult {
    const world = this.#host.world
    const shot = findShot(name)
    // Lenient like `goTo`, because this is typed at a console: `b:2` relative
    // to the current system is the way anyone actually names a body.
    const target = resolveDestination(
      address ?? currentBodyAddress(world, this.#host.player()),
      world.galaxy,
      currentSystemOf(world, this.#host.player()),
    )
    if (target.kind !== 'body')
      throw new Error(`${address ?? ''} names a system; shots frame a body`)
    const system = world.loadSystem(target.system)
    const body = findBody(
      system,
      target.address.kind === 'body' ? target.address.body : [],
    )
    if (body === undefined) throw new Error(`No body at ${target.text}`)

    const player = this.#ship()
    const frame = bodyFrameId(body.address)

    // The sun direction in the body's frame, exactly as `orbit` derives it.
    const toStar = sunDirection(world, target.system, frame, world.clock.time)

    // Clamped inside the sphere of influence for the same reason
    // `viewingAltitudeKm` is: a "parking orbit" outside the SOI is reframed to
    // the parent and becomes a departure.
    const placement = placeShot(
      shot,
      body.radius,
      toStar,
      body.sphereOfInfluence * 0.85,
      /*
       * The lens the camera is actually wearing, not the flight default.
       *
       * Nine of the sixteen name their standoff as a *fill* of the frame, which
       * is a claim about an angle — so solved against 65° while the slider sits
       * at 20°, `close` parks the hull where the disk subtends 61° in a 20°
       * field and the frame is all ground. `Observatory.compose` passes its own
       * lens for exactly this reason; a bookmark that framed against a lens
       * nobody is looking through is the defect `ir.preset` was fixed for.
       */
      verticalFovDegrees(this.#host.render.framingLens()),
    )
    const distance = Vec.length(placement.position)
    world.teleport(player, {
      frame,
      position: placement.position,
      orientation: placement.orientation,
      velocity: Vec.scale(placement.along, circularSpeed(body.mu, distance)),
      angularVelocity: Vec.ZERO,
    })
    this.#handsOff(player)
    this.#trackOrbit(player)
    log.info('framed shot', { shot: name, address: target.text, distance })
    return this.#result(player)
  }

  /**
   * Park the player on the ground at a latitude and longitude, ready to fly.
   *
   * The angles default to the prime meridian at the equator because `ir` is
   * typed at a console, where the brand checks nothing and a missing angle
   * is `undefined`. A non-finite angle is refused before the ship is touched:
   * a surface frame at `NaN` is a world every later step throws in.
   */
  land(
    address: string,
    latitude: Degrees = deg(0),
    longitude: Degrees = deg(0),
  ): ManeuverResult {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
      throw new Error('A landing needs a finite latitude and longitude')
    return this.#land(
      address,
      degreesToRadians(latitude),
      degreesToRadians(longitude),
    )
  }

  /**
   * Go anywhere, given anything that names it.
   *
   * The god-mode front door, and the only travel verb that does not require you
   * to already know what kind of thing you are naming. A body address arrives
   * in a circular orbit framing that body; a system designation arrives in a
   * close orbit of the star itself, looking at it — you asked for the star,
   * and the star is what fills the view.
   *
   * Passing `distanceAu` asks for the other thing — a hold-off in the system
   * frame, out in the dark, which is where `goToSystem` alone leaves you. That
   * is a real place to want to be and a terrible place to arrive by default: at
   * 40 AU a red dwarf is a sub-pixel point, so "travel to Proxima" appeared to
   * do nothing at all.
   *
   * `orbit`, `land`, `goToSystem` and `face` are still the primitives and still
   * take exactly one kind of argument each — this dispatches to them rather
   * than reimplementing them, so there is one placement rule per maneuver.
   */
  goTo(
    destination: string,
    options: { altitudeKm?: number; distanceAu?: number } = {},
  ): ManeuverResult {
    const world = this.#host.world
    const target = resolveDestination(
      destination,
      world.galaxy,
      currentSystemOf(world, this.#host.player()),
    )
    const system = world.loadSystem(target.system)

    if (target.kind === 'body') {
      const body = findBody(
        system,
        target.address.kind === 'body' ? target.address.body : [],
      )
      if (body === undefined) throw new Error(`No body at ${target.text}`)
      return this.#arriveAt(target.text, body, options.altitudeKm)
    }

    const star = (): UniverseVector =>
      world.frames.pose(systemFrameId(target.system), world.clock.time).position

    // A system designation arrives at the star itself, in a close orbit with
    // the nose on it, rather than at the first planet: travel to *Proxima*
    // should end with Proxima filling the view, and its planets are one
    // `ir.targets()` away.
    if (options.distanceAu === undefined) {
      this.#orbitStar(target.system, options.altitudeKm)
      this.#lookAt(star())
      const player = this.#ship()
      this.#trackOrbit(player)
      return this.#result(player)
    }

    this.goToSystem(target.system, options.distanceAu)
    // Arriving with the nose pointed at nothing is how you conclude the game is
    // broken. `goToSystem` places the ship on the +X axis of the system frame,
    // whose origin is the star.
    return this.#lookAt(star())
  }

  /** Drop the player into interstellar space near a system. */
  goToSystem(system: string, distanceAu = 60): ManeuverResult {
    const world = this.#host.world
    const target = world.loadSystem(systemId(system))
    const player = this.#ship()
    world.teleport(player, {
      frame: systemFrameId(target.id),
      position: vec3(distanceAu * AU, 0, 0),
      orientation: Q.IDENTITY,
      velocity: Vec.ZERO,
      angularVelocity: Vec.ZERO,
    })
    this.#handsOff(player)
    return this.#result(player)
  }

  /**
   * Point the nose at a body without touching its trajectory.
   *
   * Separate from `burnToward` because looking and burning are different acts:
   * this one is free, and it is what you want when setting up a screenshot or
   * checking that a body is where the HUD says it is.
   */
  face(address: string): ManeuverResult {
    return this.#lookAt(this.#bodyPosition(address))
  }

  /** Aim the ship at a body and light the main drive. */
  burnToward(address: string, throttle = 1): ManeuverResult {
    this.#lookAt(this.#bodyPosition(address))
    const player = this.#ship()
    this.#host.world.setThrottle(player, throttle)
    return this.#result(player)
  }

  /**
   * The ship, boarded: the one answer every verb here gives a walker, written
   * in `onFoot.ts`'s header.
   */
  #ship(): EntityId {
    const ship = this.onFoot.board()
    if (!ship.ok) throw new Error(ship.error)
    return ship.value
  }

  #result(player: EntityId): ManeuverResult {
    const world = this.#host.world
    const entity = world.entities.require(player)
    const state = entity.state
    return {
      state,
      heading: headingOf(state),
      phase: orbitalPhase(
        world,
        state.frame,
        world.canonicalPositionOf(player),
        world.clock.time,
      ),
      droppedEpoch: entity.rails === null,
    }
  }

  /**
   * Neutral input after a teleport, drive included.
   *
   * Every placement verb ends here: a ship put into a circular orbit with
   * its drive still lit is not in that orbit on the next tick, and a
   * composition framed with the throttle open drifts out of its own picture.
   */
  #handsOff(player: EntityId): void {
    const world = this.#host.world
    this.#host.render.declareCut()
    world.setControl(player, Vec.ZERO, Vec.ZERO)
    world.setThrottle(player, 0)
  }

  #land(
    address: string,
    latitude: Radians,
    longitude: Radians,
  ): ManeuverResult {
    const world = this.#host.world
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body')
      throw new Error(`${address} is not a body address`)
    const system = world.loadSystem(parsed.system)
    const body = findBody(system, parsed.body)
    if (body === undefined) throw new Error(`No body at ${address}`)

    const frame = installSurfaceFrame(world.frames, body, latitude, longitude)
    const player = this.#ship()
    world.teleport(player, {
      frame,
      // On the pad, which is what the origin of a surface frame *is*:
      // `installSurfaceFrame` derives the frame's elevation from the terrain at
      // this exact quantized latitude/longitude, so local y = 0 is the ground.
      //
      // Landedness is not set here. `stepFlight` short-circuits to
      // `stepLanded` for an entity that is already landed, so a ship declared
      // landed above the ground never meets the contact test and hovers there
      // while the overlay reports an altitude of zero; and three meters up is
      // inside LANDING_CLEARANCE, where `World.#land`'s `max(0, y)` keeps it. Placed
      // at the origin, the contact test lands it on the next tick.
      position: Vec.ZERO,
      orientation: Q.IDENTITY,
      velocity: Vec.ZERO,
      angularVelocity: Vec.ZERO,
    })
    this.#handsOff(player)
    return this.#result(player)
  }

  /**
   * Spin the ship at its own orbital rate, so a framed composition *holds*.
   *
   * A teleport leaves the angular velocity at zero, which is a ship whose nose
   * points at a fixed direction in inertial space — so as the orbit proceeds,
   * the body it was framing slides out of the picture. What a locked-on camera
   * does is rotate once per revolution about the orbit normal, and that rate is
   * `ω = r × v / |r|²` exactly — set it and the nose stays on the body while
   * the terrain turns underneath, which is the whole point of watching a
   * bookmark with time running.
   *
   * Flight assist is switched off with it, deliberately: assist reads any
   * uncommanded spin as tumble and damps it back to zero within seconds,
   * un-tracking the shot. `ir.flightAssist(true)` or the keybinding restores
   * it the moment you want to fly rather than film.
   */
  #trackOrbit(player: EntityId): void {
    const world = this.#host.world
    const state = world.entities.require(player).state
    const r2 = Vec.lengthSquared(state.position)
    if (r2 < 1) return
    const omegaFrame = Vec.scale(
      Vec.cross(state.position, state.velocity),
      1 / r2,
    )
    world.setFlightAssist(player, false)
    world.teleport(player, {
      ...state,
      // The integrator composes angular velocity in *body* axes.
      angularVelocity: Q.rotateInverse(state.orientation, omegaFrame),
    })
  }

  /**
   * A circular orbit around the system's star itself.
   *
   * The star is not a `Body` — it has no address and no frame of its own; it
   * *is* the system frame's origin — so none of the body machinery applies.
   * The default altitude parks eight stellar radii out, where the disk
   * subtends ~14°: a sun hanging in the sky. The one-radius-up rule planets
   * use would put a wall of light across the whole view.
   */
  #orbitStar(system: SystemId, altitudeKm?: number): ManeuverResult {
    const world = this.#host.world
    const target = world.loadSystem(systemId(system))
    const star = target.star
    const radius = star.radius + (altitudeKm ?? (star.radius * 7) / 1000) * 1000
    const speed = circularSpeed(star.mu, radius)
    const player = this.#ship()

    // On +X of the system frame — the same axis goToSystem uses — orbiting in
    // the system's reference plane, prograde like everything else in it.
    const alongOrbit = Vec.cross(vec3(0, 1, 0), vec3(1, 0, 0))
    world.teleport(player, {
      frame: systemFrameId(target.id),
      position: vec3(radius, 0, 0),
      orientation: Q.fromUnitVectors(vec3(0, 0, -1), alongOrbit),
      velocity: Vec.scale(alongOrbit, speed),
      angularVelocity: Vec.ZERO,
    })
    this.#handsOff(player)
    log.info('placed in orbit of the star', { system: target.id, speed })
    return this.#result(player)
  }

  /**
   * Circular orbit at a framing altitude, nose on the body.
   *
   * The second half is the part that is easy to leave out: `orbit` aims along
   * the track, which is right for flying and wrong for arriving — you teleport
   * into orbit and see empty space, which reads as "the planet did not load".
   * A rotation does not change the orbit, and `GameEngine`'s opening shot does
   * this exact pair for this exact reason.
   */
  #arriveAt(address: string, body: Body, altitudeKm?: number): ManeuverResult {
    this.orbit(address, altitudeKm ?? viewingAltitudeKm(body))
    this.face(address)
    // Arrivals are for looking too: hold the body in frame around the orbit
    // rather than letting it drift out over the next few minutes of warp.
    const player = this.#ship()
    this.#trackOrbit(player)
    return this.#result(player)
  }

  #bodyPosition(address: string): UniverseVector {
    const parsed = parseAddress(address)
    if (parsed.kind !== 'body')
      throw new Error(`${address} is not a body address`)
    return this.#host.world.frames.pose(
      bodyFrameId(parsed),
      this.#host.world.clock.time,
    ).position
  }

  /**
   * Point the nose at a universe position, changing nothing else.
   *
   * One implementation for `face` and `burnToward`, which differ only in
   * whether they then set the throttle. Forward is −Z, so the orientation
   * that aims at the target is the rotation taking −Z onto the target
   * direction, and it goes through `teleport` rather than a raw state write
   * because a discontinuous change of attitude has to reset the
   * interpolation history with it.
   */
  #lookAt(target: UniverseVector): ManeuverResult {
    const world = this.#host.world
    const player = this.#ship()
    const state = world.entities.require(player).state
    const framePose = world.frames.pose(state.frame, world.clock.time)
    const toTarget = Q.rotateInverse(
      framePose.orientation,
      UV.difference(target, world.canonicalPositionOf(player)),
    )
    world.teleport(player, {
      ...state,
      orientation: Q.fromUnitVectors(vec3(0, 0, -1), Vec.normalize(toTarget)),
      angularVelocity: Vec.ZERO,
    })
    return this.#result(player)
  }
}
