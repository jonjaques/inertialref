import {
  formatDistance,
  formatReading,
  getLogger,
  type Meters,
  type Radians,
  type Seconds,
} from '@inertialref/shared'
import {
  type Quat,
  Quaternion as Q,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  type Body,
  bodyFixedFrameId,
  datumRadius,
  directionToGeodetic,
  drawnElevation,
  drawnSurfaceRadius,
  findBody,
  geodeticDirection,
  hasSolidSurface,
  parseAddress,
  type SurveySite,
  surveySites,
} from '@inertialref/universe'
import {
  clampLatitude,
  clampPitch,
  clampStanceHeight,
  DROP_SECONDS,
  dropBlend,
  dropProgress,
  entryArc,
  heightForScrub,
  horizonPitch,
  launchArc,
  MIN_STANCE_HEIGHT,
  scrubForHeight,
  stanceToward,
  type SurfaceStance,
  surfaceHeightBounds,
  surfaceStancePose,
} from '@inertialref/rendering'
import type { Host } from './host.ts'
import {
  type Descent,
  descentStance,
  type DropAim,
  type EntryArcPreview,
  entryArcPreview,
  flightStep,
  type StanceFlight,
} from './stanceGeometry.ts'

/*
 * The surface arm: the planetarium's camera when it stands on a body.
 *
 * The observatory has two arms that can produce a camera — an orbit about a
 * target and a stance on its ground — and this is the second. It owns the
 * stance and everything that only means something down here: the survey site
 * the stance was set from, the keys held against it, a drop in flight, and the
 * point a drop is being aimed at. The observatory holds one of these, forwards
 * the verbs, and asks it for a pose and a status wherever it asks whether a
 * stance is held.
 *
 * It is built over `Host` and a port the observatory implements beside it,
 * because the arm needs what only the observatory knows: what it is looking
 * at, how a typed address resolves and how to focus one, how to take the
 * camera from the orbit arm, the camera as it stands, the photographic
 * instant, where the star is, and when an edit counts. `SurfacePort` lists
 * them. `declareCut()` is called where the cut is made,
 * so a reader of a verb sees the cut beside the change it covers.
 *
 * Read-only like the observatory: no teleport, no clock, no entity write.
 */

const log = getLogger('devtools.observatory')

/** A camera pose in universe coordinates: where the eye is, and where it looks. */
export interface SurfacePose {
  readonly position: UniverseVector
  readonly orientation: Quat
}

/** What the arm needs to know about the observatory's target. */
export interface SurfaceTarget {
  readonly address: string
  readonly name: string
  readonly kind: 'star' | 'planet' | 'moon'
  /** Meters. A star's own radius, a body's equatorial radius. */
  readonly radius: Meters
}

/** What the observatory supplies the arm. */
export interface SurfacePort {
  /** What the observatory is looking at, or null. */
  target(): SurfaceTarget | null
  /** Anything a human names, as a target. Throws on what names nothing. */
  resolve(destination: string): SurfaceTarget
  /** Look at another address with no ease: the step before standing on it. */
  focus(address: string): void
  /**
   * Take the camera from the orbit arm: no galaxy journey, no companion, no
   * basis, no phase sweep, and the head back to center — the stance carries
   * its own heading and pitch, so an orbit offset would come back on the
   * ascent aimed at something nobody chose.
   */
  enter(): void
  /** The camera as it is this instant, whichever arm or instrument holds it. */
  pose(): SurfacePose | null
  eye(): UniverseVector | null
  /** The photographic instant every pose here is taken at. */
  time(): number
  /** Unit vector toward the target's star, in the held body's rotating axes. */
  starInBody(): Vec3 | null
  /** An explicit edit: the observatory counts it, unless it is sampling. */
  changed(): void
  /** A presentation motion that moved the picture while sampling. */
  moved(): void
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

/** A drop in flight: how far down it is, and how long it has left. */
export interface DescentStatus {
  /** 0 at release, 1 on the ground. */
  readonly progress: number
  readonly remainingSeconds: number
}

/**
 * The body a target names, or null when it is a star or has gone away.
 *
 * Resolved on demand rather than held on the target, because a `Body` is a
 * snapshot of a generated system and the world underneath can be replaced by
 * a save load. A held reference would keep the camera standing on a mountain
 * belonging to a universe that no longer exists.
 */
export function bodyOf(
  world: World,
  target: Pick<SurfaceTarget, 'address' | 'kind'> | null,
): Body | null {
  if (target === null || target.kind === 'star') return null
  try {
    const address = parseAddress(target.address)
    if (address.kind !== 'body') return null
    const system = world.system(address.system)
    if (system === undefined) return null
    return findBody(system, address.body) ?? null
  } catch {
    return null
  }
}

export class SurfaceArm {
  readonly #host: Host
  readonly #port: SurfacePort
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
   * The keys held against the stance, in its own heading: forward, right and
   * up in -1..1, and whether the fast modifier is down. Null when nothing is
   * held. Applied by `advance`, so a flight is a presentation motion like the
   * fly-to ease and never a write to the world — the planetarium keeps its
   * promise while the viewer crosses a continent.
   */
  #flight: StanceFlight | null = null
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

  constructor(host: Host, port: SurfacePort) {
    this.#host = host
    this.#port = port
  }

  /** Whether the camera is on the ground rather than in orbit. */
  get standing(): boolean {
    return this.#stance !== null
  }

  /** The stance, while one is held. */
  get stance(): SurfaceStance | null {
    return this.#stance
  }

  /** Whether a drop is in flight. */
  get descending(): boolean {
    return this.#descent !== null
  }

  /** Off the ground and out of any drop or aim: a new picture replaces all of it. */
  reset(): void {
    this.#descent = null
    this.#aim = null
    this.#stance = null
    this.#site = null
  }

  /** Off the ground, for a composition the orbit arm takes. The aim is kept. */
  clearStance(): void {
    this.#descent = null
    this.#stance = null
    this.#site = null
  }

  /** Stop a drop where it is, and drop the aim. The stance it reached stays. */
  halt(): void {
    this.#descent = null
    this.#aim = null
  }

  /**
   * Turn the stance by a drag at `k` radians a pixel. False when nothing is
   * held, so the caller turns the orbit's head instead.
   */
  turn(dxPixels: number, dyPixels: number, k: number): boolean {
    const stance = this.#stance
    if (stance === null) return false
    this.#stance = {
      ...stance,
      // The same grab metaphor the orbit uses: the ground follows the hand.
      heading: stance.heading - dxPixels * k,
      pitch: clampPitch(stance.pitch + dyPixels * k),
    }
    return true
  }

  /** Aim the stance at a bearing and an elevation. False when nothing is held. */
  look(heading: number, pitch: number): boolean {
    const stance = this.#stance
    if (stance === null) return false
    this.#stance = { ...stance, heading, pitch: clampPitch(pitch) }
    return true
  }

  /**
   * One frame of the arm's two motions: a drop, which rewrites the stance
   * from its arc and the wall clock and lands by clearing itself, or else the
   * held keys.
   */
  advance(dt: Seconds): void {
    if (this.#descent !== null) this.#advanceDescent(dt)
    else if (this.#flight !== null) this.#advanceFlight(dt)
  }

  #body(): Body | null {
    return bodyOf(this.#host.world, this.#port.target())
  }

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
  ): void {
    this.#port.changed()
    const wanted =
      destination === undefined
        ? this.#port.target()
        : this.#port.resolve(destination)
    if (wanted === null) {
      throw new Error('The observatory is not looking at anything')
    }
    const body = bodyOf(this.#host.world, wanted)
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
    if (wanted.address !== this.#port.target()?.address) {
      this.#port.focus(wanted.address)
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
    this.#port.enter()
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
    this.#host.render.declareCut()
    log.info('observatory standing', {
      address: this.#port.target()?.address,
      site: this.#site,
      height,
    })
  }

  /**
   * Fly the stance with the keys: axes in the stance's own heading, -1..1.
   *
   * The speed follows the height, a brisk walk two meters up and the whole
   * planet in reach from the orbit floor, so one set of keys serves the
   * shoreline and the crossing to the next continent. The heading is where
   * the head is turned, which is what free look already sets; the keys do
   * not turn it, so a viewer looking at a peak flies toward the peak.
   */
  setStanceFlight(flight: StanceFlight | null): void {
    const held =
      flight === null ||
      (flight.forward === 0 && flight.right === 0 && flight.up === 0)
        ? null
        : {
            forward: Math.max(-1, Math.min(1, flight.forward)),
            right: Math.max(-1, Math.min(1, flight.right)),
            up: Math.max(-1, Math.min(1, flight.up)),
            fast: flight.fast,
          }
    if (
      held !== null &&
      ![held.forward, held.right, held.up].every(Number.isFinite)
    )
      return
    this.#flight = held
  }

  #advanceFlight(dt: Seconds): void {
    const flight = this.#flight
    const stance = this.#stance
    const body = this.#body()
    if (flight === null || stance === null || body === null) return
    const step = flightStep(stance, flight, body.radius, dt)
    if (step === null) return
    this.#stance = {
      ...stance,
      latitude: step.latitude,
      longitude: step.longitude,
    }
    if (flight.up !== 0) this.setStanceHeight(step.height)
    // A flight moves the picture as surely as a drag does, and the address
    // bar follows the revision; `#changed` stays quiet while sampling.
    this.#port.moved()
  }

  /** Back to orbit, at whatever framing the camera had before the descent. */
  leaveSurface(): void {
    if (this.#stance !== null || this.#descent !== null)
      this.#host.render.declareCut()
    this.#port.changed()
    // A drop in flight is abandoned, not finished: the orbit state underneath
    // is the one the camera left, so this is also how a drop is canceled.
    this.#descent = null
    this.#aim = null
    this.#stance = null
    this.#site = null
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
  ): void {
    this.#port.changed()
    const wanted =
      destination === undefined
        ? this.#port.target()
        : this.#port.resolve(destination)
    if (wanted === null) {
      throw new Error('The observatory is not looking at anything')
    }
    const body = bodyOf(this.#host.world, wanted)
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
    const pose = this.#port.pose()
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
    if (wanted.address !== this.#port.target()?.address) {
      this.#port.focus(wanted.address)
    }
    // The stance carries the heading and the pitch from here on.
    this.#port.enter()
    this.#site = null
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
      address: this.#port.target()?.address,
      latitude,
      longitude,
      altitude: formatDistance(arc.apoapsis - arc.touchdown),
    })
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
    const body = bodyOf(this.#host.world, target)
    if (target === null || body === null || !hasSolidSurface(body)) return null
    const eye = this.#port.eye()
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
  ): EntryArcPreview | null {
    const target = this.#targetFor(destination)
    const body = bodyOf(this.#host.world, target)
    if (body === null || !hasSolidSurface(body)) return null
    const eye = this.#port.eye()
    const spin = this.#spinOf(body)
    if (eye === null || spin === null) return null
    // The eye in the body's rotating axes, which is the frame the whole
    // preview is solved in — so the aim stays on the ground it was taken over
    // while the body turns under it.
    const local = Q.rotateInverse(
      spin.orientation,
      UV.difference(eye, spin.position),
    )
    return entryArcPreview(body, local, point, samples)
  }

  /** The target a verb names, or the one held; null rather than a throw. */
  #targetFor(destination: string | undefined): SurfaceTarget | null {
    if (destination === undefined) return this.#port.target()
    try {
      return this.#port.resolve(destination)
    } catch {
      return null
    }
  }

  /** A body's rotating frame at the presentation instant, or null. */
  #spinOf(body: Body): { position: UniverseVector; orientation: Quat } | null {
    try {
      return this.#host.world.frames.pose(
        bodyFixedFrameId(body.address),
        this.#port.time(),
      )
    } catch {
      return null
    }
  }

  /** The star's bearing at a point on the ground, or null with no star. */
  #starHeadingAt(direction: Vec3): Radians | null {
    const local = this.#port.starInBody()
    return local === null ? null : stanceToward(direction, local).heading
  }

  /** The stance a drop is at, `progress` of the way down. See `descentStance`. */
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
    return descentStance(
      body,
      descent,
      progress,
      this.#starHeadingAt(descent.ground),
    )
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
        address: this.#port.target()?.address,
        latitude: descent.latitude,
        longitude: descent.longitude,
      })
    }
  }

  descentStatus(): DescentStatus | null {
    const descent = this.#descent
    if (descent === null) return null
    return {
      progress: dropProgress(descent.elapsed, descent.seconds),
      remainingSeconds: Math.max(0, descent.seconds - descent.elapsed),
    }
  }

  /** Move the stance without changing the height or the heading. */
  moveTo(site: string | { latitude: Radians; longitude: Radians }): void {
    this.#port.changed()
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
    this.#port.changed()
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
    this.#port.changed()
    const body = this.#body()
    if (body === null) return
    this.setStanceHeight(heightForScrub(body.radius, t))
  }

  /** Compass heading in radians: 0 is north, increasing toward east. */
  setHeading(heading: Radians): void {
    this.#port.changed()
    // A heading has no bound to clamp to — it wraps — so the only thing to
    // refuse is the one value that is not an angle. See the note above
    // `clampPitch`: NaN here is a NaN quaternion and a black frame.
    if (this.#stance === null || !Number.isFinite(heading)) return
    this.#stance = { ...this.#stance, heading }
  }

  /** Above the horizontal, radians. Clamped short of vertical. */
  setPitch(pitch: Radians): void {
    this.#port.changed()
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
    this.#port.changed()
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
    return surfaceHeightBounds(this.#port.target()?.radius ?? 0)
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
   * `renderTime`, never `clock.time`, exactly as the observatory's
   * `#targetPosition` documents.
   */
  pose(): SurfacePose | null {
    const stance = this.#stance
    const body = this.#body()
    if (stance === null || body === null) return null
    const world = this.#host.world
    let spin
    try {
      spin = world.frames.pose(
        bodyFixedFrameId(body.address),
        this.#port.time(),
      )
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

  status(): SurfaceStatus | null {
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
}
