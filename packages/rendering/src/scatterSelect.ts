import type { Meters } from '@inertialref/shared'
import { Vec } from '@inertialref/spatial'
import {
  type BodyFixedDirection,
  type RegionAddress,
  regionAddress,
  regionCentreDirection,
  regionForDirection,
  regionNeighbor,
  regionSize,
} from '@inertialref/universe'
import { type Lens, pixelsPerRadian, type Viewport } from './lens.ts'

/*
 * Which patches of *rocks* the camera is asking for.
 *
 * The quadtree's much smaller cousin, and the differences are the interesting
 * part. Scatter is not refined: a rock lives at one level and one level only
 * (`scatterLevel`), because a second copy of it a level up would be a second
 * rock in the same place. So there is no tree to walk and no morph to close —
 * what there is, is a disk of regions around the point under the camera, and
 * the only question is how wide.
 *
 * **The width is the lens, not a constant.** A rock stops being a rock when it
 * stops covering pixels, and how far away that is depends entirely on the
 * optics: at the flight lens the smallest rock the generator places is two
 * pixels at 212 m, and at the telephoto end of the same slider it is two pixels
 * at 765. Reading `pixelsPerRadian` is the same thing `selectTerrain` does and
 * for the same reason — a fixed range is right for exactly one setting of two
 * controls.
 *
 * **The eye's direction is a unit vector and this measures a chord against it.**
 * All three producers of a `BodyFixedDirection` normalize, so it is; a direction
 * 0.16% short — which is what a hand-written triple usually is — puts the eye
 * 2.8 km below the ground it is standing on and the whole disk falls outside the
 * range.
 */

/** Where the camera is, in the terms this selection needs. */
export interface ScatterEye {
  /** Body-fixed direction of the eye from the body's center. */
  readonly direction: BodyFixedDirection
  /** Eye distance from the center, meters. */
  readonly distance: Meters
  /** The datum radius, which is what sizes a region at a level. */
  readonly radius: Meters
  /**
   * And the radius of the **ground** under the eye, meters.
   *
   * Separate from `radius`, and the separation is the whole of this selection's
   * geometry. `distance − radius` is the height above the *datum*, which for a
   * camera standing on a mountain is `elevation + height` — 687 m for a two-meter
   * stance on Iapetus's `rough` site, which is three times the range and switches
   * the whole field off. It is the same mistake `terrainSelect` records under
   * "distance is measured to the ground, not to the datum", made again one object
   * down. The caller samples the drawn field once per frame; over the couple of
   * hundred meters this reaches, the ground moves by meters and one radius
   * describes it.
   */
  readonly ground: Meters
  /** The subdivision level this body's rocks are addressed at. */
  readonly level: number
}

export interface ScatterSelectOptions {
  readonly lens?: Lens
  readonly viewport?: Viewport
  /** How many regions may be returned. A ceiling on the per-frame work. */
  readonly maxRegions?: number
}

/**
 * How many pixels the smallest rock has to cover to be worth drawing.
 *
 * Two. Below that an instanced blob is an aliasing point sample of one — it
 * flickers as the camera moves and contributes nothing a slightly rougher
 * normal would not — and the whole population past that distance is thousands of
 * draws for a dusting of noise.
 */
const ROCK_PIXELS = 2

/** The radius the range is quoted for: the smallest thing scatter places. */
const SMALLEST_ROCK: Meters = 0.25

/**
 * How far rocks are drawn, meters.
 *
 * The distance at which the smallest rock the generator places covers
 * `ROCK_PIXELS` — 212 m at the flight lens over the baseline, where a rock at
 * the *top* of the size range is still ten pixels. Exported because the streamer
 * fades the far edge over the last part of it and the two have to be the same
 * number, and because `ir.terrain().scatter` reports it.
 */
export const scatterRange = (lens: Lens, viewport: Viewport): Meters =>
  (2 * SMALLEST_ROCK * pixelsPerRadian(lens, viewport)) / ROCK_PIXELS

/**
 * How many regions one selection may hold.
 *
 * A ceiling rather than a working limit, and it is the telephoto end that makes
 * one necessary: `scatterRange` goes as `pixelsPerRadian`, so the disk goes as
 * its square, and a 20° lens at 8× zoom asks for a thousand times the regions a
 * hover does. At the flight lens the answer is five — a 212 m range on Luna's
 * 333 m regions — and thirty-three at the telephoto end, so this never binds on
 * a lens anything is flown behind, and where it does bind the far rocks simply
 * stop rather than the frame going away.
 */
export const DEFAULT_MAX_SCATTER_REGIONS = 96

/**
 * The scatter regions within range of the eye, nearest first.
 *
 * A ring walk out from the region under the camera, taken through
 * `regionNeighbor` so a cube-face edge and a cube corner are somebody else's
 * problem — the same reason `balance` uses it in `terrainSelect`. At a corner
 * three faces meet and the eight-way step names one of them twice, so the walk
 * de-duplicates rather than assuming eight distinct neighbors.
 *
 * Nearest first because the caller's budget is per frame: a partial answer
 * should be the rocks under the camera rather than whichever ring the walk
 * happened to emit.
 */
export function selectScatterRegions(
  eye: ScatterEye,
  options: ScatterSelectOptions = {},
): readonly RegionAddress[] {
  const lens = options.lens
  const viewport = options.viewport
  const maxRegions = options.maxRegions ?? DEFAULT_MAX_SCATTER_REGIONS
  const range =
    lens !== undefined && viewport !== undefined
      ? scatterRange(lens, viewport)
      : 0
  if (!(range > 0)) return []
  /*
   * Height above the datum, which is what decides whether any of this is in
   * range at all. Above the range nothing on the ground is close enough and the
   * walk is skipped outright — which is every frame of a flight and most of a
   * descent, so it is the branch that matters.
   */
  const height = eye.distance - eye.ground
  if (height > range) return []

  const size = regionSize(eye.radius, eye.level)
  // How far the horizontal reach is, given that part of the range is spent
  // climbing: a camera two meters up sees ground almost to the full range, one
  // at four hundred sees a much smaller disk of it.
  const reach = Math.sqrt(Math.max(0, range * range - height * height))
  const rings = Math.min(16, Math.ceil(reach / size) + 1)

  const center = regionForDirection(eye.direction, eye.level)
  const found: { region: RegionAddress; distance: number }[] = []
  const seen = new Set<string>()
  for (let di = -rings; di <= rings; di += 1) {
    for (let dj = -rings; dj <= rings; dj += 1) {
      const region = neighborOf(center, di, dj)
      const key = `${region.face}.${region.i}.${region.j}`
      if (seen.has(key)) continue
      seen.add(key)
      /*
       * Distance to the region's *center*, not to its nearest corner.
       *
       * A region is 333 m across on Luna and the range is 212, so a
       * nearest-point test would admit a ring of regions whose near edge is in
       * range and whose rocks are almost all outside it — half again as many
       * regions for rocks that are drawn and then faded out. The center test
       * costs the far half of the outermost ring, which is rocks at more than
       * the range and therefore under two pixels.
       */
      const to = Vec.scale(regionCentreDirection(region), eye.ground)
      const from = Vec.scale(eye.direction, eye.distance)
      const distance = Vec.length(Vec.sub(to, from))
      if (distance > range + size * 0.5) continue
      found.push({ region, distance })
    }
  }
  found.sort((a, b) => a.distance - b.distance)
  return found.slice(0, maxRegions).map((entry) => entry.region)
}

/** The region `di`/`dj` cells away, staying on this face where it can. */
function neighborOf(
  center: RegionAddress,
  di: number,
  dj: number,
): RegionAddress {
  const span = 2 ** center.level
  const i = center.i + di
  const j = center.j + dj
  if (i >= 0 && i < span && j >= 0 && j < span) {
    return regionAddress(center.face, center.level, i, j)
  }
  return regionNeighbor(center, di, dj)
}
