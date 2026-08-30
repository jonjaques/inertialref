import type { Meters } from '@inertialref/shared'
import {
  Quaternion as Q,
  type RenderOrigin,
  toRenderSpace,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import { type LodThresholds, type LodTier, selectLod } from './lod.ts'

/*
 * Turning a canonical position into something the GPU can draw (ADR-0003).
 *
 * Two problems, one solution.
 *
 *   1. A star 4 light-years away is 4e16 m from the render origin. float32 runs
 *      out at ~3.4e38 but runs out of *precision* long before that, and a depth
 *      buffer spanning 1e16:1 has no usable resolution anywhere.
 *   2. Objects in the same scene span twenty orders of magnitude of distance.
 *
 * Everything beyond the near field is therefore moved onto a logarithmically
 * compressed radial scale and scaled by the same factor. Because position and
 * radius are scaled together, the *angular* size is preserved exactly — the
 * image is correct, only the depth is a lie. The compression is monotonic in
 * distance, so occlusion ordering survives, which a single far shell would not.
 *
 * Radial *from the eye*, which is why every entry point here takes one. The
 * render origin is a nearby grid point, not the camera, and compressing about
 * it is the difference between an image that is exactly right and one that
 * jitters — see `placeAt`.
 */

/*
 * The compression shell. Constants, for the same reason as LOD_THRESHOLDS: the
 * `PlacementConfig` these replace had exactly one instance in the repository.
 */

/** Distance below which nothing is touched: true meters, true scale. */
export const NEAR_LIMIT: Meters = 2e6
/** Where the compressed range starts. Equal to NEAR_LIMIT, for continuity. */
export const SHELL_START: Meters = 2e6
/**
 * How far one e-fold of real distance moves the compressed position.
 *
 * Equal to `NEAR_LIMIT`, which makes the derivative exactly 1 at the boundary,
 * so the mapping is C¹ and a body crossing into the near field neither jumps nor
 * visibly changes its rate of approach. Four light-years compresses to about
 * 5e7 m, which needs a logarithmic depth buffer but nothing more.
 */
export const SHELL_SPAN: Meters = 2e6

export interface RenderPlacement {
  /** Position in render space, meters, possibly compressed. */
  readonly position: Vec3
  /** Multiplier for unit-radius geometry — the drawn radius, in meters. */
  readonly scale: number
  /**
   * How much smaller than life the object is drawn. 1 in the near field.
   *
   * `scale` is the *drawn radius* and is what a unit sphere wants; anything
   * with its own metric geometry wants this instead. Terrain is the case: a
   * patch's vertices are true meters from the patch's anchor, and multiplying
   * them by a radius rather than by a ratio puts them 10^12 m away.
   */
  readonly compression: number
  /** True distance from the eye, meters — never the compressed one. */
  readonly distance: Meters
  readonly tier: LodTier
  /** True when the position is compressed and depth is no longer metric. */
  readonly compressed: boolean
  /** Angular radius as seen from the eye, radians. */
  readonly angularRadius: number
}

/**
 * Compressed radial distance.
 *
 * `shellStart + shellSpan · ln(1 + (d − nearLimit)/nearLimit)`. With
 * `shellSpan = shellStart = nearLimit` this is continuous *and* has derivative
 * 1 at the boundary, so an object crossing into the near field neither pops nor
 * changes its apparent rate of approach.
 *
 * It is non-decreasing everywhere, so rendered depth never inverts real depth.
 * It is *strictly* increasing only while the separation survives double
 * precision: past ~1e17 m the slope is around 1e-11, so two objects a hundred
 * meters apart compress to the same value. They are also the same pixel, so
 * this costs nothing — but it is a property of the mapping, not an accident,
 * and the tests state it that way.
 */
export function compressDistance(distance: Meters): Meters {
  if (distance <= NEAR_LIMIT) return distance
  return (
    SHELL_START +
    SHELL_SPAN * Math.log(1 + (distance - NEAR_LIMIT) / NEAR_LIMIT)
  )
}

/**
 * Place a body, as seen from `eye`.
 *
 * `eye` is the camera's position **in render space** — `toRenderSpace(origin,
 * cameraPosition)`, which `buildScene` has already computed. It is a required
 * argument rather than a defaulted one because getting it wrong is silent, and
 * the symptom shows up somewhere else entirely.
 *
 * The reason it cannot be the origin: compression is radial, so the point it is
 * measured *from* is the one place in the image that stays honest. The origin
 * is not the eye — it is a power-of-two grid point within `REBASE_THRESHOLD`
 * of the camera, so it lags the camera by up to 4 km and then snaps. Measuring
 * compression from there gives every compressed object a parallax that is wrong
 * by `eyeOffset · (1/compressed − 1/true)` and, worse, *sawtooths*: the error
 * ramps as the camera drifts across the rebase window and resets when it
 * snaps.
 *
 * That error is scale-free in meters, so what decides whether it is visible is
 * how big the object is on screen. Mars from 25,000 km absorbs it a thousand
 * times over. Phobos, at 11 km of radius from the same place, moved by 0.8× its
 * own angular radius every time the origin rebased, and Deimos by 1.6× — the
 * two smallest bodies in the Solar System model, vibrating in their orbits
 * while everything around them held still. `rendering.test.ts` pins the
 * property that fixes it: the drawn direction from the eye is the true
 * direction from the eye, at any separation.
 */
export function placeAt(
  origin: RenderOrigin,
  position: UniverseVector,
  radius: Meters,
  eye: Vec3,
  /**
   * Where the representation changes, for the lens this frame is taken with.
   *
   * Only the point-to-billboard step moves with it, and only because that step
   * is a claim about pixels. A caller with no lens gets the flight one over the
   * baseline viewport, which is what `LOD_THRESHOLDS` states.
   */
  thresholds?: LodThresholds,
): RenderPlacement {
  const fromOrigin = toRenderSpace(origin, position)
  const offset = Vec.sub(fromOrigin, eye)
  const distance = Vec.length(offset)
  const tier = selectLod(radius, distance, thresholds)
  const angle =
    radius <= 0 || distance <= 0
      ? 0
      : Math.asin(Math.min(1, radius / Math.max(radius, distance)))

  // Compression keys off the distance to the *surface*, not to the center.
  //
  // Keying off the center broke the thing this whole system exists for: in a
  // 400 km orbit the planet's center is 3,264 km away and was therefore
  // compressed, while the streamed terrain patches 400 km away were in the
  // uncompressed near field. The datum sphere and the ground it represents
  // ended up 30 km apart, so no terrain was visible at all.
  //
  // Using the surface distance also makes the transition continuous: at the
  // boundary the factor is exactly 1, so a planet does not pop as you arrive.
  const surfaceDistance = Math.max(0, distance - radius)
  if (surfaceDistance <= NEAR_LIMIT || distance === 0) {
    // `fromOrigin`, not `eye + offset`: the near field is untouched by any of
    // this, and reconstructing it through the eye would round a value that is
    // currently exact. Terrain patches are placed straight off the origin
    // (`terrainMesh.patchPlacement`) and have to agree with this to the meter.
    return {
      position: fromOrigin,
      scale: radius,
      compression: 1,
      distance,
      tier,
      compressed: false,
      angularRadius: angle,
    }
  }

  const factor = (radius + compressDistance(surfaceDistance)) / distance
  return {
    // Same direction *from the eye*, and position and radius scale together —
    // so the object subtends exactly the angle it should. Only depth is a lie.
    position: Vec.add(eye, Vec.scale(offset, factor)),
    scale: radius * factor,
    compression: factor,
    distance,
    tier,
    compressed: true,
    angularRadius: angle,
  }
}

/**
 * Place a whole path into a vertex buffer, the way `placeAt` places one point.
 *
 * Same arithmetic, no `RenderPlacement`. `OrbitTraces` re-places every vertex
 * of every visible trace every frame — correctly, because compression is
 * radial about the eye and the eye moves — and eight traces of 97 points was
 * ~800 `placeAt` calls and several thousand short-lived objects a frame: the
 * span read 0.57 ms on the shipped build in the planetarium and fed the
 * scavenger that eats 3-5% of an idle main thread. Per point it was a
 * `UV.translate` (three `carry` objects and a result), a `difference`, a
 * `conjugate`, a `rotate`, three more vectors through `Vec.sub`/`scale`/`add`,
 * and a placement record — for three floats. It also spent a `Math.asin` and
 * an LOD selection on an angular radius and a tier that a line has no use for.
 *
 * What survives per point is the one call this must not inline: `difference`
 * is the sector arithmetic, `spatial` owns it, and the copy of it that used to
 * live in the R3F layer is why `placeOnStarShell` exists.
 *
 * @param shift - a universe-axes displacement added to every point first. The
 * caller's `UV.translate` per point was four allocations to express something
 * affine: differencing is linear, so the shift can be rotated into render axes
 * once and added there.
 * @param out - three floats per point, in order. Writes `min(points.length,
 * out.length / 3)` of them.
 */
export function placePathInto(
  origin: RenderOrigin,
  points: readonly UniverseVector[],
  shift: Vec3,
  radius: Meters,
  eye: Vec3,
  out: Float32Array,
): void {
  // Both constant over the path. Inside the loop the conjugate was rebuilt per
  // point, because `rotateInverse` is `rotate(conjugate(q), v)`.
  const inverse = Q.conjugate(origin.orientation)
  const shifted = Q.rotate(inverse, shift)
  const count = Math.min(points.length, Math.floor(out.length / 3))
  for (let i = 0; i < count; i += 1) {
    const point = points[i]
    if (point === undefined) continue
    const local = Q.rotate(inverse, UV.difference(point, origin.position))
    const fx = local.x + shifted.x
    const fy = local.y + shifted.y
    const fz = local.z + shifted.z
    const dx = fx - eye.x
    const dy = fy - eye.y
    const dz = fz - eye.z
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const surfaceDistance = Math.max(0, distance - radius)
    if (surfaceDistance <= NEAR_LIMIT || distance === 0) {
      // `placeAt`'s near-field branch: the untouched render-space position, not
      // one reconstructed through the eye, so a trace and the terrain placed
      // straight off the origin agree to the meter.
      out[i * 3] = fx
      out[i * 3 + 1] = fy
      out[i * 3 + 2] = fz
      continue
    }
    const factor = (radius + compressDistance(surfaceDistance)) / distance
    out[i * 3] = eye.x + dx * factor
    out[i * 3 + 1] = eye.y + dy * factor
    out[i * 3 + 2] = eye.z + dz * factor
  }
}

/** Place a point with no extent (a distant star). */
export const placePoint = (
  origin: RenderOrigin,
  position: UniverseVector,
  eye: Vec3,
): RenderPlacement => placeAt(origin, position, 0, eye)

/** Radius of the shell distant stars are drawn on. */
export const STAR_SHELL_RADIUS: Meters = 8e7

/**
 * Project a star onto a fixed shell around the render origin.
 *
 * Stars sit far outside any usable depth range, so only their direction is
 * observable; the shell radius is a rendering convenience, not a distance.
 *
 * This lives here rather than in the R3F layer, where it was open-coded over
 * the raw sector fields with `2 ** 40` written out by hand — the sector size
 * that `spatial` owns and ADR-0001 makes load-bearing. That copy also skipped
 * the origin's *orientation*, which `toRenderSpace` applies and every body
 * therefore got: whenever the origin was anchored to an oriented frame the
 * stars were rotated out of alignment with the planets in front of them.
 *
 * Returns null for a star exactly at the origin, which has no direction.
 */
export function placeOnStarShell(
  origin: RenderOrigin,
  position: UniverseVector,
): Vec3 | null {
  const offset = toRenderSpace(origin, position)
  const length = Vec.length(offset)
  if (length === 0) return null
  return Vec.scale(offset, STAR_SHELL_RADIUS / length)
}
