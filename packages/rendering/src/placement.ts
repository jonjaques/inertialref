import type { Meters } from '@inertialref/shared'
import {
  type RenderOrigin,
  toRenderSpace,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import { type LodTier, selectLod, type LodThresholds, DEFAULT_LOD } from './lod.ts'

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

export interface PlacementConfig {
  /** Distance below which nothing is touched: true metres, true scale. */
  readonly nearLimit: Meters
  /** Where the compressed range starts. Must equal nearLimit for continuity. */
  readonly shellStart: Meters
  /**
   * How far one e-fold of real distance moves the compressed position. Setting
   * this equal to `nearLimit` makes the derivative exactly 1 at the boundary,
   * so the mapping is C¹ and a body crossing into the near field neither jumps
   * nor visibly changes its rate of approach.
   */
  readonly shellSpan: Meters
  readonly thresholds: LodThresholds
}

export const DEFAULT_PLACEMENT: PlacementConfig = {
  nearLimit: 2e6,
  shellStart: 2e6,
  // Equal to nearLimit: see the field comment. Four light-years compresses to
  // about 5e7 m, which needs a logarithmic depth buffer but nothing more.
  shellSpan: 2e6,
  thresholds: DEFAULT_LOD,
}

export interface RenderPlacement {
  /** Position in render space, metres, possibly compressed. */
  readonly position: Vec3
  /** Multiplier for unit-radius geometry. */
  readonly scale: number
  /** True distance from the render origin, metres. */
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
 * changes its apparent rate of approach. It is strictly increasing everywhere,
 * so sorting by rendered depth still sorts by real distance.
 */
export function compressDistance(distance: Meters, config: PlacementConfig): Meters {
  if (distance <= config.nearLimit) return distance
  return config.shellStart + config.shellSpan * Math.log(1 + (distance - config.nearLimit) / config.nearLimit)
}

export function placeAt(
  origin: RenderOrigin,
  position: UniverseVector,
  radius: Meters,
  config: PlacementConfig = DEFAULT_PLACEMENT,
): RenderPlacement {
  const offset = toRenderSpace(origin, position)
  const distance = Vec.length(offset)
  const tier = selectLod(radius, distance, config.thresholds)
  const angle = radius <= 0 || distance <= 0 ? 0 : Math.asin(Math.min(1, radius / Math.max(radius, distance)))

  if (distance <= config.nearLimit || distance === 0) {
    return { position: offset, scale: radius, distance, tier, compressed: false, angularRadius: angle }
  }

  const compressed = compressDistance(distance, config)
  const factor = compressed / distance
  return {
    // Same direction, shorter radius, and the radius shrinks by the same
    // factor — so the object subtends exactly the angle it should.
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
  config: PlacementConfig = DEFAULT_PLACEMENT,
): RenderPlacement => placeAt(origin, position, 0, config)
