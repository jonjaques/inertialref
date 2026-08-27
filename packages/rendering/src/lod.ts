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
  /** Resolvable disk: an actual sphere. */
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

/*
 * `terrainLevelFor` and `terrainOpacity` were here, and both took
 * `distance − radius` as the altitude. For a camera standing on the ground that
 * is `elevation + height`, not `height`, so the streaming rules measured from
 * the datum — a summit streamed a level coarse, a summit above
 * `radius · 2^(5.5 − maxLevel)` was not drawn at any altitude including zero,
 * and flying level re-requested the world as the ground rose beneath it. The
 * fade existed because a 3×3 window is a sticker on the datum sphere rather
 * than a picture of a planet, and there is no window any more.
 *
 * Both are replaced by `terrainSelect.ts`, which measures to the ground and
 * refines per patch. This note is here because a level and an opacity are the
 * two things a reader coming from the streamer will look for in an LOD file.
 */

/** Blackbody color of a star, approximate but monotonic in temperature. */
export function starColor(temperature: number): {
  r: number
  g: number
  b: number
} {
  const t = Math.min(40_000, Math.max(1_000, temperature)) / 100
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  const r = t <= 66 ? 1 : clamp((329.7 * (t - 60) ** -0.1332) / 255)
  const g =
    t <= 66
      ? clamp((99.47 * Math.log(t) - 161.12) / 255)
      : clamp((288.12 * (t - 60) ** -0.0755) / 255)
  const b =
    t >= 66
      ? 1
      : t <= 19
        ? 0
        : clamp((138.52 * Math.log(t - 10) - 305.04) / 255)
  return { r, g, b }
}
