import {
  formatDistance,
  getLogger,
  type Meters,
  type Radians,
  type Seconds,
} from '@inertialref/shared'
import {
  type FrameId,
  type Quat,
  Quaternion as Q,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import {
  type Body,
  bodyFixedFrameId,
  bodyFrameId,
  datumRadius,
  formatAddress,
  geodeticDirection,
  hasSolidSurface,
  parseAddress,
  findBody,
  groundElevation,
  type StarSystem,
  surfaceRadius,
  type SurveySite,
  surveySites,
  systemFrameId,
  type SystemId,
  type UniverseAddress,
  walkBodies,
  planetCount,
} from '@inertialref/universe'
import {
  anglesForPhase,
  applyDrag,
  applyZoom,
  approachState,
  clampDistance,
  clampElevation,
  clampLatitude,
  clampPitch,
  clampStanceHeight,
  distanceBounds,
  framingDistance,
  heightForScrub,
  horizonPitch,
  MIN_STANCE_HEIGHT,
  type ObserverState,
  observerPose,
  type Lens,
  LENS_PRESETS,
  scrubForHeight,
  shortestAngle,
  type SurfaceStance,
  surfaceHeightBounds,
  surfaceStancePose,
  verticalFovDegrees,
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
  /** Meters. A star's own radius, a body's equatorial radius. */
  readonly radius: Meters
  /** One line of description for a panel header. */
  readonly detail: string
}

/**
 * Where the camera is standing, when it is standing rather than orbiting.
 *
 * Everything a panel needs to draw the descent controls, including the two
 * numbers that only mean something down here: `scrub`, which is the slider's
 * own position because the band is logarithmic, and `groundElevation`, which is
 * what the terrain says is under your feet.
 */
export interface SurfaceStatus {
  readonly stance: SurfaceStance
  /** The scrub's position in [0, 1] for `stance.height`. */
  readonly scrub: number
  /** Elevation of the ground below the stance, relative to the datum. */
  readonly groundElevation: Meters
  /** Distance from the body's center to the eye. */
  readonly radius: Meters
  readonly heightText: string
  /** The survey site the stance is on, when it was set from one. */
  readonly site: string | null
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
  /** Non-null exactly while the camera is on the ground. See `stand`. */
  readonly surface: SurfaceStatus | null
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
 * The opening framing for a newly picked target: a disk with space around it.
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
  /**
   * The surface arm's whole state: non-null exactly while standing.
   *
   * Not a mode flag beside the orbit state but *instead* of it — a nullable
   * field, so "which arm owns the camera" is a question with one answer and
   * cannot be inconsistent. The orbit state is left untouched underneath, which
   * is what makes `leaveSurface` a restore with nothing to restore: the camera
   * goes back to the framing it had before the descent, because it never left.
   */
  #stance: SurfaceStance | null = null
  /** Which survey site the stance came from, when it came from one. */
  #site: string | null = null

  constructor(host: HarnessHost) {
    this.#host = host
  }

  get target(): ObserverTarget | null {
    return this.#target
  }

  get state(): ObserverState {
    return this.#state
  }

  /** Whether the camera is on the ground rather than in orbit. */
  get standing(): boolean {
    return this.#stance !== null
  }

  /**
   * Where the camera is this instant, or null when it is holding nothing.
   *
   * Deliberately not `sample()`: that one advances the ease and is the render
   * loop's to call exactly once per frame. This is a *reading*, for anything
   * that needs to know where the viewer is without being the viewer — the
   * catalog sorts by distance from it, so calling `sample` to find out would
   * have a panel stepping the camera's animation every time it polled.
   */
  get eye(): UniverseVector | null {
    const target = this.#target
    if (target === null) return null
    // The surface arm first, because when it holds the camera the orbit state
    // underneath it is stale by design — a catalog sorting by distance from
    // "the viewer" while the viewer is standing on Iapetus must not sort by
    // where the viewer was before the descent.
    if (this.#stance !== null) return this.#surfacePose()?.position ?? null
    const centre = this.#targetPosition(target)
    return centre === null ? null : observerPose(centre, this.#state).position
  }

  /**
   * The lens the framing math is solved against.
   *
   * Read from the host rather than pushed into here every step, which is what
   * `setFov` was: a scalar copied out of the engine once a frame into a private
   * field, so the observatory held its own idea of the optics and the only
   * thing keeping the two in step was that nobody had forgotten the call. The
   * lens has one producer — `GameEngine`, under the pose's own precedence — and
   * a consumer that cannot see it is a bug rather than a case to have a default
   * for. The fallback here is the flight lens because a headless host has no
   * camera panel, not because the value is uncertain.
   */
  get #lens(): Lens {
    return this.#host.lensView?.()?.lens ?? LENS_PRESETS.flight
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
    // Focusing something else is leaving the ground. A stance names a latitude
    // and a longitude on one particular body, so carrying it across a change of
    // target would put the camera at those coordinates on a different world.
    this.#stance = null
    this.#site = null

    const distance = clampDistance(
      framingDistance(
        target.radius,
        verticalFovDegrees(this.#lens),
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
    /*
     * And the ease starts from a distance the *new* target permits.
     *
     * `approachState` interpolates distance in log space and clamps only
     * elevation on the way, so every intermediate frame is whatever the old
     * target's band allowed. Settled 3.2e6 m from Luna and then clicking the
     * Sun put the eye 695,700 km inside the photosphere for the second the
     * transition took, and nothing surfaced it: `status().altitude` is
     * `Math.max(0, distance - radius)`, so a negative clearance reads as zero.
     *
     * Clamped here, at the moment of re-target, rather than inside
     * `approachState` — that is shared with zoom, where clamping the
     * *interpolant* would change the easing curve rather than its endpoints.
     */
    this.#state = {
      ...this.#state,
      distance: clampDistance(this.#state.distance, target.radius),
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
    this.#stance = null
    this.#site = null
  }

  /*
   * The orbit arm's writers refuse while the surface arm holds the camera.
   *
   * `sample` short-circuits to `#surfacePose` when a stance is held, so a drag,
   * a wheel notch or a preset down here changes nothing on screen — and every
   * one of them is wired straight through by `useObserverInput`, which has no
   * idea which arm is drawing. Without the refusal the gesture silently rewrites
   * the state `leaveSurface` returns to, so a scroll while standing lands the
   * ascent on a framing nobody chose and leaves `travelling` true forever,
   * because `sample` never runs the ease that would clear it.
   */
  /** Orbit by a pointer drag, in pixels. */
  drag(dxPixels: number, dyPixels: number, sensitivity = 1): void {
    if (this.#stance !== null) return
    // Both are written, not just the desired: a drag is direct manipulation and
    // must not lag a damping filter. Easing is for travel, not for the hand.
    this.#desired = applyDrag(this.#desired, dxPixels, dyPixels, sensitivity)
    this.#state = { ...this.#state, ...pick(this.#desired) }
  }

  /** Zoom by a ratio. Above 1 retreats. */
  zoom(factor: number): void {
    if (this.#stance !== null) return
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
    if (this.#stance !== null) return
    const radius = this.#target?.radius ?? 0
    this.#desired = {
      ...this.#desired,
      distance: clampDistance(distance, radius),
    }
    if (!ease) this.#state = this.#desired
  }

  /** Set the orbit angles directly, in radians. */
  setAngles(azimuth: number, elevation: number, ease = true): void {
    if (this.#stance !== null) return
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
    this.setDistance(
      framingDistance(
        this.#target.radius,
        verticalFovDegrees(this.#lens),
        fill,
      ),
    )
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

  /* --------------------------------------------------------------------- */
  /* The surface arm                                                        */
  /* --------------------------------------------------------------------- */

  /**
   * Put the camera on the ground.
   *
   * Below `MIN_DISTANCE_RADII`, which the orbit arm refuses to go under and is
   * right to: half a radius up is where a planetarium stops showing you a world
   * and starts showing you ground with no horizon in it. What that clamp also
   * prevented was ever *inspecting* a surface, so the only way to look at
   * terrain was to fly a ship at it — which is the line in the plan's gap table
   * that says iteration and testing both pay for it.
   *
   * Read-only like everything else here. No teleport, no clock, no entity
   * write: it samples `surfaceRadius` and returns a camera pose, and
   * `observatory.test.ts`'s state-hash comparison covers this arm too.
   *
   * **Entering is a cut, not a fly-to, and that is deliberate.** The orbit arm
   * eases because a transition across fourteen decades has to read as a move;
   * this one is the instrument a plate is captured through, and an ease means
   * every capture has to wait an unspecified number of frames for a filter to
   * settle before the picture is the picture. `ir.visit` returns and the frame
   * after it is the frame you asked for.
   *
   * **It resolves before it commits, and the ordering is the whole of two
   * bugs.** Calling `focus` first is the obvious shape and is wrong twice.
   * `focus` re-solves the distance from `framingDistance`, so a `stand` on the
   * body already held silently discarded the framing the user had zoomed to —
   * and `leaveSurface` then "restored" a default nobody had chosen, which is
   * exactly the thing four docstrings here promise it does not do. And because
   * the surface check ran *after* the commit, `stand('s:SOL/b:5')` retargeted
   * the camera to Saturn and only then threw "no surface to stand on", leaving
   * the planetarium looking at a body the call had refused.
   */
  stand(
    destination?: string,
    options: {
      readonly site?: string
      readonly latitude?: Radians
      readonly longitude?: Radians
      readonly height?: Meters
      readonly heading?: Radians
      readonly pitch?: Radians
    } = {},
  ): ObserverStatus {
    const wanted =
      destination === undefined ? this.#target : this.#resolve(destination)
    if (wanted === null) {
      throw new Error('The observatory is not looking at anything')
    }
    const body = this.#bodyOf(wanted)
    if (body === null) {
      throw new Error(`${wanted.name} is not a body`)
    }
    if (!hasSolidSurface(body)) {
      throw new Error(`${body.name} has no surface to stand on`)
    }
    // Before the focus below, with the no-surface check: every refusal has to
    // come before anything commits, or a typo'd site retargets the planetarium
    // and throws away the caller's framing on a call that then refuses.
    const site =
      options.site === undefined
        ? undefined
        : surveySites(body).find((one) => one.id === options.site)
    if (options.site !== undefined && site === undefined) {
      throw new Error(
        `${body.name} has no site "${options.site}" — try ${surveySites(body)
          .map((one) => one.id)
          .join(', ')}`,
      )
    }
    // Only now, and only if it is somewhere else. Re-focusing the address
    // already held throws the framing away, and committing before the last
    // refusal leaves the camera on a body the call declined to stand on.
    if (wanted.address !== this.#target?.address) {
      this.focus(wanted.address, { ease: false })
    }

    // Clamped to the same limit `simulateDescent` clamps to, and for the same
    // reason: past ±90° `cos(latitude)` flips sign and the eye stands on the
    // anti-meridian while the stance reports the number it was handed. The
    // probe exists to predict this camera, so the two cannot disagree about
    // what a latitude means.
    const latitude = clampLatitude(options.latitude ?? site?.latitude ?? 0)
    const longitude = options.longitude ?? site?.longitude ?? 0
    const height = clampStanceHeight(
      options.height ?? MIN_STANCE_HEIGHT,
      body.radius,
    )
    this.#stance = {
      latitude,
      longitude,
      height,
      heading: options.heading ?? 0,
      // Level with the horizon rather than level with the tangent plane. From
      // 400 km up the horizon is 19.79° *below* the local horizontal, so a
      // pitch of zero at the top of a descent is a picture of empty sky.
      pitch: clampPitch(options.pitch ?? horizonPitch(body.radius, height)),
    }
    this.#site = site?.id ?? null
    log.info('observatory standing', {
      address: this.#target?.address,
      site: this.#site,
      height,
    })
    return this.status()
  }

  /** Back to orbit, at whatever framing the camera had before the descent. */
  leaveSurface(): ObserverStatus {
    this.#stance = null
    this.#site = null
    return this.status()
  }

  /** Move the stance without changing the height or the heading. */
  moveTo(site: string | { latitude: Radians; longitude: Radians }): void {
    const stance = this.#stance
    const body = this.#body()
    if (stance === null || body === null) return
    if (typeof site !== 'string') {
      this.#stance = {
        ...stance,
        latitude: clampLatitude(site.latitude),
        longitude: site.longitude,
      }
      this.#site = null
      return
    }
    const found = surveySites(body).find((one) => one.id === site)
    if (found === undefined) return
    this.#stance = {
      ...stance,
      latitude: found.latitude,
      longitude: found.longitude,
    }
    this.#site = found.id
  }

  /**
   * Set the height above the ground, meters.
   *
   * Direct manipulation, unfiltered, exactly like `drag` and for the same
   * reason: this is a slider under a finger, and a damping filter between the
   * finger and the picture is lag rather than easing.
   */
  setStanceHeight(height: Meters): void {
    const stance = this.#stance
    const body = this.#body()
    if (stance === null || body === null) return
    const next = clampStanceHeight(height, body.radius)
    this.#stance = {
      ...stance,
      height: next,
      // The horizon moves as you climb, so a pitch that was tracking it keeps
      // tracking it. A pitch the user has aimed somewhere does not: the test is
      // whether the current pitch is still the one the previous height implied.
      pitch:
        Math.abs(stance.pitch - horizonPitch(body.radius, stance.height)) < 1e-6
          ? horizonPitch(body.radius, next)
          : stance.pitch,
    }
  }

  /** Set the height from a scrub position in [0, 1]. See `heightForScrub`. */
  setStanceScrub(t: number): void {
    const body = this.#body()
    if (body === null) return
    this.setStanceHeight(heightForScrub(body.radius, t))
  }

  /** Compass heading in radians: 0 is north, increasing toward east. */
  setHeading(heading: Radians): void {
    // A heading has no bound to clamp to — it wraps — so the only thing to
    // refuse is the one value that is not an angle. See the note above
    // `clampPitch`: NaN here is a NaN quaternion and a black frame.
    if (this.#stance === null || !Number.isFinite(heading)) return
    this.#stance = { ...this.#stance, heading }
  }

  /** Above the horizontal, radians. Clamped short of vertical. */
  setPitch(pitch: Radians): void {
    if (this.#stance === null) return
    this.#stance = { ...this.#stance, pitch: clampPitch(pitch) }
  }

  /**
   * Put the horizon across the middle of the frame from where the eye is now.
   *
   * The height comes from the stance rather than from a caller, because a panel
   * reads the stance out of an 8 Hz sample: a control that solved the dip from
   * the height it last *saw* would aim at 0.045° after a scrub to 400 km, and —
   * worse — `setStanceHeight` decides whether to keep tracking the horizon by
   * comparing the pitch it holds against the dip the current height implies, so
   * a pitch solved from a stale height fails that test forever after and the
   * tracking never resumes.
   */
  levelToHorizon(): void {
    const stance = this.#stance
    const body = this.#body()
    if (stance === null || body === null) return
    this.#stance = {
      ...stance,
      pitch: horizonPitch(body.radius, stance.height),
    }
  }

  /** The named places on the body being looked at. Empty for a star. */
  sites(): readonly SurveySite[] {
    const body = this.#body()
    return body === null || !hasSolidSurface(body) ? [] : surveySites(body)
  }

  /** The height band the surface arm covers here. Panels draw sliders against it. */
  stanceBounds(): { readonly min: Meters; readonly max: Meters } {
    return surfaceHeightBounds(this.#target?.radius ?? 0)
  }

  status(): ObserverStatus {
    const radius = this.#target?.radius ?? 0
    const altitude = Math.max(0, this.#state.distance - radius)
    const surface = this.#surfaceStatus()
    /*
     * How much of the frame the body fills — and standing on it, that is all of
     * it, whatever the orbit arm was left at.
     *
     * `state` and `desired` below stay the orbit arm's own held numbers on
     * purpose: they are what `leaveSurface` returns to, and a reader asking for
     * them is asking about that camera. `fill` is not like that. It is a
     * property of the picture, and computing it from a distance the picture is
     * not being taken at made the Object panel's readout describe where the
     * viewer had been before the descent.
     */
    const fill =
      surface !== null
        ? 1
        : radius > 0 && this.#state.distance > radius
          ? (2 * Math.asin(Math.min(1, radius / this.#state.distance)) * 180) /
            Math.PI /
            verticalFovDegrees(this.#lens)
          : 0
    return {
      target: this.#target,
      state: this.#state,
      desired: this.#desired,
      travelling: !this.#arrived(),
      // Standing, the reader wants the height above the ground under their feet
      // — not the distance from a datum the orbit arm was last left at.
      altitude: surface?.stance.height ?? altitude,
      altitudeText: formatDistance(surface?.stance.height ?? altitude),
      fill,
      surface,
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
    // The surface arm short-circuits the ease entirely. See `stand`.
    if (this.#stance !== null) return this.#surfacePose()

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
      // `shortestAngle`, because that is the way `approachState` converges.
      // Against the raw difference, an azimuth more than half a turn from the
      // desired one settles at a difference near 2π that never falls below the
      // epsilon — so `travelling` stays true for the rest of the session,
      // which is the exact failure this constant's docstring exists to
      // prevent. Azimuth accumulates as you drag; two headings naming the same
      // direction can be many turns apart numerically.
      Math.abs(shortestAngle(a.azimuth, b.azimuth)) < ARRIVED_LOG_EPSILON &&
      Math.abs(a.elevation - b.elevation) < ARRIVED_LOG_EPSILON
    )
  }

  /**
   * Where the thing being looked at is, at the instant it is *drawn*.
   *
   * `renderTime`, never `clock.time`. The scene places every body at the
   * snapshot's render time, so a camera anchored to the tick sits at a point
   * the drawn body has already left — by the body's velocity times up to one
   * tick, sawtoothing as alpha sweeps and resets. See `SimulationClock.
   * renderTime`; the short version is that it made Phobos and Deimos vibrate by
   * 11 and 19 pixels in the planetarium while everything larger held still.
   */
  #targetPosition(target: ObserverTarget): UniverseVector | null {
    const world = this.#host.world
    try {
      return world.frames.pose(target.frame, world.clock.renderTime).position
    } catch {
      // The frame belongs to a system that was unloaded, or to a world that
      // has been replaced under us by a save load. Losing the pose for a frame
      // is not worth throwing out of a render loop over.
      return null
    }
  }

  /**
   * The body being looked at, or null when it is a star or has gone away.
   *
   * Resolved on demand rather than held on `ObserverTarget`, because a `Body`
   * is a snapshot of a generated system and the world underneath can be
   * replaced by a save load. A held reference would keep the camera standing on
   * a mountain belonging to a universe that no longer exists.
   */
  #body(): Body | null {
    return this.#bodyOf(this.#target)
  }

  /**
   * The same, for a target that has not been committed yet.
   *
   * `stand` has to know whether a body has a surface *before* it retargets the
   * camera — see the ordering note there — and that means resolving a target
   * this object is not holding.
   */
  #bodyOf(target: ObserverTarget | null): Body | null {
    if (target === null || target.kind === 'star') return null
    try {
      const address = parseAddress(target.address)
      if (address.kind !== 'body') return null
      const system = this.#host.world.system(address.system)
      if (system === undefined) return null
      return findBody(system, address.body) ?? null
    } catch {
      return null
    }
  }

  /**
   * Where the eye is when it is standing, in universe coordinates.
   *
   * Two frames and they are not interchangeable. The offset and the orientation
   * come out of `surfaceStancePose` in the body's **rotating** axes, so both are
   * carried into universe axes by the `bf:` frame's pose — the `b:` frame's
   * orbital pose does not turn, and using it would leave the camera fixed in
   * inertial space while the mountain it is standing on rotates out from under
   * it. That is the same bug the `BodyFixedDirection` brand exists to prevent,
   * met one layer up where a brand cannot reach.
   *
   * `renderTime`, never `clock.time`, exactly as `#targetPosition` documents.
   */
  #surfacePose(): ObserverPose | null {
    const stance = this.#stance
    const body = this.#body()
    if (stance === null || body === null) return null
    const world = this.#host.world
    let spin
    try {
      spin = world.frames.pose(
        bodyFixedFrameId(body.address),
        world.clock.renderTime,
      )
    } catch {
      return null
    }
    const up = geodeticDirection(stance.latitude, stance.longitude)
    const { offset, orientation } = surfaceStancePose(
      up,
      surfaceRadius(body, up),
      stance,
    )
    return {
      position: UV.translate(spin.position, Q.rotate(spin.orientation, offset)),
      orientation: Q.multiply(spin.orientation, orientation),
    }
  }

  #surfaceStatus(): SurfaceStatus | null {
    const stance = this.#stance
    const body = this.#body()
    if (stance === null || body === null) return null
    const up = geodeticDirection(stance.latitude, stance.longitude)
    // One elevation sample, not two. `surfaceRadius` is `datumRadius +
    // groundElevation`, so asking for both the radius and the elevation the way
    // they read is fourteen octaves of noise run twice, eight times a second.
    const elevation = groundElevation(body.surface, up)
    return {
      stance,
      scrub: scrubForHeight(body.radius, stance.height),
      /*
       * The terrain's own elevation, not `surfaceRadius − body.radius`.
       *
       * `surfaceRadius` is `datumRadius + groundElevation`, and `datumRadius`
       * is the measured *ellipsoid* on any body with a figure — so subtracting
       * `body.radius` folds the figure offset into a number the panel prints as
       * a terrain elevation. On Phobos that is about −3.5 km of "elevation" on a
       * body with a kilometer of relief; on Haumea it reaches −513 km. Worse, the
       * Surface panel prints it directly under site buttons showing
       * `SurveySite.elevation`, which is this exact function — the same place,
       * two numbers, kilometers apart.
       */
      groundElevation: elevation,
      radius: datumRadius(body, up) + elevation + stance.height,
      heightText: formatDistance(stance.height),
      site: this.#site,
    }
  }

  /** Unit vector from the target toward its star, in universe axes. */
  #starDirection(): Vec3 | null {
    const target = this.#target
    if (target === null || target.kind === 'star') return null
    const world = this.#host.world
    const centre = this.#targetPosition(target)
    if (centre === null) return null
    try {
      // Same instant as `#targetPosition`, for the same reason: the lighting
      // direction is measured between two points that must both be sampled at
      // the moment the frame depicts.
      const star = world.frames.pose(
        systemFrameId(target.system),
        world.clock.renderTime,
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
        detail: `${system.star.spectralType} · ${planetCount(system)} planets`,
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
