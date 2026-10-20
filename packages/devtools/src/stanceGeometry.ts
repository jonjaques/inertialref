import type { Meters, Radians, Seconds } from '@inertialref/shared'
import { type Quat, vec3, Vec, type Vec3 } from '@inertialref/spatial'
import {
  type Body,
  directionToGeodetic,
  drawnSurfaceRadius,
  geodeticDirection,
} from '@inertialref/universe'
import {
  arcAnomaly,
  arcContinuation,
  arcPoint,
  arcSamples,
  clampLatitude,
  clampPitch,
  dropLevel,
  dropRadius,
  type EntryArc,
  entryArc,
  horizonPitch,
  localTriad,
  MIN_STANCE_HEIGHT,
  PITCH_LIMIT,
  shortestAngle,
  stanceToward,
  type SurfaceStance,
  wrapHeading,
} from '@inertialref/rendering'

/*
 * The arithmetic of standing on a body: where the drop figures are drawn, how a
 * held key moves the stance, and where a drop is at each instant of its fall.
 *
 * Every function here is a function of a body, a direction and an eye in the
 * body's own rotating axes, and returns what the surface arm draws or stands
 * at. Nothing reads a world or a clock: the arm resolves the body and carries
 * the eye into body-fixed axes, and these take it from there — which is what
 * lets the claims the comments make about these figures be properties rather
 * than prose.
 */

/*
 * Flying the stance. The speed is a share of the height per second, with a
 * floor for the walkable band: two meters up moves at a run, a hundred meters
 * up at highway speed, and the orbit floor at kilometers a second, which is
 * the same logarithm the scrub spends on the same six decades.
 */
export const FLIGHT_SPEED_PER_HEIGHT = 0.8
export const FLIGHT_FLOOR_SPEED: Meters = 4
export const FLIGHT_FAST = 4

/** The longest frame a flight step trusts; a stall is not a teleport. */
export const FLIGHT_MAX_STEP: Seconds = 0.1

/**
 * How much of the frame the drop ring covers, radians of half-angle.
 *
 * Two degrees. A mark that says "here" has to be findable against a cratered
 * surface without claiming ground the camera is not landing on, and the only
 * size that holds across the six decades this gesture spans is an angular one.
 */
export const RING_ANGLE = 0.035

/** Segments in either ring. Enough that a couple of degrees reads as a circle. */
export const RING_SEGMENTS = 48

/**
 * How much of the frame the held figure's ring covers, radians of half-angle.
 *
 * Smaller than the ground ring's: this one sits near the eye and is the thing
 * the hand is moving, so it wants to be a cursor rather than a target. At 0.9°
 * it is about 25 px on a 900-line frame, which is a mark a pointer can be
 * inside without covering what it is aiming at.
 */
export const HOLD_ANGLE = 0.016

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
 * Proportional, and it has to be. A fixed lift is a meter-scale number, and the
 * vertex buffer holding it is float32 at a planetary radius — where one step is
 * half a meter — so a two-meter lift is a handful of bits and the loop z-fights
 * with the patch drawing the same height. Worse at a limb, where the ground is
 * edge-on and any lift is foreshortened to nothing. A twelfth of the ring's own
 * radius is clear at every distance the gesture spans and still reads as lying
 * on the ground rather than hovering over it.
 */
export const RING_LIFT_SHARE = 0.08

/** The point a drop is being aimed at. */
export interface DropAim {
  readonly latitude: Radians
  readonly longitude: Radians
  /** Launch samples and screen up, in body radii and body-fixed axes. */
  readonly launch?: readonly Vec3[]
  readonly up?: Vec3
}

/** The keys held against a stance, in its own heading, each in -1..1. */
export interface StanceFlight {
  readonly forward: number
  readonly right: number
  readonly up: number
  readonly fast: boolean
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
export interface Descent {
  readonly arc: EntryArc
  /** The camera's orientation at release, in the body's rotating axes. */
  readonly from: Quat
  /** Unit vector from the center to the touchdown point. */
  readonly ground: Vec3
  readonly latitude: Radians
  readonly longitude: Radians
  readonly seconds: Seconds
  elapsed: Seconds
  /** How much of the surface camera's roll is showing this frame, `[0, 1]`. */
  blend: number
}

/** The drop aid's figures, in body radii and the body's own rotating axes. */
export interface EntryArcPreview {
  readonly from: Vec3
  readonly hold: readonly Vec3[]
  readonly arc: readonly Vec3[]
  readonly through: readonly Vec3[]
  readonly ring: readonly Vec3[]
  readonly touchdown: Vec3
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
export function holdRing(
  at: Vec3,
  eye: Vec3,
  screenUp?: Vec3,
): readonly Vec3[] {
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
 * the ground rather than on the datum — on a slope the two are a kilometer
 * apart, and a ring that floated over a crater rim would be pointing at
 * somewhere the camera does not land. `eye` is in the body's rotating axes.
 */
export function groundRing(
  body: Body,
  center: Vec3,
  touchdownRadius: Meters,
  eye: Vec3,
): readonly Vec3[] {
  const range = Math.max(
    1,
    Vec.length(Vec.sub(eye, Vec.scale(center, touchdownRadius))),
  )
  const across = Math.min(body.radius * 0.22, range * RING_ANGLE)
  // The angle the ring subtends at the body's center, which is what turns a
  // distance across the ground into a rotation of the direction.
  const sweep = Math.min(Math.PI / 3, across / body.radius)
  const triad = localTriad(center)
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
     * mountains are in — see `descentStance`, which pays the same toll.
     */
    const turned = Vec.add(
      Vec.scale(center, Math.cos(sweep)),
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

/**
 * The drop aid for a point aimed at from an eye, in the body's rotating axes.
 *
 * Null when there is no arc to draw: an eye inside the ground it is aiming
 * at. A launched aim carries its own path, and only its rings are solved here.
 */
export function entryArcPreview(
  body: Body,
  eye: Vec3,
  point: DropAim,
  samples = 48,
): EntryArcPreview | null {
  const ground = geodeticDirection(
    clampLatitude(point.latitude),
    point.longitude,
  )
  if (point.launch !== undefined) {
    const from = point.launch[0]!
    const touchdown = point.launch.at(-1)!
    const unit = (offset: Vec3): Vec3 => Vec.scale(offset, 1 / body.radius)
    return {
      from,
      hold: holdRing(Vec.scale(from, body.radius), eye, point.up).map(unit),
      arc: point.launch,
      through: [],
      ring: groundRing(
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
    (Vec.length(eye) - body.radius) * HOLD_ALTITUDE_SHARE,
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
    hold: holdRing(from, eye).map(unit),
    arc: whole.map(unit),
    through: arcContinuation(arc, samples).map(unit),
    ring: groundRing(body, ground, arc.touchdown, eye).map(unit),
    touchdown: unit(touchdown),
  }
}

/** How far a held key moves the stance in one frame, meters. */
export function flightDistance(
  height: Meters,
  fast: boolean,
  dt: Seconds,
): Meters {
  const speed =
    Math.max(FLIGHT_FLOOR_SPEED, height * FLIGHT_SPEED_PER_HEIGHT) *
    (fast ? FLIGHT_FAST : 1)
  return speed * Math.min(dt, FLIGHT_MAX_STEP)
}

/**
 * One frame of a flight over a body of `radius`: the stance's new latitude and
 * longitude, and the height the up key asks for, unclamped. Null for a frame
 * that does not move.
 *
 * North and east are the stance's own heading turned onto the compass, and the
 * step is taken on the sphere the eye is on rather than on the ground, so the
 * same keys cross the same angle whatever the terrain under them is doing.
 */
export function flightStep(
  stance: SurfaceStance,
  flight: StanceFlight,
  radius: Meters,
  dt: Seconds,
): {
  readonly latitude: Radians
  readonly longitude: Radians
  readonly height: Meters
} | null {
  if (!(dt > 0)) return null
  const distance = flightDistance(stance.height, flight.fast, dt)
  const north =
    flight.forward * Math.cos(stance.heading) -
    flight.right * Math.sin(stance.heading)
  const east =
    flight.forward * Math.sin(stance.heading) +
    flight.right * Math.cos(stance.heading)
  const reach = radius + stance.height
  const latitude = clampLatitude(stance.latitude + (north * distance) / reach)
  const cosine = Math.max(1e-6, Math.cos(latitude))
  let longitude = stance.longitude + (east * distance) / (reach * cosine)
  /*
   * Wrapped by whole turns, not by one. Near a pole the cosine is small and a
   * single frame's step crosses more than a turn of longitude — measured, a
   * fast step 2,000 km over a pole lands at −3.14159265358983 under one
   * correction of 2π. Only an out-of-range value is touched, so every
   * longitude already in range comes back bit for bit.
   */
  if (longitude > Math.PI || longitude < -Math.PI)
    longitude = Math.PI - wrapHeading(Math.PI - longitude)
  return {
    latitude,
    longitude,
    height: stance.height + flight.up * distance,
  }
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
 *
 * `starHeading` is the star's bearing at the touchdown point, or null where
 * there is no star to turn to.
 */
export function descentStance(
  body: Body,
  descent: Descent,
  progress: number,
  starHeading: Radians | null,
): SurfaceStance {
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
