import {
  formatDistance,
  getLogger,
  type Meters,
  type Seconds,
} from '@inertialref/shared'
import {
  type FrameId,
  type Quat,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import {
  type Body,
  bodyFrameId,
  formatAddress,
  type StarSystem,
  systemFrameId,
  type SystemId,
  type UniverseAddress,
  walkBodies,
} from '@inertialref/universe'
import {
  anglesForPhase,
  applyDrag,
  applyZoom,
  approachState,
  clampDistance,
  clampElevation,
  distanceBounds,
  framingDistance,
  type ObserverState,
  observerPose,
  zoomFactorForNotches,
} from '@inertialref/rendering'
import { currentSystemOf, resolveDestination } from './travel.ts'
import type { HarnessHost } from './harness.ts'

/*
 * The observatory: the planetarium's camera, bound to a live world.
 *
 * `packages/rendering/src/observer.ts` holds the arithmetic — where a camera
 * goes given a target and three numbers — and knows nothing about addresses,
 * frames or bodies. This is the half that does: it resolves what you named,
 * asks the world where that is *this tick*, and hands back a pose. The split is
 * the same one `cinematic.ts` and `cutscene.ts` make, and it exists for the
 * same reason: the geometry is then testable in Node without a universe, and
 * the resolution is testable with one.
 *
 * One deliberate difference from the cutscene director, worth naming because it
 * looks like a violation of that module's rule: **`sample` here does touch the
 * world.** A cutscene resolves its stage once at `prepare` and is a pure
 * function of the frame afterwards, because a scripted scene must be
 * reproducible frame for frame. The observatory is the opposite kind of object
 * — it is *following* something that moves, and a planetarium that resolved
 * Jupiter's position once and then orbited where Jupiter used to be would drift
 * off it within a minute of time warp. Its determinism guarantee is weaker on
 * purpose: given the same tick and the same state, it returns the same pose.
 *
 * Nothing here is canonical. The observatory never teleports the player, never
 * touches the clock, and never writes entity state — you can open it, fly the
 * galaxy for an hour and close it, and `world.stateHash()` will be whatever the
 * simulation made it. That is what makes the planetarium a *view* of the same
 * universe rather than a second game mode with its own rules.
 */

const log = getLogger('devtools.observatory')

/** A camera pose in universe coordinates: where the eye is, and where it looks. */
export interface ObserverPose {
  readonly position: UniverseVector
  readonly orientation: Quat
}

/** What the camera is looking at, once an address has been resolved. */
export interface ObserverTarget {
  /** Text address — a system (`s:SOL`) or a body (`s:SOL/b:2`). */
  readonly address: string
  readonly name: string
  readonly kind: 'star' | 'planet' | 'moon'
  /** The system this target belongs to, for the star-direction lookup. */
  readonly system: SystemId
  /** The frame whose origin the camera orbits. */
  readonly frame: FrameId
  /** Metres. A star's own radius, a body's equatorial radius. */
  readonly radius: Meters
  /** One line of description for a panel header. */
  readonly detail: string
}

/** Everything a panel needs to draw the observatory's state. */
export interface ObserverStatus {
  readonly target: ObserverTarget | null
  readonly state: ObserverState
  /** Where the camera is easing to. Equal to `state` once it has arrived. */
  readonly desired: ObserverState
  /** True while a fly-to is still visibly moving. */
  readonly travelling: boolean
  /** Distance from the target's *surface*, which is what a reader wants. */
  readonly altitude: Meters
  readonly altitudeText: string
  /** How much of the frame height the target subtends, 0–1. */
  readonly fill: number
}

/**
 * How long a fly-to takes to close 63% of the gap, seconds.
 *
 * Slower than a UI easing because the gap can be fourteen decades of distance
 * and the point of the transition is that you *see* the scale change — a fast
 * ease across that range is indistinguishable from a cut, which is the thing
 * a planetarium exists not to do. Tuned by flying Earth → Proxima and asking
 * whether the intervening emptiness registered.
 */
export const TRAVEL_TAU: Seconds = 0.55

/**
 * Below this the ease has arrived and snaps.
 *
 * A tenth of a percent of the distance and a milliradian of orbit — under a
 * pixel at any framing. An exponential approach never actually reaches its
 * target, so without a floor `travelling` stays true forever and a panel that
 * shows it flickers a "moving" indicator for the rest of the session.
 */
const ARRIVED_LOG_EPSILON = 1e-3

/**
 * The opening framing for a newly picked target: a disc with space around it.
 *
 * 0.55 of the frame height rather than 0.9. Every recognisable photograph of a
 * planet has sky around it, and a body that arrives edge-to-edge gives the eye
 * nothing to judge its size against. See `shots.ts`, which argues the same
 * thing in body radii.
 */
export const DEFAULT_FILL = 0.55

export class Observatory {
  readonly #host: HarnessHost
  #target: ObserverTarget | null = null
  #state: ObserverState = { azimuth: 0.6, elevation: 0.25, distance: 1e9 }
  #desired: ObserverState = this.#state
  /** The lens the framing maths assumes. Set by the host from its camera. */
  #fovDeg = 65

  constructor(host: HarnessHost) {
    this.#host = host
  }

  get target(): ObserverTarget | null {
    return this.#target
  }

  get state(): ObserverState {
    return this.#state
  }

  /** The host's current vertical field of view; framing depends on it. */
  setFov(fovDeg: number): void {
    if (Number.isFinite(fovDeg) && fovDeg > 1 && fovDeg < 179) {
      this.#fovDeg = fovDeg
    }
  }

  /**
   * Point the observatory at something, and frame it.
   *
   * Lenient about what it is handed, exactly like `goTo`: this is typed into a
   * search box or clicked out of a list, and `parseAddress` is deliberately
   * strict everywhere else. `ease` is what makes a click a *move* — the camera
   * travels there rather than cutting, which is the whole reason to look at a
   * planetarium instead of a table of coordinates.
   */
  focus(
    destination: string,
    options: { fill?: number; ease?: boolean } = {},
  ): ObserverStatus {
    const target = this.#resolve(destination)
    const previous = this.#target
    this.#target = target

    const distance = clampDistance(
      framingDistance(
        target.radius,
        this.#fovDeg,
        options.fill ?? DEFAULT_FILL,
      ),
      target.radius,
    )
    /*
     * Keep the angles across a change of target, and only the distance moves.
     *
     * Resetting them would spin the camera around the new body on every click,
     * which reads as the interface reasserting itself over the user. Keeping
     * them means a tour through six moons is six dolly moves from a consistent
     * angle — and the phase presets are there for when a specific lighting
     * angle is actually wanted.
     */
    this.#desired = {
      azimuth: this.#state.azimuth,
      elevation: this.#state.elevation,
      distance,
    }
    if (options.ease === false || previous === null) this.#state = this.#desired

    log.info('observatory focused', {
      address: target.address,
      distance: formatDistance(distance),
    })
    return this.status()
  }

  /**
   * Let go of the camera.
   *
   * With no target the observatory produces no pose, and the host falls back to
   * whatever owns the camera otherwise — the ship, in every flight mode. That
   * fallback is the whole mechanism for leaving the planetarium: there is no
   * "restore" step and nothing to put back, because nothing was taken.
   */
  clear(): void {
    this.#target = null
  }

  /** Orbit by a pointer drag, in pixels. */
  drag(dxPixels: number, dyPixels: number, sensitivity = 1): void {
    // Both are written, not just the desired: a drag is direct manipulation and
    // must not lag a damping filter. Easing is for travel, not for the hand.
    this.#desired = applyDrag(this.#desired, dxPixels, dyPixels, sensitivity)
    this.#state = { ...this.#state, ...pick(this.#desired) }
  }

  /** Zoom by a ratio. Above 1 retreats. */
  zoom(factor: number): void {
    const radius = this.#target?.radius ?? 0
    this.#desired = applyZoom(this.#desired, factor, radius)
    // The wheel eases while the drag does not, because a wheel arrives in
    // discrete jumps a hand cannot smooth and a drag arrives already smooth.
    // Without this a notch is a visible step at every scale.
  }

  /** Zoom by whole wheel notches. Positive retreats. */
  zoomNotches(notches: number): void {
    this.zoom(zoomFactorForNotches(notches))
  }

  /** Set the distance directly — the panel's slider and the presets. */
  setDistance(distance: Meters, ease = true): void {
    const radius = this.#target?.radius ?? 0
    this.#desired = {
      ...this.#desired,
      distance: clampDistance(distance, radius),
    }
    if (!ease) this.#state = this.#desired
  }

  /** Set the orbit angles directly, in radians. */
  setAngles(azimuth: number, elevation: number, ease = true): void {
    this.#desired = {
      ...this.#desired,
      azimuth,
      elevation: clampElevation(elevation),
    }
    if (!ease) this.#state = this.#desired
  }

  /** Re-frame the current target so it fills `fill` of the frame height. */
  frameTarget(fill = DEFAULT_FILL): void {
    if (this.#target === null) return
    this.setDistance(framingDistance(this.#target.radius, this.#fovDeg, fill))
  }

  /**
   * Move to a photographic phase angle — full face, gibbous, crescent.
   *
   * The angle is measured against where the star actually is *now*, so the
   * preset means the same thing at any point in a planet's year. That is the
   * bug `placeShot` documents in the flight harness, met again here: a phase
   * solved once against a stale sun line is right in one season and wrong in
   * the other three.
   */
  setPhase(phaseDeg: number, elevationDeg = 10): void {
    const toStar = this.#starDirection()
    if (toStar === null) return
    const { azimuth, elevation } = anglesForPhase(
      toStar,
      phaseDeg,
      elevationDeg,
    )
    this.setAngles(azimuth, elevation)
  }

  /** The band the current target permits. Panels draw sliders against it. */
  bounds(): { readonly min: Meters; readonly max: Meters } {
    return distanceBounds(this.#target?.radius ?? 0)
  }

  status(): ObserverStatus {
    const radius = this.#target?.radius ?? 0
    const altitude = Math.max(0, this.#state.distance - radius)
    const fill =
      radius > 0 && this.#state.distance > radius
        ? (2 * Math.asin(Math.min(1, radius / this.#state.distance)) * 180) /
          Math.PI /
          this.#fovDeg
        : 0
    return {
      target: this.#target,
      state: this.#state,
      desired: this.#desired,
      travelling: !this.#arrived(),
      altitude,
      altitudeText: formatDistance(altitude),
      fill,
    }
  }

  /**
   * The camera pose for this frame, or null when no target is set.
   *
   * `dt` is wall-clock seconds — the same delta the render loop already has —
   * because the easing is a presentation filter and must run at display rate
   * even when the simulation is paused. A planetarium in which pausing time
   * also freezes a fly-to mid-flight would be a bug in every screenshot.
   */
  sample(dt: Seconds): ObserverPose | null {
    const target = this.#target
    if (target === null) return null

    if (!this.#arrived()) {
      this.#state = approachState(this.#state, this.#desired, dt, TRAVEL_TAU)
    } else {
      this.#state = this.#desired
    }

    const centre = this.#targetPosition(target)
    if (centre === null) return null
    return observerPose(centre, this.#state)
  }

  /** Whether the ease has close enough that holding it open is noise. */
  #arrived(): boolean {
    const a = this.#state
    const b = this.#desired
    return (
      Math.abs(Math.log(a.distance) - Math.log(b.distance)) <
        ARRIVED_LOG_EPSILON &&
      Math.abs(a.azimuth - b.azimuth) < ARRIVED_LOG_EPSILON &&
      Math.abs(a.elevation - b.elevation) < ARRIVED_LOG_EPSILON
    )
  }

  #targetPosition(target: ObserverTarget): UniverseVector | null {
    const world = this.#host.world
    try {
      return world.frames.pose(target.frame, world.clock.time).position
    } catch {
      // The frame belongs to a system that was unloaded, or to a world that
      // has been replaced under us by a save load. Losing the pose for a frame
      // is not worth throwing out of a render loop over.
      return null
    }
  }

  /** Unit vector from the target towards its star, in universe axes. */
  #starDirection(): Vec3 | null {
    const target = this.#target
    if (target === null || target.kind === 'star') return null
    const world = this.#host.world
    const centre = this.#targetPosition(target)
    if (centre === null) return null
    try {
      const star = world.frames.pose(
        systemFrameId(target.system),
        world.clock.time,
      ).position
      const toStar = UV.difference(star, centre)
      return Vec.length(toStar) > 0 ? Vec.normalize(toStar) : null
    } catch {
      return null
    }
  }

  /**
   * Turn anything a human names into a target.
   *
   * `resolveDestination` is the same resolver `goTo` uses, so `SOL`, `b:2` and
   * `g:milky-way/s:SOL/b:2` all mean here what they mean there. One resolver,
   * because a planetarium whose search box accepted a different vocabulary
   * from the console would be a second addressing scheme in the same build.
   */
  #resolve(destination: string): ObserverTarget {
    const world = this.#host.world
    const resolved = resolveDestination(
      destination,
      world.galaxy,
      currentSystemOf(world, this.#host.player()),
    )
    const system = world.loadSystem(resolved.system)

    if (resolved.kind === 'system') {
      return {
        // `resolveDestination` hands a system back as an id rather than text,
        // because the verbs that take one take an id. A target's address is
        // the string a bookmark, a URL and a panel header all carry, so it is
        // written in the canonical galaxy-qualified form here.
        address: `g:${world.galaxy}/s:${resolved.system}`,
        name: system.name,
        kind: 'star',
        system: resolved.system,
        frame: systemFrameId(resolved.system),
        radius: system.star.radius,
        detail: `${system.star.spectralType} · ${system.planets.length} planets`,
      }
    }

    // `TravelDestination` carries the address as the open union, and a region
    // or an object address resolves to the body containing it — so this is a
    // narrowing, not a possibility worth a branch of its own.
    const address = resolved.address
    if (address.kind !== 'body')
      throw new Error(`${resolved.text} does not name a body`)
    const body = findBodyByAddress(system, address)
    if (body === undefined) throw new Error(`No body at ${resolved.text}`)
    return {
      address: resolved.text,
      name: body.name,
      // Depth in the issue path, not a stored flag: `b:5.2` is a moon because
      // it hangs off a planet, which is the only thing that makes it one.
      kind: address.body.length > 1 ? 'moon' : 'planet',
      system: resolved.system,
      frame: bodyFrameId(address),
      radius: body.radius,
      detail: `${body.kind} · ${body.provenance} · ${formatDistance(
        body.elements.semiMajorAxis,
      )}`,
    }
  }
}

/** Only azimuth and elevation. A drag never moves the camera in or out. */
const pick = (
  state: ObserverState,
): Pick<ObserverState, 'azimuth' | 'elevation'> => ({
  azimuth: state.azimuth,
  elevation: state.elevation,
})

function findBodyByAddress(
  system: StarSystem,
  address: UniverseAddress,
): Body | undefined {
  if (address.kind !== 'body') return undefined
  const wanted = formatAddress(address)
  for (const body of walkBodies(system)) {
    if (formatAddress(body.address) === wanted) return body
  }
  return undefined
}
