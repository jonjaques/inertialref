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

/*
 * Angular radius, in radians, at which a body changes representation.
 *
 * Constants rather than an injectable `LodThresholds`. There was one, threaded
 * through six signatures and nested three deep inside a `SceneConfig`, and in
 * the whole repository — app, headless runner, devtools and tests — nothing
 * ever constructed one other than the default. One adapter is a hypothetical
 * seam, and this one was charging every caller a parameter for it.
 */
export const LOD_THRESHOLDS = {
  // ~0.2 mrad is roughly a pixel at a 60 degree FOV on a 1080p display.
  billboard: 2e-4,
  sphere: 2e-3,
  surface: 0.12,
} as const

/** Angular radius of a sphere of `radius` seen from `distance`, in radians. */
export function angularRadius(radius: Meters, distance: Meters): number {
  if (distance <= radius) return Math.PI / 2
  return Math.asin(Math.min(1, radius / distance))
}

export function selectLod(radius: Meters, distance: Meters): LodTier {
  const angle = angularRadius(radius, distance)
  if (angle >= LOD_THRESHOLDS.surface) return 'surface'
  if (angle >= LOD_THRESHOLDS.sphere) return 'sphere'
  if (angle >= LOD_THRESHOLDS.billboard) return 'billboard'
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

/**
 * How present streamed terrain should be at this distance: 0 (not drawn, not
 * streamed) to 1 (fully solid), fading linearly in altitude between the two.
 *
 * The streamed set is a fixed 3×3 window of patches around the sub-camera
 * point, so away from the ground it degenerates into a lone raised tile on the
 * datum sphere — 11 km proud of it on the first planet, since the sphere is
 * sunk a full relief below the datum. The winding fix made that tile visible
 * from orbit for the first time; until the terrain quadtree covers the whole
 * disc, the honest representation up there is the sphere alone.
 *
 * Full presence starts where `terrainLevelFor` saturates at `maxLevel` —
 * altitude `radius · 2^(4.5 − maxLevel)` — because that is the boundary below
 * which the window stops changing size and starts being the ground rather than
 * a sticker on it. The fade spans one octave of altitude above that, which is
 * the same cadence the level selection itself moves at.
 */
export function terrainOpacity(radius: Meters, distance: Meters, maxLevel = 12): number {
  const altitude = Math.max(1, distance - radius)
  const full = radius * 2 ** (4.5 - maxLevel)
  return Math.min(1, Math.max(0, 2 - altitude / full))
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
