import {
  formatDistance,
  formatReading,
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
  vec3,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import {
  type Body,
  bodyFixedFrameId,
  bodyFrameId,
  datumRadius,
  directionToGeodetic,
  formatAddress,
  geodeticDirection,
  parentOf,
  hasSolidSurface,
  parseAddress,
  findBody,
  drawnElevation,
  drawnSurfaceRadius,
  type StarSystem,
  type SurveySite,
  surveySites,
  systemFrameId,
  type SystemId,
  type UniverseAddress,
  walkBodies,
  planetCount,
} from '@inertialref/universe'
import {
  GALAXY_VIEWS,
  createGalaxyJourney,
  galaxyJourneyState,
  galaxyJourneyProgress,
  validateGalaxyJourney,
  type GalaxyJourneyRoute,
  type GalaxyView,
  isGalaxyView,
  anglesForPhase,
  angularRadius,
  applyDrag,
  arcAnomaly,
  arcContinuation,
  arcPoint,
  arcSamples,
  applyLook,
  applyZoom,
  approachState,
  clampDistance,
  clampElevation,
  clampLatitude,
  clampPitch,
  clampStanceHeight,
  distanceBounds,
  DRAG_RADIANS_PER_PIXEL,
  DROP_SECONDS,
  dropBlend,
  dropLevel,
  dropProgress,
  dropRadius,
  type EntryArc,
  entryArc,
  findComposition,
  framingDistance,
  heightForScrub,
  horizonPitch,
  isCentred,
  localTriad,
  launchArc,
  type LookOffset,
  NO_LOOK,
  MIN_STANCE_HEIGHT,
  type ObserverState,
  observerPose,
  type Lens,
  PITCH_LIMIT,
  placeComposition,
  RISE_CLEARANCE,
  riseFov,
  riseStance,
  scrubForHeight,
  shortestAngle,
  stanceToward,
  type SurfaceStance,
  surfaceHeightBounds,
  surfaceStancePose,
  verticalFov,
  verticalFovDegrees,
  zoomFactorForNotches,
} from '@inertialref/rendering'
import { pairFrame } from './tracking.ts'
import type { PictureFraming } from './pictures.ts'
import { dragSensitivityOf } from './dragSensitivity.ts'
import { currentSystemOf, resolveDestination } from './travel.ts'
import type { Host } from './harness.ts'

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
export interface GalaxyJourneyStatus {
  readonly progress: number
  readonly destination: number
  readonly remainingSeconds: number
}

/** A drop in flight: how far down it is, and how long it has left. */
export interface DescentStatus {
  /** 0 at release, 1 on the ground. */
  readonly progress: number
  readonly remainingSeconds: number
}

/**
 * A drop in progress, in the body's rotating axes throughout.
 *
 * Body-fixed so the touchdown point stays put while the body turns under the
 * camera: the arc is solved once at release and read every frame, and a world
 * that rotates 0.02° in the eight seconds of an Earth drop rotates much more
 * under time warp — a target held in universe axes would land the camera
 * east of where the ring was drawn by however far the ground had moved.
 */
interface Descent {
  readonly arc: EntryArc
  /** The camera's orientation at release, in the body's rotating axes. */
  readonly from: Quat
  /** Unit vector from the centre to the touchdown point. */
  readonly ground: Vec3
  readonly latitude: Radians
  readonly longitude: Radians
  readonly seconds: Seconds
  elapsed: Seconds
  /** How much of the surface camera's roll is showing this frame, `[0, 1]`. */
  blend: number
}

export interface ObserverStatus {
  readonly time: number
  readonly heldTime: number | null
  readonly timePaused: boolean
  readonly timeScale: number
  readonly journey: GalaxyJourneyStatus | null
  /** Non-null exactly while a drop is flying. See `drop`. */
  readonly descent: DescentStatus | null
  readonly galaxyView: GalaxyView | null
  readonly target: ObserverTarget | null
  readonly tracking: ObserverTarget | null
  readonly state: ObserverState
  /** Where the head is turned, relative to what the pose aims at. */
  readonly look: LookOffset
  /** Whether the head is turned at all — what the panel's readout keys off. */
  readonly aimed: boolean
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

/**
 * How high a rise stands, as a fraction of the body's own radius.
 *
 * 0.063 puts the eye 110 km over Luna, which is where the Apollo 8 frame was
 * taken from — low enough that the horizon is a curve rather than a limb, high
 * enough that the parent clears ground the geology has not been built yet.
 * Relative to the radius rather than a fixed height, because the same fraction
 * has to make a picture on Phobos (710 m up) and on Ganymede (166 km).
 */
export const RISE_HEIGHT_RADII = 0.063

/**
 * How much of the frame the drop ring covers, radians of half-angle.
 *
 * Two degrees. A mark that says "here" has to be findable against a cratered
 * surface without claiming ground the camera is not landing on, and the only
 * size that holds across the six decades this gesture spans is an angular one.
 */
const RING_ANGLE = 0.035

/** Segments in either ring. Enough that a couple of degrees reads as a circle. */
const RING_SEGMENTS = 48

/**
 * How much of the frame the held figure's ring covers, radians of half-angle.
 *
 * Smaller than the ground ring's: this one sits near the eye and is the thing
 * the hand is moving, so it wants to be a cursor rather than a target. At 0.9°
 * it is about 25 px on a 900-line frame, which is a mark a pointer can be
 * inside without covering what it is aiming at.
 */
const HOLD_ANGLE = 0.016

/**
 * How far above the ground the figure hangs, as a share of the eye's altitude.
 *
 * A fifth. It has to be a share rather than a distance because the gesture is
 * used from a hundred body-radii out and from just above the orbit floor, and
 * the one thing the mark may not do is leave the frame at either end.
 */
const HOLD_ALTITUDE_SHARE = 0.2

/**
 * How far the ring floats over the ground it follows, as a share of its own
 * radius.
 *
 * Proportional, and it has to be. A fixed lift is a metre-scale number, and the
 * vertex buffer holding it is float32 at a planetary radius — where one step is
 * half a metre — so a two-metre lift is a handful of bits and the loop z-fights
 * with the patch drawing the same height. Worse at a limb, where the ground is
 * edge-on and any lift is foreshortened to nothing. A twelfth of the ring's own
 * radius is clear at every distance the gesture spans and still reads as lying
 * on the ground rather than hovering over it.
 */
const RING_LIFT_SHARE = 0.08

export interface DropAim {
  readonly latitude: Radians
  readonly longitude: Radians
  /** Launch samples and screen up, in body radii and body-fixed axes. */
  readonly launch?: readonly Vec3[]
  readonly up?: Vec3
}

export class Observatory {
  #time: number | null = null
  #timePaused = true
  #timeScale = 1
  get timePaused(): boolean {
    return this.#timePaused
  }
  get timeScale(): number {
    return this.#timeScale
  }
  setTimePaused(paused: boolean): void {
    this.#timePaused = paused
  }
  setTimeScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0 || scale > 100000)
      throw new Error('Invalid photographic time rate.')
    this.#timeScale = scale
  }
  advanceTime(seconds: number): void {
    if (this.#time !== null && !this.#timePaused) {
      const next = this.#time + Math.max(0, seconds) * this.#timeScale
      if (Math.abs(next) <= 3.15576e12) this.#time = next
      else this.#timePaused = true
    }
  }

  /** A held photographic instant, or the live simulation's presentation time. */
  get time(): number {
    return this.#time ?? this.#host.world.clock.renderTime
  }
  get heldTime(): number | null {
    return this.#time
  }
  setTime(time: number | null): void {
    if (
      time !== null &&
      (!Number.isFinite(time) || Math.abs(time) > 3.15576e12)
    )
      throw new Error('Choose a finite time within 100,000 years of J2000.')
    this.#time = time
    this.#timePaused = true
  }

  capture(): Extract<PictureFraming, { kind: 'camera' }> {
    if (this.#target === null || this.galaxyInstrument)
      throw new Error('Choose a planet, moon or star before saving a shot.')
    const transform = this.#trackingTransform()
    return {
      kind: 'camera',
      ...(transform.rotation === Q.IDENTITY
        ? {}
        : { basis: transform.rotation }),
      ...(this.#tracking === null
        ? {}
        : {
            tracking: {
              address: this.#tracking.target.address,
              referenceTime: this.time,
            },
          }),
      state: {
        ...this.#state,
        distance: this.#state.distance * transform.scale,
      },
      look: { ...this.#look },
      surface: this.#stance === null ? null : { ...this.#stance },
    }
  }

  validatePicture(address: string, framing: PictureFraming): void {
    const target = this.#resolve(address)
    if (framing.kind === 'camera') {
      if (framing.tracking !== undefined) {
        const tracked = this.#resolve(framing.tracking.address)
        if (
          framing.surface !== null ||
          tracked.address === target.address ||
          tracked.system !== target.system
        )
          throw new Error(
            'Tracking needs two different bodies in one system and an orbit camera.',
          )
        this.#pair(target, tracked, framing.tracking.referenceTime)
      }
      if (framing.surface !== null) {
        const body = this.#bodyOf(target)
        if (body === null || !hasSolidSurface(body))
          throw new Error('This preset has no solid surface to stand on.')
        if (
          framing.surface.height !==
          clampStanceHeight(framing.surface.height, body.radius)
        )
          throw new Error('This preset is outside the surface camera range.')
      } else if (framing.state.distance < target.radius) {
        throw new Error('This preset puts the camera inside its subject.')
      }
    }
  }

  restore(
    address: string,
    framing: Extract<PictureFraming, { kind: 'camera' }>,
  ): ObserverStatus {
    this.focus(address, { ease: false })
    if (framing.surface !== null) this.stand(undefined, framing.surface)
    this.#state = this.#desired = { ...framing.state }
    this.#look = { ...framing.look }
    this.#basis = framing.basis ?? Q.IDENTITY
    this.#tracking =
      framing.tracking === undefined
        ? null
        : {
            target: this.#resolve(framing.tracking.address),
            referenceTime: framing.tracking.referenceTime,
          }
    return this.status()
  }

  readonly #host: Host
  #target: ObserverTarget | null = null
  #basis: Quat = Q.IDENTITY
  #tracking: { target: ObserverTarget; referenceTime: number } | null = null

  #pair(anchor: ObserverTarget, target: ObserverTarget, time: number) {
    const a = this.#host.world.frames.pose(anchor.frame, time)
    const b = this.#host.world.frames.pose(target.frame, time)
    return pairFrame(
      UV.difference(b.position, a.position),
      Vec.sub(b.velocity, a.velocity),
    )
  }

  #trackingTransform(): { rotation: Quat; scale: number } {
    const held = this.#tracking
    if (
      held === null ||
      this.#target === null ||
      held.referenceTime === this.time
    )
      return { rotation: this.#basis, scale: 1 }
    const before = this.#pair(this.#target, held.target, held.referenceTime)
    const now = this.#pair(this.#target, held.target, this.time)
    return {
      rotation: Q.normalize(
        Q.multiply(
          Q.multiply(now.orientation, Q.conjugate(before.orientation)),
          this.#basis,
        ),
      ),
      // A shrinking pair cannot carry the observer below its safe orbit floor.
      scale:
        clampDistance(
          (this.#state.distance * now.distance) / before.distance,
          this.#target.radius,
        ) / this.#state.distance,
    }
  }

  /** Target a companion while keeping the current orbit anchor and composition. */
  track(address: string | null): ObserverStatus {
    const target = address === null ? null : this.#resolve(address)
    if (target !== null) {
      if (
        this.#target === null ||
        this.#stance !== null ||
        this.galaxyInstrument
      )
        throw new Error('Enter orbit before targeting another body.')
      if (
        target.address === this.#target.address ||
        target.system !== this.#target.system
      )
        throw new Error('Choose another body in this system.')
      this.#pair(this.#target, target, this.time)
    }
    const transform = this.#trackingTransform()
    this.#basis = transform.rotation
    this.#state = {
      ...this.#state,
      distance: this.#state.distance * transform.scale,
    }
    this.#desired = {
      ...this.#desired,
      distance: this.#desired.distance * transform.scale,
    }
    this.#tracking =
      target === null ? null : { target, referenceTime: this.time }
    this.#phaseOrbit = null
    return this.status()
  }

  /** Fit the pair inside the vertical field while retaining its orbit angles. */
  framePair(): void {
    if (this.#target === null || this.#tracking === null) return
    const pair = this.#pair(this.#target, this.#tracking.target, this.time)
    this.#look = NO_LOOK
    this.setDistance(
      framingDistance(
        pair.distance + this.#tracking.target.radius,
        verticalFovDegrees(this.#lens),
        0.8,
      ),
    )
  }

  #orbitPose(centre: UniverseVector): ObserverPose {
    const transform = this.#trackingTransform()
    const pose = observerPose(centre, this.#state, this.#look)
    if (transform.rotation === Q.IDENTITY && transform.scale === 1) return pose
    return {
      position: UV.translate(
        centre,
        Q.rotate(
          transform.rotation,
          Vec.scale(UV.difference(pose.position, centre), transform.scale),
        ),
      ),
      orientation: Q.normalize(
        Q.multiply(transform.rotation, pose.orientation),
      ),
    }
  }
  #galaxyView: GalaxyView | null = null
  #journey: {
    route: GalaxyJourneyRoute
    progress: number
    motion: {
      from: ObserverState
      to: number
      duration: number
      elapsed: number
    } | null
  } | null = null

  get galaxyInstrument(): boolean {
    return this.#galaxyView !== null || this.#journey !== null
  }

  get journey(): GalaxyJourneyStatus | null {
    const held = this.#journey
    return held === null
      ? null
      : {
          progress: held.progress,
          destination: held.motion?.to ?? held.progress,
          remainingSeconds:
            held.motion === null
              ? 0
              : held.motion.duration - held.motion.elapsed,
        }
  }

  travelGalaxy(progress: number, seconds: number): ObserverStatus {
    validateGalaxyJourney(progress, seconds)
    if (this.#journey === null) {
      this.focus('s:SOL/b:2', { ease: false })
      const earth = this.#targetPosition(this.#target!)
      if (earth === null) throw new Error('Earth has no presentation frame')
      const route = createGalaxyJourney(earth, this.#target!.radius)
      this.#state = this.#desired = galaxyJourneyState(route, 0)
      this.#journey = { route, progress: 0, motion: null }
    }
    const held = this.#journey
    held.motion =
      seconds === 0
        ? null
        : {
            from: this.#state,
            to: progress,
            duration: seconds,
            elapsed: 0,
          }
    if (held.motion === null) {
      held.progress = progress
      this.#state = this.#desired = galaxyJourneyState(held.route, progress)
      this.#look = NO_LOOK
    }
    return this.status()
  }

  /** Hold the displayed pose, including an orbit gesture made during the journey. */
  holdGalaxyJourney(): ObserverStatus {
    this.#stopJourneyTravel()
    this.#desired = this.#state
    return this.status()
  }

  #stopJourneyTravel(): void {
    const held = this.#journey
    if (held === null) return
    held.motion = null
    held.progress = galaxyJourneyProgress(held.route, this.#state.distance)
  }

  #advanceJourney(dt: Seconds): void {
    const held = this.#journey
    if (held === null) return
    const motion = held.motion
    if (motion === null) {
      held.progress = galaxyJourneyProgress(held.route, this.#state.distance)
      return
    }
    motion.elapsed = Math.min(motion.duration, motion.elapsed + Math.max(0, dt))
    // Repeated frame deltas may sum an ulp short of an exact endpoint.
    if (motion.duration - motion.elapsed < 1e-9)
      motion.elapsed = motion.duration
    const t = motion.elapsed / motion.duration
    const eased = t * t * (3 - 2 * t)
    const destination = galaxyJourneyState(held.route, motion.to)
    this.#state = this.#desired =
      t === 0
        ? motion.from
        : t === 1
          ? destination
          : {
              azimuth:
                motion.from.azimuth +
                shortestAngle(motion.from.azimuth, destination.azimuth) * eased,
              elevation:
                motion.from.elevation +
                (destination.elevation - motion.from.elevation) * eased,
              distance:
                motion.from.distance *
                (destination.distance / motion.from.distance) ** eased,
            }
    held.progress =
      t === 1
        ? motion.to
        : galaxyJourneyProgress(held.route, this.#state.distance)
    if (t === 1) held.motion = null
  }

  get galaxyView(): GalaxyView | null {
    return this.#galaxyView
  }

  viewGalaxy(view: GalaxyView): ObserverStatus {
    if (!isGalaxyView(view)) throw new Error('Unknown galaxy view')
    this.clear()
    this.#galaxyView = view
    return this.status()
  }
  #state: ObserverState = { azimuth: 0.6, elevation: 0.25, distance: 1e9 }
  #desired: ObserverState = this.#state
  #phaseOrbit: {
    phase: number
    rate: number
    tilt: number
  } | null = null
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
  /**
   * The drop in flight, when there is one.
   *
   * Rides the surface arm: while it is set, `#stance` is rewritten every frame
   * from the arc, so the orbit writers stay refused and `standing` is true from
   * the first frame. Cleared by whatever replaces the stance, and by landing.
   */
  #descent: Descent | null = null
  /** The point a drop is being aimed at. Presentation only; see `aim`. */
  #aim: DropAim | null = null
  /**
   * Where the head is turned, relative to whatever the pose aims at.
   *
   * The orbit arm aims at the target's center by construction, so without this
   * there is no way to look at a limb, at a moon beside the disk, or at the sky
   * at all. It is an *offset* rather than a replacement, so a composition still
   * means what it says and the viewer turns their head from there.
   *
   * **Cleared by whatever replaces the pose, and by nothing else.** A focus, a
   * frame, a home, a shot, a preset — those are new pictures. A drag, a dolly,
   * a wheel notch and leaving and re-entering the mode are not, so a viewer who
   * turned to look at Io beside Jupiter is still looking at Io after the wheel.
   * The surface arm keeps its offset in the stance's own heading and pitch,
   * which is what those two numbers already are.
   */
  #look: LookOffset = NO_LOOK

  constructor(host: Host) {
    this.#host = host
  }

  get target(): ObserverTarget | null {
    return this.#target
  }

  get state(): ObserverState {
    return {
      ...this.#state,
      distance: this.#state.distance * this.#trackingTransform().scale,
    }
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
    if (this.#galaxyView !== null)
      return GALAXY_VIEWS[this.#galaxyView].pose.position
    const target = this.#target
    if (target === null) return null
    // The surface arm first, because when it holds the camera the orbit state
    // underneath it is stale by design — a catalog sorting by distance from
    // "the viewer" while the viewer is standing on Iapetus must not sort by
    // where the viewer was before the descent.
    if (this.#stance !== null) return this.#surfacePose()?.position ?? null
    const centre = this.#targetPosition(target)
    return centre === null ? null : this.#orbitPose(centre).position
  }

  /**
   * The whole camera this instant — `eye` with its orientation — or null.
   *
   * A reading, not `sample()`, for the same reason `eye` is one: the drop
   * takes the camera as it stands at release, orientation included, and a
   * verb that stepped the ease to find out where the camera was would move
   * the thing it is measuring.
   */
  pose(): ObserverPose | null {
    if (this.#galaxyView !== null) return GALAXY_VIEWS[this.#galaxyView].pose
    const target = this.#target
    if (target === null) return null
    if (this.#stance !== null) return this.#surfacePose()
    const centre = this.#targetPosition(target)
    return centre === null ? null : this.#orbitPose(centre)
  }

  /**
   * The lens the framing math is solved against: the *flight* lens, always.
   *
   * Read from the host, never held here. A private copy pushed in once a frame
   * is a second idea of the optics kept in step only by nobody forgetting the
   * call, and the lens has one producer — `GameEngine`, under the pose's own
   * precedence.
   *
   * **Deliberately not the composed lens.** That one resolves cutscene-first,
   * and this arm produces a camera only when the cutscene arm is null, so
   * framing against a script's lens is the observatory depending on the arm it
   * is the fallback for. It is not a transient error either: `focus` and
   * `frameTarget` *store* the standoff they solve, so a `ir.goTo` typed while
   * `tng-intro` plays leaves the planetarium parked 29.8 Mm from Earth against
   * the 20.8 Mm the flight lens asks for — 43% too far, and nothing recomputes
   * it.
   *
   * The fallback is the flight preset because a headless host has no camera
   * panel, not because the value is uncertain.
   */
  get #lens(): Lens {
    return this.#host.render.framingLens()
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
    this.#galaxyView = null
    this.#journey = null
    this.#target = target
    this.#tracking = null
    this.#basis = Q.IDENTITY
    this.#phaseOrbit = null
    // Focusing something else is leaving the ground. A stance names a latitude
    // and a longitude on one particular body, so carrying it across a change of
    // target would put the camera at those coordinates on a different world.
    this.#descent = null
    this.#aim = null
    this.#stance = null
    this.#site = null
    // A focus is a new picture, so the head goes back to center. The other
    // three writers that replace a pose — `frameTarget`, `setAngles` and
    // `stand` — do the same; a drag, a dolly and a wheel notch do not.
    this.#look = NO_LOOK

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
    this.#time = null
    this.#journey = null
    this.#galaxyView = null
    this.#target = null
    this.#tracking = null
    this.#basis = Q.IDENTITY
    this.#phaseOrbit = null
    this.#descent = null
    this.#aim = null
    this.#stance = null
    this.#site = null
    this.#look = NO_LOOK
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
  /**
   * Orbit by a pointer drag, in pixels.
   *
   * The sensitivity defaults to the solved one rather than to 1, so a caller
   * that omits it gets the lens's own pixel angle instead of a 4.8× drag at the
   * flight lens. `turn` solves it internally for the same reason; the argument
   * survives for a script that wants a stated rate.
   */
  drag(
    dxPixels: number,
    dyPixels: number,
    sensitivity = this.dragSensitivity(),
  ): void {
    if (this.#stance !== null || this.#galaxyView !== null) return
    this.#stopJourneyTravel()
    // Both are written, not just the desired: a drag is direct manipulation and
    // must not lag a damping filter. Easing is for travel, not for the hand.
    this.#desired = applyDrag(this.#desired, dxPixels, dyPixels, sensitivity)
    this.#state = { ...this.#state, ...pick(this.#desired) }
  }

  /** Zoom by a ratio. Above 1 retreats. */
  zoom(factor: number): void {
    if (this.#stance !== null || this.#galaxyView !== null) return
    this.#stopJourneyTravel()
    const radius = this.#target?.radius ?? 0
    const scale = this.#trackingTransform().scale
    const actual = applyZoom(
      { ...this.#desired, distance: this.#desired.distance * scale },
      factor,
      radius,
    )
    this.#desired = { ...actual, distance: actual.distance / scale }
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
    if (this.#stance !== null || this.#galaxyView !== null) return
    this.#stopJourneyTravel()
    const radius = this.#target?.radius ?? 0
    this.#desired = {
      ...this.#desired,
      distance:
        clampDistance(distance, radius) / this.#trackingTransform().scale,
    }
    if (!ease) this.#state = this.#desired
  }

  /**
   * Set the orbit angles directly — the panel's presets and every composition.
   *
   * The one writer that takes a look offset with the angles, because a
   * composition that aims at a limb or a specular point is *two* numbers about
   * the pose and one about the head. Absent, the head goes back to center: a
   * composed picture replaces the pose, so carrying a viewer's free look into
   * it would frame something other than what the composition names.
   */
  setAngles(
    azimuth: number,
    elevation: number,
    ease = true,
    look: LookOffset = NO_LOOK,
  ): void {
    if (this.#stance !== null || this.#galaxyView !== null) return
    this.#stopJourneyTravel()
    this.#desired = {
      ...this.#desired,
      azimuth,
      elevation: clampElevation(elevation),
    }
    this.#look = look
    if (!ease) this.#state = this.#desired
  }

  /** Re-frame the current target so it fills `fill` of the frame height. */
  frameTarget(fill = DEFAULT_FILL): void {
    if (this.#target === null) return
    // `F` is a new picture of the subject, so the head comes back to it. This
    // is the difference between framing and dollying, and it is the whole
    // reason the two have separate verbs.
    this.#look = NO_LOOK
    this.setDistance(
      framingDistance(
        this.#target.radius,
        verticalFovDegrees(this.#lens),
        fill,
      ),
    )
  }

  /* --------------------------------------------------------------------- */
  /* Free look                                                              */
  /* --------------------------------------------------------------------- */

  /** Where the head is turned, relative to what the pose aims at. */
  get look(): LookOffset {
    return this.#look
  }

  /**
   * Turn the head by a drag, in pixels.
   *
   * On the ground the offset *is* the heading and the pitch, which the stance
   * already holds — so this is the one verb that writes through both arms, and
   * the orbit writers' refusal does not apply to it. That refusal is why this
   * verb exists: with it and nothing else listening, a drag on Miranda's summit
   * does nothing at all.
   *
   * `sensitivity` is `pixelAngle(lens, viewport) / DRAG_RADIANS_PER_PIXEL` when
   * a caller has a display, which makes the ground under the pointer follow the
   * pointer at any lens. Solved here rather than at the call site because the
   * observatory already reads the lens and a second reader of it is a second
   * idea of the optics.
   */
  turn(dxPixels: number, dyPixels: number): void {
    const sensitivity = this.dragSensitivity()
    const stance = this.#stance
    if (stance !== null) {
      const k = DRAG_RADIANS_PER_PIXEL * sensitivity
      this.#stance = {
        ...stance,
        // The same grab metaphor the orbit uses: the ground follows the hand.
        heading: stance.heading - dxPixels * k,
        pitch: clampPitch(stance.pitch + dyPixels * k),
      }
      return
    }
    this.#look = applyLook(this.#look, dxPixels, dyPixels, sensitivity)
  }

  /** Aim the head at an absolute offset, radians. `ir.aim`. */
  setLook(yaw: number, pitch: number): void {
    const stance = this.#stance
    if (stance !== null) {
      this.#stance = { ...stance, heading: yaw, pitch: clampPitch(pitch) }
      return
    }
    this.#look = { yaw, pitch: clampElevation(pitch) }
  }

  /** Back to whatever the pose aims at. */
  centre(): void {
    if (this.#stance !== null) {
      this.levelToHorizon()
      return
    }
    this.#look = NO_LOOK
  }

  /**
   * Radians of camera motion per pixel of pointer, over the reference rate.
   *
   * The one number every draggable camera reads; `dragSensitivity.ts` carries
   * the two pixel counts it reconciles and why a constant cannot.
   */
  dragSensitivity(): number {
    return dragSensitivityOf(this.#host.render)
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
  setPhase(phaseDeg: number, elevationDeg = 10, ease = true): void {
    const toStar = this.#starDirection()
    if (toStar === null) return
    const { azimuth, elevation } = anglesForPhase(
      Q.rotateInverse(this.#trackingTransform().rotation, toStar),
      phaseDeg,
      elevationDeg,
    )
    this.setAngles(azimuth, elevation, ease)
  }

  /**
   * An automatic phase sweep, in degrees per presented second, held while the
   * clock is paused.
   *
   * Presented rather than simulated seconds: the simulated clock runs at
   * whatever time warp a flight session left behind, and the front door,
   * which is the caller, is forbidden from changing that warp to fix it.
   */
  orbitPhase(phase: number, rate: number, tilt = 10): void {
    if (this.#target === null || this.#stance !== null) return
    this.#phaseOrbit = { phase, rate, tilt }
    this.setPhase(phase, tilt, false)
  }

  /** The band the current target permits. Panels draw sliders against it. */
  bounds(): { readonly min: Meters; readonly max: Meters } {
    return distanceBounds(this.#target?.radius ?? 0)
  }

  /**
   * Take a named composition of whatever is being looked at.
   *
   * The observatory's placer, beside the ship's. One list, two placers, and the
   * difference is what they move: `placeShot` teleports a hull and this moves a
   * camera, so `ir.shot('gibbous')` and `compose('gibbous')` end with the same
   * picture and only one of them changes canonical state.
   *
   * Which arm it lands on is `placeComposition`'s decision and it is a real
   * one: the orbit arm clamps at 1.5 radii, and `sunset` at 1.04 radii *is* a
   * stance four hundredths of a radius up. Three of the sixteen were ship-only
   * for exactly this reason before the surface arm existed to receive them.
   */
  compose(id: string): ObserverStatus {
    this.track(null)
    this.#basis = Q.IDENTITY
    const composition = findComposition(id)
    const body = this.#body()
    const toStar = this.#starDirection()
    if (body === null || toStar === null) {
      throw new Error(
        `${this.#target?.name ?? 'nothing'} has no star to compose against`,
      )
    }
    const placement = placeComposition(
      composition,
      body.radius,
      toStar,
      verticalFovDegrees(this.#lens),
    )
    if (placement.kind === 'orbit') {
      // The stance goes first: `setAngles` refuses while one is held, and a
      // composition above the floor is a claim about the orbit arm.
      this.#descent = null
      this.#stance = null
      this.#site = null
      this.setDistance(placement.distance)
      this.setAngles(
        placement.azimuth,
        placement.elevation,
        true,
        placement.look,
      )
      return this.status()
    }
    /*
     * The sun direction is in universe axes and a stance is in the body's own,
     * so the placement's `up` has to come back through the spin pose. Without
     * this a composition lands at the right angle to the star and on whatever
     * longitude the body happened to be showing at the instant it was solved,
     * which is a different place every time the same button is pressed.
     */
    const up = this.#toBodyFixed(placement.up)
    const forward = this.#toBodyFixed(placement.forward)
    if (up === null || forward === null)
      throw new Error(`${body.name} is not turning`)
    /*
     * *Both* directions come back through the spin pose, and then the heading
     * is solved.
     *
     * A heading is measured against a triad built on the pole of the axes it
     * was solved in, so it cannot be carried across a frame change. Solved
     * against universe north and applied against the body's own — which is
     * tilted by `axialTilt` — `sunset` aims 5.31° off the sunward limb on
     * Earth and `oblique` 14.36°, which is the whole subject of both pictures.
     * `pitch` would survive, being a dot product with `up`; it is solved here
     * anyway so there is one place the pair comes from.
     */
    const { latitude, longitude } = directionToGeodetic(up)
    const aimed = stanceToward(up, forward)
    return this.stand(this.#target?.address, {
      latitude,
      longitude,
      height: placement.height,
      heading: aimed.heading,
      pitch: aimed.pitch,
    })
  }

  /**
   * Stand on this body with its parent a stated clearance over the horizon.
   *
   * Earthrise, and the two-body composition it is the only example of. Every
   * other picture here is relative to whatever is under the camera; this one
   * names the *other* body, which is why it needs a verb of its own and why the
   * lens is solved with it — Earth is 1.9° across from Luna and Mars is 42.39°
   * from Phobos, and one focal length is not the picture for both.
   *
   * Returns the field of view it solved, because the caller has to fit it: the
   * observatory has no lens of its own by design (`#lens` says why), so the
   * host's `setFlightLens` carries it to the flight lens and the standoff
   * arithmetic here reads it back.
   */
  rise(
    options: { readonly clearance?: Radians; readonly height?: Meters } = {},
  ): { readonly status: ObserverStatus; readonly fovDeg: number } {
    const body = this.#body()
    if (body === null) throw new Error('The observatory is not on a body')
    const parent = this.#parentBody(body)
    if (parent === null) {
      throw new Error(`Nothing for ${body.name} to see rise`)
    }
    const toParent = this.#toBodyFixedOffset(parent)
    if (toParent === null) {
      throw new Error(`${parent.name} is not where ${body.name} can see it`)
    }
    const distance = Vec.length(toParent)
    const fovDeg = riseFov(parent.radius, distance)
    const height = clampStanceHeight(
      options.height ?? RISE_HEIGHT_RADII * body.radius,
      body.radius,
    )
    const stance = riseStance(
      body.radius,
      toParent,
      height,
      options.clearance ?? RISE_CLEARANCE,
      fovDeg,
    )
    const { latitude, longitude } = directionToGeodetic(stance.up)
    return {
      status: this.stand(this.#target?.address, {
        latitude,
        longitude,
        height: stance.height,
        heading: stance.heading,
        pitch: stance.pitch,
      }),
      fovDeg,
    }
  }

  /** The body this one goes round, when it is a moon of one. */
  #parentBody(body: Body): Body | null {
    try {
      const address = parseAddress(formatAddress(body.address))
      if (address.kind !== 'body') return null
      const system = this.#host.world.system(address.system)
      if (system === undefined) return null
      return parentOf(system, body)
    } catch {
      return null
    }
  }

  /** A universe-axes direction, in the body's own rotating axes. */
  #toBodyFixed(direction: Vec3): Vec3 | null {
    const body = this.#body()
    if (body === null) return null
    try {
      const spin = this.#host.world.frames.pose(
        bodyFixedFrameId(body.address),
        this.time,
      )
      return Q.rotateInverse(spin.orientation, direction)
    } catch {
      return null
    }
  }

  /**
   * The displacement to another body, in this one's rotating axes.
   *
   * A displacement rather than a direction, and `riseStance` says at length why
   * that matters: read as a direction the answer is wrong by up to
   * `asin((R + h)/d)`, which for Earth from Luna is 0.28° against a clearance
   * being solved for of 3°.
   *
   * `renderTime`, like everything else that places something for the picture.
   */
  #toBodyFixedOffset(other: Body): Vec3 | null {
    const body = this.#body()
    if (body === null) return null
    const world = this.#host.world
    try {
      const here = world.frames.pose(bodyFixedFrameId(body.address), this.time)
      const there = world.frames.pose(
        bodyFrameId(other.address),
        this.time,
      ).position
      return Q.rotateInverse(
        here.orientation,
        UV.difference(there, here.position),
      )
    } catch {
      return null
    }
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
    this.#journey = null
    this.track(null)
    this.#basis = Q.IDENTITY
    this.#descent = null
    this.#aim = null
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
    // The stance carries its own heading and pitch, so the orbit arm's offset
    // would come back on the ascent aimed at something nobody chose.
    this.#look = NO_LOOK
    log.info('observatory standing', {
      address: this.#target?.address,
      site: this.#site,
      height,
    })
    return this.status()
  }

  /** Back to orbit, at whatever framing the camera had before the descent. */
  leaveSurface(): ObserverStatus {
    // A drop in flight is abandoned, not finished: the orbit state underneath
    // is the one the camera left, so this is also how a drop is cancelled.
    this.#descent = null
    this.#aim = null
    this.#stance = null
    this.#site = null
    return this.status()
  }

  /**
   * Fly the camera from where it is down to a point on the ground, and stand
   * there facing the star.
   *
   * The one eased entry to the surface arm. `stand` cuts, and is right to: it
   * is the instrument a plate is captured through, and a plate has to be the
   * frame after the call returns. This is the other thing arriving can be — a
   * picture of it — and it is asked for by a different gesture, the figure
   * dragged from orbit onto a world. The path is the ballistic entry
   * `entryArc` describes, walked down `dropRadius`'s logarithmic schedule over
   * `seconds` of wall clock; the camera watches the touchdown point on the way
   * and turns to face the star along the horizon over the last third.
   *
   * Everything about the release is measured before anything commits, for the
   * reason `stand` gives at length: a refusal after a retarget would leave the
   * planetarium looking at a body the call declined. The eye and its
   * orientation are taken from the camera as it *is* — tracking transform and
   * look offset included — and carried into the body's rotating axes, so the
   * first frame of the drop is the frame before it and the arc lands where it
   * was aimed however far the body turns underneath.
   *
   * Presentation only, like every verb here: no teleport, no clock, no entity
   * write. `observatory.test.ts` compares the state hash across one.
   */
  drop(
    destination: string | undefined,
    point: { readonly latitude: Radians; readonly longitude: Radians },
    options: { readonly seconds?: Seconds } = {},
  ): ObserverStatus {
    const wanted =
      destination === undefined ? this.#target : this.#resolve(destination)
    if (wanted === null) {
      throw new Error('The observatory is not looking at anything')
    }
    const body = this.#bodyOf(wanted)
    if (body === null) throw new Error(`${wanted.name} is not a body`)
    if (!hasSolidSurface(body)) {
      throw new Error(`${body.name} has no surface to stand on`)
    }
    if (this.#stance !== null) {
      throw new Error('Already on the ground — leave the surface to drop again')
    }
    if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude)) {
      throw new Error('A drop needs a finite latitude and longitude')
    }
    const pose = this.pose()
    if (pose === null) {
      throw new Error('The observatory has no camera to drop from')
    }
    const spin = this.#spinOf(body)
    if (spin === null) {
      throw new Error(`${body.name} has no presentation frame`)
    }
    const latitude = clampLatitude(point.latitude)
    const longitude = point.longitude
    const ground = geodeticDirection(latitude, longitude)
    const eye = Q.rotateInverse(
      spin.orientation,
      UV.difference(pose.position, spin.position),
    )
    // The touchdown radius is the drawn ground plus eye height, so the arc
    // ends where the stance will stand rather than on the datum under it.
    const arc = entryArc(
      eye,
      Vec.scale(ground, drawnSurfaceRadius(body, ground) + MIN_STANCE_HEIGHT),
    )
    if (arc === null) {
      throw new Error(`The camera is not above ${body.name}'s ground`)
    }
    const from = Q.normalize(
      Q.multiply(Q.conjugate(spin.orientation), pose.orientation),
    )

    // Only now, and only if it is somewhere else — the ordering `stand` argues.
    if (wanted.address !== this.#target?.address) {
      this.focus(wanted.address, { ease: false })
    }
    this.#journey = null
    this.track(null)
    this.#basis = Q.IDENTITY
    this.#phaseOrbit = null
    this.#site = null
    // The stance carries the heading and the pitch from here on.
    this.#look = NO_LOOK
    this.#descent = {
      arc,
      from,
      ground,
      latitude,
      longitude,
      seconds: Math.max(0.1, options.seconds ?? DROP_SECONDS),
      elapsed: 0,
      blend: 0,
    }
    this.#aim = null
    this.#stance = this.#descentStance(0)
    log.info('observatory dropping', {
      address: this.#target?.address,
      latitude,
      longitude,
      altitude: formatDistance(arc.apoapsis - arc.touchdown),
    })
    return this.status()
  }

  /**
   * Where a ray from the eye meets a body's ground, as a latitude and
   * longitude, or null when it misses.
   *
   * The hit test behind the drop gesture. The pointer is a direction from the
   * camera, and the answer is a point on the *datum* sphere — `body.radius` —
   * rather than on the drawn terrain, because a fingertip is not aiming at a
   * ridge, and finding where a ray enters a heightfield means sampling the
   * field along it. The drop then lands on the drawn ground at that latitude
   * and longitude, which is what the ring drawn there promised.
   *
   * `direction` is in universe axes, which are also the render camera's:
   * render space is a translation and a radial compression about the eye, and
   * neither turns a direction. Nothing here reads a render position.
   */
  groundUnderRay(
    destination: string | undefined,
    direction: Vec3,
  ): {
    readonly address: string
    readonly latitude: Radians
    readonly longitude: Radians
  } | null {
    const target = this.#targetFor(destination)
    const body = this.#bodyOf(target)
    if (target === null || body === null || !hasSolidSurface(body)) return null
    const eye = this.eye
    const spin = this.#spinOf(body)
    if (eye === null || spin === null || Vec.length(direction) === 0)
      return null
    const relative = UV.difference(eye, spin.position)
    const along = Vec.normalize(direction)
    // |relative + t·along|² = R², the nearer root. No root is a miss; a
    // negative one is a body behind the eye or an eye already inside it.
    const b = Vec.dot(relative, along)
    const c = Vec.dot(relative, relative) - body.radius * body.radius
    const discriminant = b * b - c
    /*
     * A ray that misses answers with the limb rather than with nothing.
     *
     * Aiming *past* a world is how anybody reaches its edge: the near limb is
     * the one part of a sphere a pointer cannot land on from outside, because
     * the ray grazes it at a tangent and a pixel either way is the difference
     * between a hit and the sky. Refusing there makes the last few degrees of
     * every drop unreachable — and it is exactly where a person aims when they
     * want a horizon in the frame. So a miss is answered with the point on the
     * surface nearest the ray, which is continuous across the limb: the mark
     * slides onto the edge and stays there rather than blinking out.
     */
    const t = discriminant >= 0 ? -b - Math.sqrt(discriminant) : -b
    if (!(t > 0)) return null
    const hit = Vec.add(relative, Vec.scale(along, t))
    const { latitude, longitude } = directionToGeodetic(
      Q.rotateInverse(spin.orientation, hit),
    )
    return { address: target.address, latitude, longitude }
  }

  /**
   * The point a drop is being aimed at, or null when nothing is being aimed.
   *
   * Presentation state, set by whatever is holding the gesture and read by
   * whatever draws the aid — a hover, in the same sense the look offset is a
   * hover. It writes nothing canonical, it does not move the camera, and it is
   * cleared by everything that replaces the pose, so an aim cannot survive the
   * body it was taken over.
   */
  get aim(): DropAim | null {
    return this.#aim
  }

  previewDrop(
    point: { readonly latitude: Radians; readonly longitude: Radians } | null,
  ): void {
    this.#aim =
      point === null
        ? null
        : {
            latitude: clampLatitude(point.latitude),
            longitude: point.longitude,
          }
  }

  /** Aim by a held point in body radii. Gravity chooses the touchdown. */
  previewLaunch(hold: Vec3, up: Vec3): void {
    const body = this.#body()
    if (body === null || !hasSolidSurface(body) || Vec.length(hold) <= 1) {
      this.#aim = null
      return
    }
    const launch = [...launchArc(hold, up)]
    const end = launch.at(-1)
    if (end === undefined) {
      this.#aim = null
      return
    }
    const { latitude, longitude } = directionToGeodetic(end)
    const ground = geodeticDirection(latitude, longitude)
    launch[launch.length - 1] = Vec.scale(
      ground,
      (drawnSurfaceRadius(body, ground) + MIN_STANCE_HEIGHT) / body.radius,
    )
    this.#aim = { latitude, longitude, launch, up }
  }

  /** Scene geometry in body radii, sharing the landing coordinate with release. */
  entryArcPreview(
    destination: string | undefined,
    point: DropAim,
    samples = 48,
  ): {
    /** Every field below is body radii, in the body's own rotating axes. */
    readonly from: Vec3
    readonly hold: readonly Vec3[]
    readonly arc: readonly Vec3[]
    readonly through: readonly Vec3[]
    readonly ring: readonly Vec3[]
    readonly touchdown: Vec3
  } | null {
    const target = this.#targetFor(destination)
    const body = this.#bodyOf(target)
    if (body === null || !hasSolidSurface(body)) return null
    const eye = this.eye
    const spin = this.#spinOf(body)
    if (eye === null || spin === null) return null
    const ground = geodeticDirection(
      clampLatitude(point.latitude),
      point.longitude,
    )
    // The eye in the body's rotating axes, which is the frame the whole
    // preview is solved in — so the aim stays on the ground it was taken over
    // while the body turns under it.
    const local = Q.rotateInverse(
      spin.orientation,
      UV.difference(eye, spin.position),
    )
    if (point.launch !== undefined) {
      const from = point.launch[0]!
      const touchdown = point.launch.at(-1)!
      const unit = (offset: Vec3): Vec3 => Vec.scale(offset, 1 / body.radius)
      return {
        from,
        hold: this.#holdRing(Vec.scale(from, body.radius), local, point.up).map(
          unit,
        ),
        arc: point.launch,
        through: [],
        ring: this.#groundRing(
          body,
          ground,
          Vec.length(touchdown) * body.radius,
          eye,
        ).map(unit),
        touchdown,
      }
    }
    /*
     * The figure is held in the viewer's own orbit, above the point aimed at.
     *
     * Not at the eye, which is the version this replaces and the one that
     * cannot be drawn: an arc leaving from the camera starts behind the near
     * plane and spends most of its length off the sides of the frame, so what
     * a viewer sees of it is a few dashes arriving from nowhere. Held at the
     * eye's own radius it is a thing *in* the picture, at the altitude the
     * viewer is already at — which is what "in orbit" means here — and the
     * fall from it is a line with two visible ends.
     *
     * Directly above the aim, so the mark and the ground it names share a
     * vertical. The consequence is honest and worth stating: aim at the middle
     * of the disk and that vertical points at the camera, so the fall
     * foreshortens to almost nothing. Aim anywhere near a limb — which is
     * where a horizon comes from, and where anybody composing a picture aims —
     * and it is the full drop, drawn side-on.
     */
    const groundRadius = drawnSurfaceRadius(body, ground)
    /*
     * How high the figure is held: a share of the viewer's own altitude, not
     * the viewer's own radius.
     *
     * Held at the full orbital radius the mark is 3.3 body-radii out at Earth,
     * which is off the side of a 65° frame — the figure leaves the picture
     * exactly when the aim reaches the limb, which is where the aim is most
     * often pointed. A fifth of the altitude puts it a half-radius clear of
     * the ground: outside the disk when the aim is near a limb, so the fall is
     * drawn side-on, and still in frame.
     */
    const altitude = Math.max(
      body.radius * 0.02,
      (Vec.length(local) - body.radius) * HOLD_ALTITUDE_SHARE,
    )
    const arc = entryArc(
      Vec.scale(ground, groundRadius + altitude),
      Vec.scale(ground, groundRadius + MIN_STANCE_HEIGHT),
    )
    if (arc === null) return null
    /*
     * Body radii, in the body's own rotating axes — not universe positions.
     *
     * The aid hugs a body, and a body is not drawn where its metric position
     * says: render compression pulls it nearer and shrinks it so its angular
     * size survives, and `placement.scale` is the radius it comes out at. A
     * point placed by its *own* compression therefore lands at a different
     * depth from the sphere it is supposed to be lying on — which is why a
     * ring built that way sank inside the planet and vanished. Handed back
     * normalized, the drawer can put it through the body's own placement, the
     * way a terrain patch already is, and one unit is exactly the drawn
     * surface.
     */
    const unit = (offset: Vec3): Vec3 => Vec.scale(offset, 1 / body.radius)
    const whole = arcSamples(arc, samples)
    const touchdown = arcPoint(arc, arc.sweep, arc.touchdown)
    const from = whole[0] ?? touchdown
    return {
      from: unit(from),
      hold: this.#holdRing(from, local).map(unit),
      arc: whole.map(unit),
      through: arcContinuation(arc, samples).map(unit),
      ring: this.#groundRing(body, ground, arc.touchdown, eye).map(unit),
      touchdown: unit(touchdown),
    }
  }

  /**
   * The loop drawn around the held figure, facing the eye.
   *
   * A ring on a plane perpendicular to the line of sight, so it reads as a
   * circle from where the viewer is standing rather than as an ellipse edge-on
   * — this one is a marker rather than a place, and a marker that foreshortens
   * to a line has stopped marking anything. The ground ring is the opposite
   * case and is deliberately laid flat: it *is* a place.
   *
   * Angular, like the ground ring, and for the same reason: the gesture spans
   * six decades of distance and no fixed size survives that.
   */
  #holdRing(at: Vec3, eye: Vec3, screenUp?: Vec3): readonly Vec3[] {
    const toEye = Vec.sub(eye, at)
    const range = Vec.length(toEye)
    if (!(range > 0)) return []
    const forward = Vec.scale(toEye, 1 / range)
    const seed =
      screenUp ?? (Math.abs(forward.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0))
    const right = Vec.normalize(Vec.cross(seed, forward))
    const up = Vec.cross(forward, right)
    const across = range * HOLD_ANGLE
    const out: Vec3[] = []
    for (let index = 0; index <= RING_SEGMENTS; index += 1) {
      const angle = (index / RING_SEGMENTS) * Math.PI * 2
      out.push(
        Vec.add(
          at,
          Vec.add(
            Vec.scale(right, Math.cos(angle) * across),
            Vec.scale(up, Math.sin(angle) * across),
          ),
        ),
      )
    }
    return out
  }

  /**
   * A loop on the ground around a direction, following the terrain under it.
   *
   * Its radius is **angular from the eye, not fixed in meters**, and that is
   * the whole of its legibility: a ring sized in meters is a few pixels across
   * from orbit and swallows the horizon from two meters up, and the gesture
   * that draws it spans exactly that range. Two degrees of the frame, capped
   * at a share of the body so it cannot wrap a small moon.
   *
   * Every point is sampled against `drawnSurfaceRadius`, so the loop lies on
   * the ground rather than on the datum — on a slope the two are a kilometre
   * apart, and a ring that floated over a crater rim would be pointing at
   * somewhere the camera does not land.
   */
  #groundRing(
    body: Body,
    centre: Vec3,
    touchdownRadius: Meters,
    eye: UniverseVector,
  ): readonly Vec3[] {
    const spin = this.#spinOf(body)
    if (spin === null) return []
    const local = Q.rotateInverse(
      spin.orientation,
      UV.difference(eye, spin.position),
    )
    const range = Math.max(
      1,
      Vec.length(Vec.sub(local, Vec.scale(centre, touchdownRadius))),
    )
    const across = Math.min(body.radius * 0.22, range * RING_ANGLE)
    // The angle the ring subtends at the body's centre, which is what turns a
    // distance across the ground into a rotation of the direction.
    const sweep = Math.min(Math.PI / 3, across / body.radius)
    const triad = localTriad(centre)
    const out: Vec3[] = []
    for (let index = 0; index <= RING_SEGMENTS; index += 1) {
      const angle = (index / RING_SEGMENTS) * Math.PI * 2
      const offset = Vec.add(
        Vec.scale(triad.east, Math.cos(angle)),
        Vec.scale(triad.north, Math.sin(angle)),
      )
      /*
       * Back through a latitude, which is what carries the `body-fixed` brand
       * the terrain sampler demands. The round trip agrees to a float and is
       * the only spelling that proves the direction is in the axes the
       * mountains are in — see `#descentStance`, which pays the same toll.
       */
      const turned = Vec.add(
        Vec.scale(centre, Math.cos(sweep)),
        Vec.scale(offset, Math.sin(sweep)),
      )
      const { latitude, longitude } = directionToGeodetic(turned)
      const direction = geodeticDirection(latitude, longitude)
      out.push(
        Vec.scale(
          direction,
          drawnSurfaceRadius(body, direction) + across * RING_LIFT_SHARE,
        ),
      )
    }
    return out
  }

  /** The target a verb names, or the one held; null rather than a throw. */
  #targetFor(destination: string | undefined): ObserverTarget | null {
    if (destination === undefined) return this.#target
    try {
      return this.#resolve(destination)
    } catch {
      return null
    }
  }

  /** A body's rotating frame at the presentation instant, or null. */
  #spinOf(body: Body): { position: UniverseVector; orientation: Quat } | null {
    try {
      return this.#host.world.frames.pose(
        bodyFixedFrameId(body.address),
        this.time,
      )
    } catch {
      return null
    }
  }

  /** The star's bearing at a point on the ground, or null with no star. */
  #starHeadingAt(direction: Vec3): Radians | null {
    const toStar = this.#starDirection()
    const local = toStar === null ? null : this.#toBodyFixed(toStar)
    return local === null ? null : stanceToward(direction, local).heading
  }

  /**
   * The stance a drop is at, `progress` of the way down.
   *
   * Position from the arc at the schedule's radius, held at least eye height
   * over the drawn ground under it — the conic is solved against the touchdown
   * point's ground and a ridge on the way can stand higher. The aim is the
   * touchdown point, until the last third turns it to the star along the
   * horizon. As the camera comes down the touchdown falls toward the nadir, and
   * the bearing of a point nearly under the eye is a number that swings with
   * every meter of sideways travel — so the heading is also eased toward the
   * star's as the pitch steepens, which is where the swing would otherwise be
   * loudest. The last frame is written outright from the point that was asked
   * for, so a drop lands on the coordinates it was given and not on the
   * arithmetic's account of them.
   */
  #descentStance(progress: number): SurfaceStance {
    const descent = this.#descent
    const body = this.#body()
    if (descent === null || body === null) {
      return (
        this.#stance ?? {
          latitude: 0,
          longitude: 0,
          height: MIN_STANCE_HEIGHT,
          heading: 0,
          pitch: 0,
        }
      )
    }
    const starHeading = this.#starHeadingAt(descent.ground)
    if (progress >= 1) {
      return {
        latitude: descent.latitude,
        longitude: descent.longitude,
        height: MIN_STANCE_HEIGHT,
        heading: starHeading ?? 0,
        pitch: clampPitch(horizonPitch(body.radius, MIN_STANCE_HEIGHT)),
      }
    }
    const radius = dropRadius(descent.arc, progress)
    const { latitude, longitude } = directionToGeodetic(
      arcPoint(descent.arc, arcAnomaly(descent.arc, radius), radius),
    )
    /*
     * Back through `geodeticDirection` rather than normalizing the arc point.
     * The two agree to a float, and only one of them carries the `body-fixed`
     * brand the terrain sampler demands — which is the brand's whole job: a
     * direction that has been round-tripped through a latitude is provably in
     * the axes the mountains are in.
     */
    const direction = geodeticDirection(latitude, longitude)
    const groundRadius = drawnSurfaceRadius(body, direction)
    const height = Math.max(MIN_STANCE_HEIGHT, radius - groundRadius)
    const here = Vec.scale(direction, groundRadius + height)
    const touchdown = Vec.scale(descent.ground, descent.arc.touchdown)
    const toGround = Vec.sub(touchdown, here)
    // A nearby aim still has a bearing. Switching it at a distance threshold
    // cuts the head before `dropLevel` has finished its turn to the horizon.
    // Only coincident points lack a direction; the endpoint owns that pose.
    const aim =
      Vec.length(toGround) > 0
        ? stanceToward(direction, toGround)
        : { heading: starHeading ?? 0, pitch: -PITCH_LIMIT }
    // Steepness in [0, 1]: 0 while the touchdown is within 60° of the
    // horizon, 1 by the time it is 5° from straight down.
    const steep = Math.max(
      0,
      Math.min(1, (-aim.pitch - Math.PI / 3) / (PITCH_LIMIT - Math.PI / 3)),
    )
    const level = dropLevel(progress)
    const turn = Math.max(level, steep * steep * (3 - 2 * steep))
    const heading =
      starHeading === null
        ? aim.heading
        : aim.heading + shortestAngle(aim.heading, starHeading) * turn
    const pitch =
      aim.pitch + (horizonPitch(body.radius, height) - aim.pitch) * level
    return { latitude, longitude, height, heading, pitch: clampPitch(pitch) }
  }

  #advanceDescent(dt: Seconds): void {
    const descent = this.#descent
    if (descent === null) return
    descent.elapsed += Math.max(0, dt)
    const progress = dropProgress(descent.elapsed, descent.seconds)
    descent.blend = dropBlend(progress)
    this.#stance = this.#descentStance(progress)
    if (progress >= 1) {
      this.#descent = null
      log.info('observatory landed', {
        address: this.#target?.address,
        latitude: descent.latitude,
        longitude: descent.longitude,
      })
    }
  }

  #descentStatus(): DescentStatus | null {
    const descent = this.#descent
    if (descent === null) return null
    return {
      progress: dropProgress(descent.elapsed, descent.seconds),
      remainingSeconds: Math.max(0, descent.seconds - descent.elapsed),
    }
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
    const scale = this.#trackingTransform().scale
    const distance = this.#state.distance * scale
    const altitude = Math.max(0, distance - radius)
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
    // A ratio of two angles, so it is taken in radians and `angularRadius`
    // owns the half of it that `lod.ts` also asks for. Written out in degrees
    // it carries two 180/π factors that cancel, which is one edit away from
    // the panel and the LOD tier disagreeing about a body's angular size.
    const fill =
      surface !== null
        ? 1
        : radius > 0 && distance > radius
          ? (2 * angularRadius(radius, distance)) / verticalFov(this.#lens)
          : 0
    return {
      time: this.time,
      heldTime: this.heldTime,
      timePaused: this.timePaused,
      timeScale: this.timeScale,
      journey: this.journey,
      descent: this.#descentStatus(),
      galaxyView: this.#galaxyView,
      target: this.#target,
      tracking: this.#tracking?.target ?? null,
      state: { ...this.#state, distance },
      desired: { ...this.#desired, distance: this.#desired.distance * scale },
      look: this.#look,
      aimed: !isCentred(this.#look),
      travelling:
        this.#galaxyView === null &&
        (this.#descent !== null ||
          this.#journey?.motion != null ||
          !this.#arrived()),
      // Standing, the reader wants the height above the ground under their feet
      // — not the distance from a datum the orbit arm was last left at.
      altitude: surface?.stance.height ?? altitude,
      altitudeText: formatReading(surface?.stance.height ?? altitude),
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
    if (this.#galaxyView !== null) return GALAXY_VIEWS[this.#galaxyView].pose
    const target = this.#target
    if (target === null) return null
    // A drop rewrites the stance every frame from its arc and the wall clock,
    // and lands by clearing itself. Before the short-circuit below, because it
    // is the one motion the surface arm has.
    if (this.#descent !== null) this.#advanceDescent(dt)
    // The surface arm short-circuits the ease entirely. See `stand`.
    if (this.#stance !== null) return this.#surfacePose()

    const orbit = this.#phaseOrbit
    if (orbit !== null) {
      if (!this.#host.world.clock.paused)
        orbit.phase += orbit.rate * Math.max(0, dt)
      // A solved sweep has no trailing ease: a held simulated instant must
      // hold the whole picture, including the camera, on its first frame.
      this.setPhase(orbit.phase, orbit.tilt, false)
    }

    this.#advanceJourney(dt)
    if (!this.#arrived()) {
      this.#state = approachState(this.#state, this.#desired, dt, TRAVEL_TAU)
    } else {
      this.#state = this.#desired
    }

    const centre = this.#targetPosition(target)
    if (centre === null) return null
    return this.#orbitPose(centre)
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
      return world.frames.pose(target.frame, this.time).position
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
      spin = world.frames.pose(bodyFixedFrameId(body.address), this.time)
    } catch {
      return null
    }
    const up = geodeticDirection(stance.latitude, stance.longitude)
    /*
     * The **drawn** radius, not the contact test's.
     *
     * A stance is a height above the ground the viewer can see, and since Phase
     * 4 the ground the viewer can see carries a presentational tail the contact
     * test does not — up to `drawnDivergence`, which is 1.25 m. Stood
     * against `surfaceRadius` at a two-meter stance, the eye sits 0.4 m over the
     * plain in one place and inside a crater rim in the next, which is the
     * divergence made visible in exactly the picture the phase is judged from.
     * The ship still lands on `surfaceRadius`: physics may not read a term the
     * renderer is free to change.
     */
    const { offset, orientation } = surfaceStancePose(
      up,
      drawnSurfaceRadius(body, up),
      stance,
    )
    const aimed = Q.multiply(spin.orientation, orientation)
    /*
     * During a drop the roll is blended in from the orbit camera's. The orbit
     * arm keeps the pole up and this arm keeps the local vertical up, and at
     * release the two can differ by the co-latitude; slerping between the
     * orientation the camera had and the one the stance wants, over the first
     * fifth of the descent, is what keeps the horizon from snapping on the
     * frame the figure is let go.
     */
    const descent = this.#descent
    return {
      position: UV.translate(spin.position, Q.rotate(spin.orientation, offset)),
      orientation:
        descent === null || descent.blend >= 1
          ? aimed
          : Q.slerp(
              Q.normalize(Q.multiply(spin.orientation, descent.from)),
              aimed,
              descent.blend,
            ),
    }
  }

  #surfaceStatus(): SurfaceStatus | null {
    const stance = this.#stance
    const body = this.#body()
    if (stance === null || body === null) return null
    const up = geodeticDirection(stance.latitude, stance.longitude)
    // One elevation sample, not two. `drawnSurfaceRadius` is `datumRadius +
    // drawnElevation`, so asking for both the radius and the elevation the way
    // they read is fourteen octaves of noise run twice, eight times a second.
    // The drawn one, because this is the number under the altitude readout and
    // the stance above stands on it.
    const elevation = drawnElevation(body.surface, up)
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
       * Ground section prints it directly under site buttons showing
       * `SurveySite.elevation`, which is the same quantity — the same place,
       * two numbers, kilometers apart.
       *
       * It is the **drawn** field and the site's is canonical, so the two are
       * still not the same number: up to `drawnDivergence`, 1.25 m on Luna.
       * That is the right side to be on — the readout is under an altitude the
       * stance above stands on, and the stance is drawn — and it is the site
       * that has the wrong field, which is `surveySites` to fix and not this.
       */
      groundElevation: elevation,
      radius: datumRadius(body, up) + elevation + stance.height,
      heightText: formatReading(stance.height),
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
        this.time,
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
      detail: `${body.kind} · ${body.provenance} · ${formatReading(
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
