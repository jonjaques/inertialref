import type { Meters } from '@inertialref/shared'
import {
  type BodyFixedDirection,
  type RegionAddress,
  regionAddress,
  regionForDirection,
} from '@inertialref/universe'
import { terrainLevelFor, terrainOpacity } from './lod.ts'

/*
 * Which patches of ground the camera is asking for.
 *
 * This is the streamer's selection rule and nothing else — no cache, no worker,
 * no geometry. It lived inside `apps/game/src/engine/terrainStreamer.ts`, where
 * the only way to ask "what would this camera request?" was to run a browser
 * with a GPU in it, which is why the 1.0 ms terrain line in the frame budget has
 * always been a design figure rather than a measured one. Pulled out, the same
 * question is a function call: the streamer calls it once a frame and the
 * headless descent probe calls it a few hundred times in a millisecond.
 *
 * The rule itself is unchanged, including both of its limits, because Phase 0
 * measures the build that exists rather than the one that is coming. A window
 * that is 3×3 patches wide at one level is not a planet; patches that fall off
 * the edge of a cube face are dropped rather than wrapped onto their neighbor.
 * Both are named here — `windowRadius` and `clipped` — so the phase that fixes
 * them has a number to move rather than a comment to delete.
 */

/** How many rings of neighbors around the camera's own region. */
export const TERRAIN_WINDOW_RADIUS = 1

export interface TerrainWindow {
  /** The subdivision level the whole window is drawn at. */
  readonly level: number
  /** `terrainOpacity` at this distance; 0 means the datum sphere is the honest picture. */
  readonly opacity: number
  /** The region under the camera. */
  readonly centre: RegionAddress
  /** Everything wanted this frame, in a stable order. */
  readonly regions: readonly RegionAddress[]
  /**
   * How many of the neighborhood fell off the edge of the cube face.
   *
   * Zero almost everywhere and up to five over a face corner, where three faces
   * meet and the window is a third of the ground it should be. A count rather
   * than a boolean because it is the size of the hole, and the hole is what
   * Phase 1's cross-face adjacency has to close.
   */
  readonly clipped: number
}

/**
 * The patches under a camera at this distance from this body.
 *
 * Computed whatever the opacity, deliberately. The streamer stops drawing and
 * stops asking above the fade — up there a lone raised tile on the datum sphere
 * is a sticker rather than terrain — but a descent measurement wants to know
 * what the window *would* be at every altitude it passes through, including the
 * ones where nothing is drawn. Callers that stream check `opacity` themselves;
 * that check is one line and belongs where the worker budget is.
 */
export function terrainWindow(
  radius: Meters,
  distance: Meters,
  direction: BodyFixedDirection,
  options: { readonly maxLevel?: number; readonly windowRadius?: number } = {},
): TerrainWindow {
  // `maxLevel` is forwarded rather than defaulted here: `lod.ts` owns the cap,
  // and a second `?? 12` in this file would be a copy that goes stale silently
  // the first time the LOD rule moves it.
  const { maxLevel } = options
  const ring = options.windowRadius ?? TERRAIN_WINDOW_RADIUS
  const level = terrainLevelFor(radius, distance, maxLevel)
  const centre = regionForDirection(direction, level)
  const span = 2 ** level

  const regions: RegionAddress[] = []
  let clipped = 0
  for (let di = -ring; di <= ring; di += 1) {
    for (let dj = -ring; dj <= ring; dj += 1) {
      const i = centre.i + di
      const j = centre.j + dj
      if (i < 0 || j < 0 || i >= span || j >= span) {
        clipped += 1
        continue
      }
      regions.push(regionAddress(centre.face, level, i, j))
    }
  }

  return {
    level,
    opacity: terrainOpacity(radius, distance, maxLevel),
    centre,
    regions,
    clipped,
  }
}

/** The streamer's cache key for a patch: one definition, three readers. */
export const terrainPatchKey = (
  bodyAddress: string,
  region: RegionAddress,
): string =>
  `${bodyAddress}|${region.face}.${region.level}.${region.i}.${region.j}`
