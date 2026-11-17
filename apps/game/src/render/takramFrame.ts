import { Quaternion as Q, type Vec3, Vec } from '@inertialref/spatial'
import type {
  RenderBody,
  RenderPlacement,
  RenderScene,
} from '@inertialref/rendering'

/*
 * Where a frame of ours stands in the takram port's world, on the CPU in
 * float64 and with no Three in reach.
 *
 * The port draws clouds over an Earth ellipsoid in ECEF, and takes the scene
 * through one matrix, world to ECEF. Ours is a body of any radius about a
 * floating origin. This maps the one onto the other without touching the
 * port: a point of the body's datum, the anchor, stands on Earth's equator at
 * longitude 0, where ECEF's +X is up, +Y east and +Z north, and the eye
 * keeps its true height, heading and offset from that point.
 *
 * The anchor is fixed in the body's own axes, so the cloud field turns with
 * the ground and a camera that moves moves through it. It is a tangent-plane
 * fit: the two spheres' curvatures differ, so the fit drifts by the square of
 * the distance over twice each radius, and `takramPlacement` reports the
 * distance for the caller to re-anchor on. A second anchor is another place
 * in the port's weather tile, so a re-anchor is a cut.
 *
 * The matrix is rigid and exact at the eye: a rotation, and the translation
 * that puts the eye on its true offset from the anchor. Near geometry is
 * true meters about the eye (a body in the near field is uncompressed), which
 * is where the port's depth test against the scene is meaningful. A
 * compressed body's depth is not metric, and nothing here corrects it.
 */

/** Meters: WGS84's equatorial radius, the ellipsoid the port ships. */
export const WGS84_EQUATORIAL_RADIUS = 6_378_137

/** Meters along the ground past which a placement asks for a new anchor. */
export const TAKRAM_ANCHOR_REACH = 20_000

const POLE: Vec3 = { x: 0, y: 1, z: 0 }
const PRIME: Vec3 = { x: 1, y: 0, z: 0 }

export interface TakramAnchor {
  readonly address: string
  /** Body-fixed, true meters from the center: the datum point under the eye when it was taken. */
  readonly point: Vec3
}

export interface TakramPlacement {
  /** Render space to the port's ECEF, row-major, as `Matrix4.set` takes it. */
  readonly worldToEcef: readonly number[]
  /** The eye in the port's ECEF, meters. */
  readonly eye: Vec3
  /** Unit, ECEF: the key star's direction (`takramSun`). */
  readonly sun: Vec3
  /** The eye's true height over the body's datum, meters. */
  readonly altitude: number
  /** Meters along the ground from the anchor to the eye's foot. */
  readonly drift: number
}

/** The eye in a body's own axes, true meters from its center. */
function bodyFixedEye(body: RenderBody, eye: Vec3): Vec3 {
  const fromCenter = Vec.scale(
    Vec.sub(eye, body.placement.position),
    1 / body.placement.compression,
  )
  return Q.rotate(Q.conjugate(body.orientation), fromCenter)
}

/** The datum point under `eye`, a render-space point, as an anchor. */
export function takramAnchor(body: RenderBody, eye: Vec3): TakramAnchor {
  const fixed = bodyFixedEye(body, eye)
  const length = Vec.length(fixed)
  return {
    address: body.address,
    point:
      length === 0
        ? Vec.scale(POLE, body.trueRadius)
        : Vec.scale(fixed, body.trueRadius / length),
  }
}

/** `v` less its part along the unit `axis`. */
const tangent = (v: Vec3, axis: Vec3): Vec3 =>
  Vec.sub(v, Vec.scale(axis, Vec.dot(v, axis)))

/**
 * The frame's placement: `eye` and `sun` in render axes, the sun a true
 * direction from the body's center.
 */
export function takramPlacement(
  body: RenderBody,
  anchor: TakramAnchor,
  eye: Vec3,
  sun: Vec3,
): TakramPlacement {
  const fixed = bodyFixedEye(body, eye)
  // The anchor's horizon in render axes this frame: up, then north toward
  // the body's pole, then east, right-handed as east × north = up.
  const up = Q.rotate(body.orientation, Vec.normalize(anchor.point))
  const pole = Q.rotate(body.orientation, POLE)
  const toPole = tangent(pole, up)
  // On the pole itself north has no direction, and any tangent serves.
  const north = Vec.normalize(
    Vec.length(toPole) > 1e-9
      ? toPole
      : tangent(Q.rotate(body.orientation, PRIME), up),
  )
  const east = Vec.cross(north, up)
  // The eye from the anchor, true meters, render axes.
  const offset = Q.rotate(body.orientation, Vec.sub(fixed, anchor.point))
  const placed: Vec3 = {
    x: WGS84_EQUATORIAL_RADIUS + Vec.dot(offset, up),
    y: Vec.dot(offset, east),
    z: Vec.dot(offset, north),
  }
  const row = (axis: Vec3, at: number): readonly number[] => [
    axis.x,
    axis.y,
    axis.z,
    at - Vec.dot(axis, eye),
  ]
  return {
    worldToEcef: [
      ...row(up, placed.x),
      ...row(east, placed.y),
      ...row(north, placed.z),
      0,
      0,
      0,
      1,
    ],
    eye: placed,
    sun: {
      x: Vec.dot(sun, up),
      y: Vec.dot(sun, east),
      z: Vec.dot(sun, north),
    },
    altitude: Vec.length(fixed) - body.trueRadius,
    drift: Math.hypot(placed.y, placed.z),
  }
}

/* ------------------------------------------------------------------------- */
/* The body and its sun                                                       */
/* ------------------------------------------------------------------------- */

/*
 * The two rules below are `cloudFrame.ts`'s own, `servedBody` and `trueSun`,
 * written again: that module is the native march's frame and reaches its
 * tables, and the takram chunk loads none of them.
 */

/**
 * The body the clouds are drawn on: the wet one whose air the eye is inside,
 * else the largest wet one by angular radius; `forced` wins, and one not in
 * the scene serves nothing.
 */
export function takramServed(
  bodies: readonly RenderBody[],
  eye: Vec3,
  wet: (body: RenderBody) => boolean,
  forced: string | null,
): RenderBody | null {
  if (forced !== null)
    return bodies.find((body) => body.address === forced) ?? null
  let inside: RenderBody | null = null
  let deepest = 1
  let largest: RenderBody | null = null
  for (const body of bodies) {
    if (!wet(body)) continue
    const distance =
      Vec.distance(eye, body.placement.position) / body.placement.compression
    const depth = distance / (body.airTop * body.trueRadius)
    if (depth < deepest) {
      inside = body
      deepest = depth
    }
    if (
      largest === null ||
      body.placement.angularRadius > largest.placement.angularRadius
    )
      largest = body
  }
  return inside ?? largest
}

/** Where a placed object truly is from the eye, render axes, meters. */
function trueOffset(placement: RenderPlacement, eye: Vec3): Vec3 | null {
  const offset = Vec.sub(placement.position, eye)
  const length = Vec.length(offset)
  return length === 0 ? null : Vec.scale(offset, placement.distance / length)
}

/**
 * The key star's true direction from the body's center, render axes: the
 * difference of the two true offsets from the eye, never of the two render
 * positions, which carry compression's parallax.
 *
 * A scene with no star, or a body on its star, has no sun to face, and the
 * body's pole stands in, as it does for the native frame (`bodySun`). The
 * port's sun starts as the zero vector, which its own setup inspection
 * reports as `direction.invalid`, so a direction is written on every frame.
 */
export function takramSun(body: RenderBody, scene: RenderScene): Vec3 {
  const pole = (): Vec3 => Q.rotate(body.orientation, POLE)
  const key = scene.stars[0]
  if (key === undefined) return pole()
  const eye = scene.camera.position
  const star = trueOffset(key.placement, eye)
  if (star === null) return pole()
  const center = trueOffset(body.placement, eye)
  const toStar = center === null ? star : Vec.sub(star, center)
  return Vec.length(toStar) === 0 ? pole() : Vec.normalize(toStar)
}
