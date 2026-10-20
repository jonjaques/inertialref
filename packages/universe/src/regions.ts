import type { Brand, Meters } from '@inertialref/shared'
import { invariant } from '@inertialref/shared'
import {
  type FramePose,
  type UniverseVector,
  type Vec3,
  universeToLocal,
  vec3,
  Vec,
} from '@inertialref/spatial'
import {
  MAX_REGION_LEVEL,
  type RegionAddress,
  regionAddress,
} from './address.ts'
import { COAST_SHAPE } from './bands.ts'
import type { SurfaceParameters } from './system.ts'

/*
 * Cube-sphere surface addressing, and the datums the ground is measured from.
 *
 * A planet's surface is the six faces of a cube projected onto a sphere, each
 * subdivided into a quadtree. That gives every patch of ground a stable integer
 * address at every level of detail, which is what regions, streaming and object
 * placement all hang off. Latitude/longitude grids would be simpler to write
 * and would put a singularity at each pole — the two places a game most wants
 * to fly over.
 *
 * A leaf beneath `terrain.ts` and `drainage.ts`, which both read the lattice
 * and the sea, coast and drainage datums. The elevation field consumes the
 * drainage graph and the graph is built on the lattice and runs down to the
 * datums, so with these in `terrain.ts` the two files imported each other.
 * Nothing here samples the field: every datum is a function of the surface
 * parameters alone. The package exports all of it through `terrain.ts`.
 */

export const FACE_COUNT = 6

/**
 * A unit direction from a body's center, expressed in that body's *rotating*
 * axes.
 *
 * Branded because a bare `Vec3` carries no axes and this is the one place where
 * passing the wrong ones is both easy and silent: terrain is a function of
 * position on the turning body, so an inertial direction leaves the mountains
 * standing still in inertial space while the planet rotates underneath them.
 * That shipped once as "a ship landing 83 m above the ground it had just
 * touched", and it shipped a second time in the drag path, where nothing
 * rendered wrong and nothing failed — the density was simply computed against
 * the wrong mountain.
 *
 * `AGENTS.md` enumerates three producers — `bodyFixedDirection`,
 * `geodeticDirection` and `regionDirection` — and that list is the enforcement
 * mechanism, not a summary of it: none of the three can be reached without a
 * spin frame, a latitude/longitude or a region address, which is what makes the
 * brand worth its cost. `faceToDirection` below is the primitive `regionDirection`
 * is built from and is branded for that reason; production code goes through
 * `regionDirection`, so the list stays three long.
 */
export type BodyFixedDirection = Brand<Vec3, 'body-fixed'>

/** Direction of `position` from the body whose rotating frame is `spinPose`. */
export function bodyFixedDirection(
  spinPose: FramePose,
  position: UniverseVector,
): BodyFixedDirection {
  return Vec.normalize(
    universeToLocal(spinPose, position),
  ) as BodyFixedDirection
}

/** Face-local (u, v) in [-1, 1] to a direction on the unit sphere. */
export function faceToDirection(
  face: number,
  u: number,
  v: number,
): BodyFixedDirection {
  switch (face) {
    case 0:
      return Vec.normalize(vec3(1, v, -u)) as BodyFixedDirection
    case 1:
      return Vec.normalize(vec3(-1, v, u)) as BodyFixedDirection
    case 2:
      return Vec.normalize(vec3(u, 1, -v)) as BodyFixedDirection
    case 3:
      return Vec.normalize(vec3(u, -1, v)) as BodyFixedDirection
    case 4:
      return Vec.normalize(vec3(u, v, 1)) as BodyFixedDirection
    case 5:
      return Vec.normalize(vec3(-u, v, -1)) as BodyFixedDirection
    default:
      invariant(false, `Bad cube face ${face}`)
  }
}

export interface FaceCoordinate {
  readonly face: number
  readonly u: number
  readonly v: number
}

/** Inverse of `faceToDirection`: pick the dominant axis, then project. */
export function directionToFace(direction: Vec3): FaceCoordinate {
  const { x, y, z } = direction
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const az = Math.abs(z)
  if (ax >= ay && ax >= az) {
    return x > 0
      ? { face: 0, u: -z / ax, v: y / ax }
      : { face: 1, u: z / ax, v: y / ax }
  }
  if (ay >= az) {
    return y > 0
      ? { face: 2, u: x / ay, v: -z / ay }
      : { face: 3, u: x / ay, v: z / ay }
  }
  return z > 0
    ? { face: 4, u: x / az, v: y / az }
    : { face: 5, u: -x / az, v: y / az }
}

/** The region containing a direction, at a given subdivision level. */
export function regionForDirection(
  direction: Vec3,
  level: number,
): RegionAddress {
  const { face, u, v } = directionToFace(direction)
  const span = 2 ** level
  const clamp = (t: number): number =>
    Math.min(span - 1, Math.max(0, Math.floor(((t + 1) / 2) * span)))
  return regionAddress(face, level, clamp(u), clamp(v))
}

/** Direction of a region's center. */
export function regionCenterDirection(region: RegionAddress): Vec3 {
  const span = 2 ** region.level
  const u = ((region.i + 0.5) / span) * 2 - 1
  const v = ((region.j + 0.5) / span) * 2 - 1
  return faceToDirection(region.face, u, v)
}

/**
 * Direction of a normalized (s, t) position inside a region.
 *
 * `s` and `t` are in [0,1] over the region itself and **may run outside it**.
 * That is not a tolerated overflow, it is the mechanism a bordered patch and a
 * cross-face neighbor both rest on: the gnomonic map extends smoothly past a
 * cube face's edge, and `normalize` of the extended coordinate lands on exactly
 * the direction the adjacent face parameterizes at that point. Face 0 at
 * u = 1 + ε is face 5 at u = −1/(1 + ε), which is inside face 5 by construction
 * — so a patch that samples one row beyond its own edge is sampling its
 * neighbor's first interior row, whichever face that neighbor is on, with no
 * rotation table and no special case at a face corner.
 *
 * The one limit is range: past |u| ≈ 3 the gnomonic extension is approaching
 * the perpendicular and the cell it names stops being adjacent to anything.
 * Callers step by a border ring or by a cell, which is far inside that.
 */
export function regionDirection(
  region: RegionAddress,
  s: number,
  t: number,
): BodyFixedDirection {
  const span = 2 ** region.level
  const u = ((region.i + s) / span) * 2 - 1
  const v = ((region.j + t) / span) * 2 - 1
  return faceToDirection(region.face, u, v)
}

/**
 * The region `di` cells along u and `dj` cells along v from this one, wrapping
 * onto the adjacent cube face where the step leaves this one.
 *
 * The classic cube-sphere bug farm is the six-by-four table of edge rotations
 * that says which of a neighbor's axes runs which way, and the eight points
 * where three faces meet is where it is always wrong. There is no table here.
 * The step is taken in the *source* face's extended coordinates, turned into a
 * direction — which is the same direction whichever face claims it — and asked
 * which region contains it. The rotation is a consequence of `directionToFace`
 * picking the dominant axis, so it cannot disagree with the sampling in
 * `regionDirection` or with `regionForDirection` in the streamer.
 *
 * At a cube corner three faces meet and there are seven neighbors, not eight:
 * the diagonal step off the corner names one of the three faces rather than a
 * missing fourth, and which one is a consequence of the dominant-axis tie-break.
 * That is a real answer to a question with no answer, and callers that walk a
 * ring have to tolerate a repeat rather than assume eight distinct cells.
 */
export function regionNeighbor(
  region: RegionAddress,
  di: number,
  dj: number,
): RegionAddress {
  const span = 2 ** region.level
  const i = region.i + di
  const j = region.j + dj
  if (i >= 0 && i < span && j >= 0 && j < span) {
    return regionAddress(region.face, region.level, i, j)
  }
  return regionForDirection(
    regionDirection(region, di + 0.5, dj + 0.5),
    region.level,
  )
}

/** The four regions this one subdivides into, in (i, j) order. */
export function regionChildren(
  region: RegionAddress,
): readonly [RegionAddress, RegionAddress, RegionAddress, RegionAddress] {
  invariant(
    region.level < MAX_REGION_LEVEL,
    `Region level ${region.level} cannot subdivide`,
  )
  const level = region.level + 1
  const i = region.i * 2
  const j = region.j * 2
  return [
    regionAddress(region.face, level, i, j),
    regionAddress(region.face, level, i + 1, j),
    regionAddress(region.face, level, i, j + 1),
    regionAddress(region.face, level, i + 1, j + 1),
  ]
}

/** The region one level up that contains this one, or null at a face root. */
export function regionParent(region: RegionAddress): RegionAddress | null {
  if (region.level === 0) return null
  return regionAddress(
    region.face,
    region.level - 1,
    Math.floor(region.i / 2),
    Math.floor(region.j / 2),
  )
}

/** Approximate edge length of a region on the ground, in meters. */
export const regionSize = (radius: Meters, level: number): Meters =>
  (Math.PI * radius) / 2 / 2 ** level

/** Subdivision level whose regions are about `target` meters across. */
export function levelForSize(radius: Meters, target: Meters): number {
  const level = Math.round(
    Math.log2((Math.PI * radius) / 2 / Math.max(1, target)),
  )
  return Math.min(24, Math.max(0, level))
}

/**
 * The level the drainage runs down to, meters: the sea where there is one,
 * and the lowlands where there is not.
 *
 * A valley has to shallow toward *something*, or every channel on a body is
 * a canyon of the same depth at the coast as on the plateau. On a dry world
 * with liquid — rivers that end in basins and lakes — the datum is set below
 * the swell's own range, so the whole surface drains toward its lowest
 * ground and the channels there are dry beds at the floor's own level.
 */
export function drainageDatum(surface: SurfaceParameters): Meters {
  const sea = seaDatumElevation(surface)
  if (sea !== null) return sea
  return (
    DRY_DRAINAGE_DATUM * surface.maxElevation * surface.grammar.bands.hypsometry
  )
}

/**
 * Where a dry world's drainage runs to, as a fraction of the hypsometry
 * share: under the swell's −0.35 and above an ocean plate's −0.55, so a
 * one-plate world drains everywhere and a plate world drains its continents.
 */
const DRY_DRAINAGE_DATUM = -0.45

/** How wide the coast's remap reaches on this body, meters. See `coastRemap`. */
export const coastWidth = (surface: SurfaceParameters): Meters =>
  COAST_SHAPE.width * surface.maxElevation * surface.grammar.bands.hypsometry

/**
 * The elevation the ocean surface sits at, or null on a dry world.
 *
 * Exported because "the single owner of the sea clamp" has to own the *number*
 * as well as the comparison. A second reader — the survey's shore search, which
 * has to score against the unclamped landform and therefore cannot go through
 * `groundElevation` — copied the expression out and put the formula in two
 * places, which is exactly the shape of the bug `groundElevation`'s docstring
 * in `terrain.ts` remembers.
 * Change the remap here and both move together.
 *
 * Scaled by the *hypsometry band's* share of the budget, not by a constant, and
 * that is what makes the datum land between the ocean floor and the continents
 * rather than beside them. Oceanic plates sit at −0.55 to −1 of that share and
 * continental ones at +0.15 to +0.45; `2s − 1` over the drawn range of
 * `seaLevel` runs from −0.7 to +0.1, which crosses the first group and not the
 * second. A fixed fraction of `maxElevation` would put the datum below every
 * seabed on a world whose grammar spends most of its relief on craters, and the
 * ocean would be a dry basin with a sea level in it.
 */
export function seaDatumElevation(surface: SurfaceParameters): Meters | null {
  const sea = surface.seaLevel
  return sea === null
    ? null
    : (sea * 2 - 1) * surface.maxElevation * surface.grammar.bands.hypsometry
}
