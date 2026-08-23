import type { Meters } from '@inertialref/shared'
import {
  type RenderOrigin,
  toRenderSpace,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import { type LodTier, selectLod } from './lod.ts'

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
  /** Multiplier for unit-radius geometry. */
  readonly scale: number
  /** True distance from the render origin, meters. */
  readonly distance: Meters
  readonly tier: LodTier
  /** True when the position is compressed and depth is no longer metric. */
  readonly compressed: boolean
  /** Angular radius as seen from the origin, radians. */
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

export function placeAt(
  origin: RenderOrigin,
  position: UniverseVector,
  radius: Meters,
): RenderPlacement {
  const offset = toRenderSpace(origin, position)
  const distance = Vec.length(offset)
  const tier = selectLod(radius, distance)
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
    return {
      position: offset,
      scale: radius,
      distance,
      tier,
      compressed: false,
      angularRadius: angle,
    }
  }

  const factor = (radius + compressDistance(surfaceDistance)) / distance
  return {
    // Same direction, and position and radius scale together — so the object
    // subtends exactly the angle it should. Only depth becomes a lie.
    position: Vec.scale(offset, factor),
    scale: radius * factor,
    distance,
    tier,
    compressed: true,
    angularRadius: angle,
  }
}

/** Place a point with no extent (a distant star). */
export const placePoint = (
  origin: RenderOrigin,
  position: UniverseVector,
): RenderPlacement => placeAt(origin, position, 0)

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
