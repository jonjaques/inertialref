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
 * becomes resolvable.
 *
 * Stated as a fraction of the pixel angle rather than as a constant, because a
 * constant can only be right at one lens: at the flight lens over the baseline
 * this is 1.97e-4 of angular radius, at 20° it is 5.44e-5 — a third of it — and
 * with the zoom channel racked out it is 6.8e-6. The arithmetic is easy to get
 * wrong by an order of magnitude — a pixel at 60° over 1080 px is `atan(1/935)`,
 * 1.07 mrad, not the 0.2 mrad it is tempting to call one.
 */
export const BILLBOARD_PIXEL_FRACTION = 1 / 3

/**
 * Where a body stops being an impostor and becomes a drawn disk.
 *
 * Named because the clamp below has to hold it too, and two spellings of the
 * same number is how a ceiling comes to sit above the thing it is clamping to.
 */
const SPHERE_THRESHOLD: Radians = 2e-3

/**
 * The three thresholds, resolved against a lens.
 *
 * `billboard` follows the optics; `sphere` and `surface` do not, and that is
 * not an oversight. They are claims about *representation* — "a disk with a
 * terminator on it" and "close enough that the ground is the picture" — and a
 * player who narrows the lens to a telephoto has not moved closer to the
 * planet. Only the point-to-billboard step is a statement about pixels.
 *
 * This is an injectable that earns it: the lens is the one caller with a reason
 * to construct a set of its own, and every caller without one gets
 * `LOD_THRESHOLDS` below. An injectable nobody but the default constructs is a
 * parameter charged to every signature it threads through, which is what the
 * shape of `selectLod`, `placeAt` and `buildScene` is guarding against.
 */
export const lodThresholds = (
  lens: Lens,
  viewport: Viewport,
): LodThresholds => ({
  /*
   * Never above `sphere`, because `selectLod` tests the three in order and a
   * billboard threshold that overtook the sphere one would delete the tier
   * rather than widen it — every body under 0.12 rad would answer `point`, and
   * `Bodies.tsx` gates clouds, rings and the atmosphere shell on not being one.
   * A pixel is 1.07 mrad at the flight lens over 1080 px and the crossing is at
   * a viewport 106 px tall, which a window can be dragged to and a canvas
   * measures while it is laying out.
   */
  billboard: Math.min(
    SPHERE_THRESHOLD,
    (pixelAngle(lens, viewport) * BILLBOARD_PIXEL_FRACTION) / 2,
  ),
  sphere: SPHERE_THRESHOLD,
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
