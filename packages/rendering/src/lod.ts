import type { Meters } from '@inertialref/shared'

/*
 * Level of detail (spec §13).
 *
 * LOD here is a property of the *representation*, chosen from angular size, and
 * completely separate from the entity's identity. A planet is the same planet
 * whether it is one pixel, a sphere, or ground you are standing on; only which
 * renderer draws it changes. Nothing downstream may key off the tier for
 * anything except drawing.
 *
 * Angular size rather than distance is what decides: a gas giant at 10^9 m and
 * a boulder at 10 m can subtend the same angle, and the pixel budget cares
 * about the angle.
 */

export type LodTier =
  /** Sub-pixel: a point in a star/body point cloud. */
  | 'point'
  /** A few pixels: a camera-facing impostor. */
  | 'billboard'
  /** Resolvable disc: an actual sphere. */
  | 'sphere'
  /** Fills a good part of the view: sphere plus streamed terrain patches. */
  | 'surface'

export interface LodThresholds {
  /** Angular radius, radians, above which a body is drawn as a billboard. */
  readonly billboard: number
  readonly sphere: number
  readonly surface: number
}

export const DEFAULT_LOD: LodThresholds = {
  // ~0.2 mrad is roughly a pixel at a 60 degree FOV on a 1080p display.
  billboard: 2e-4,
  sphere: 2e-3,
  surface: 0.12,
}

/** Angular radius of a sphere of `radius` seen from `distance`, in radians. */
export function angularRadius(radius: Meters, distance: Meters): number {
  if (distance <= radius) return Math.PI / 2
  return Math.asin(Math.min(1, radius / distance))
}

export function selectLod(
  radius: Meters,
  distance: Meters,
  thresholds: LodThresholds = DEFAULT_LOD,
): LodTier {
  const angle = angularRadius(radius, distance)
  if (angle >= thresholds.surface) return 'surface'
  if (angle >= thresholds.sphere) return 'sphere'
  if (angle >= thresholds.billboard) return 'billboard'
  return 'point'
}

/**
 * Terrain subdivision level to stream at, from how much of the screen a metre
 * of ground occupies.
 *
 * Returned as a level rather than a patch count so the caller can ask the
 * cube-sphere for exactly the regions it needs — the same addressing the
 * generator and the persistence layer use.
 */
export function terrainLevelFor(radius: Meters, distance: Meters, maxLevel = 12): number {
  const altitude = Math.max(1, distance - radius)
  // Roughly: halve the patch size for every halving of altitude.
  const level = Math.round(Math.log2(radius / altitude)) + 4
  return Math.min(maxLevel, Math.max(0, level))
}

/** Blackbody colour of a star, approximate but monotonic in temperature. */
export function starColor(temperature: number): { r: number; g: number; b: number } {
  const t = Math.min(40_000, Math.max(1_000, temperature)) / 100
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  const r = t <= 66 ? 1 : clamp((329.7 * (t - 60) ** -0.1332) / 255)
  const g =
    t <= 66
      ? clamp((99.47 * Math.log(t) - 161.12) / 255)
      : clamp((288.12 * (t - 60) ** -0.0755) / 255)
  const b = t >= 66 ? 1 : t <= 19 ? 0 : clamp((138.52 * Math.log(t - 10) - 305.04) / 255)
  return { r, g, b }
}
