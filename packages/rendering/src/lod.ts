import type { Meters, Radians } from '@inertialref/shared'
import {
  BASELINE_VIEWPORT,
  type Lens,
  LENS_PRESETS,
  pixelAngle,
  type Viewport,
} from './lens.ts'

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

/** Angular radius, in radians, at which a body changes representation. */
export interface LodThresholds {
  readonly billboard: Radians
  readonly sphere: Radians
  readonly surface: Radians
}

/**
 * How much of a pixel a body's *diameter* covers where it stops being a point.
 *
 * A third of one, which is deliberately sub-pixel: a star is always smaller
 * than a pixel and must still draw, so the threshold's job is to decide when a
 * point cloud stops being an honest description rather than when something
 * becomes resolvable. That is what the shipped constant was doing — 2e-4 of
 * angular *radius* — and the sentence beside it, "~0.2 mrad is roughly a pixel
 * at a 60 degree FOV on a 1080p display", was not arithmetic: a pixel there is
 * `atan(1/935)`, which is 1.07 mrad, five times larger.
 *
 * Stated as a fraction of the real pixel angle, the same constant comes out at
 * 1.97e-4 at the flight lens over the baseline — within 2% of the number it
 * replaces, and now a function of the lens the body is being looked at through,
 * which is what it always claimed to be.
 */
export const BILLBOARD_PIXEL_FRACTION = 1 / 3

/**
 * The three thresholds, resolved against a lens.
 *
 * `billboard` follows the optics; `sphere` and `surface` do not, and that is
 * not an oversight. They are claims about *representation* — "a disk with a
 * terminator on it" and "close enough that the ground is the picture" — and a
 * player who narrows the lens to a telephoto has not moved closer to the
 * planet. Only the point-to-billboard step is a statement about pixels.
 *
 * This is an injectable that earns it. There was one before, threaded through
 * six signatures inside a `SceneConfig`, and nothing in the repository ever
 * constructed one other than the default; the lens is the first caller with a
 * reason, and the default is still what every caller without one gets.
 */
export const lodThresholds = (
  lens: Lens,
  viewport: Viewport,
): LodThresholds => ({
  billboard: (pixelAngle(lens, viewport) * BILLBOARD_PIXEL_FRACTION) / 2,
  sphere: 2e-3,
  surface: 0.12,
})

/** The flight lens over the baseline viewport — what a caller without one gets. */
export const LOD_THRESHOLDS: LodThresholds = lodThresholds(
  LENS_PRESETS.flight,
  BASELINE_VIEWPORT,
)

/** Angular radius of a sphere of `radius` seen from `distance`, in radians. */
export function angularRadius(radius: Meters, distance: Meters): number {
  if (distance <= radius) return Math.PI / 2
  return Math.asin(Math.min(1, radius / distance))
}

export function selectLod(
  radius: Meters,
  distance: Meters,
  thresholds: LodThresholds = LOD_THRESHOLDS,
): LodTier {
  const angle = angularRadius(radius, distance)
  if (angle >= thresholds.surface) return 'surface'
  if (angle >= thresholds.sphere) return 'sphere'
  if (angle >= thresholds.billboard) return 'billboard'
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
