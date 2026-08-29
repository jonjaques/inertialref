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
import {
  beltBand,
  hypsometryBand,
  iceBand,
  plateContext,
  reliefBand,
  volcanicBand,
} from './bands.ts'
import { craterField, softLimit } from './craters.ts'
import { CANONICAL_AMPLITUDE_FLOOR, terrainSketch } from './sketch.ts'
import type { Body, SurfaceParameters } from './system.ts'

/*
 * Cube-sphere surface addressing and terrain.
 *
 * A planet's surface is the six faces of a cube projected onto a sphere, each
 * subdivided into a quadtree. That gives every patch of ground a stable integer
 * address at every level of detail, which is what regions, streaming and object
 * placement all hang off. Latitude/longitude grids would be simpler to write
 * and would put a singularity at each pole — the two places a game most wants
 * to fly over.
 *
 * Elevation is a pure function of (surface seed, direction). It is never
 * stored: a heightfield is regenerated from the seed on demand, which is the
 * "do not persist procedurally reproducible data" rule in practice. Only
 * *modifications* to terrain would ever be persisted, as a diff.
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
export function regionCentreDirection(region: RegionAddress): Vec3 {
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

/*
 * Elevation model: the band stack.
 *
 * Six fields, and which of them exist and how loud each is comes from the
 * body's own `SurfaceGrammar` — so Mercury comes out saturated with craters and
 * no soft edges, Earth comes out with continents and orogens and almost no
 * craters at all, and Enceladus comes out with four parallel fractures across a
 * shell nothing has had time to hit. The bands themselves are in `bands.ts`,
 * the crater field in `craters.ts`, and the structure they evaluate against —
 * plate nuclei, hotspots, the crater ladder — in `sketch.ts`.
 *
 * Every band except craters returns roughly [-1, 1] and is scaled by its share
 * of `maxElevation`; the shares sum to one, so the stack is bounded by the peak
 * the strength limit allows and no band can grow past its allowance. Craters
 * work in meters because their shape is published in meters, and they are
 * folded through a soft ceiling on the way in rather than clamped, because a
 * hard clamp flattens the deepest and most interesting ground into a plateau.
 *
 * **One field, at every level.** Nothing here knows what patch is asking or how
 * closely it is sampling. That is not a missed optimization — it is what makes
 * the CDLOD morph exact, and `sketch.ts`'s `craterLadder` carries the argument.
 * The early-out is in the octave counts, which are a property of the body: a
 * 50 km moon runs out of world before it runs out of octaves, and evaluates
 * four where an Earth-sized planet evaluates twelve.
 */
export function elevationAt(
  surface: SurfaceParameters,
  direction: Vec3,
): Meters {
  const d = Vec.normalize(direction)
  const grammar = surface.grammar
  const sketch = terrainSketch(surface)
  const budget = surface.maxElevation
  if (budget <= 0) return 0
  const bands = grammar.bands
  // Three of the bands below read the plate this sample sits on. One lookup,
  // handed to all three — see `plateContext`.
  const plates = plateContext(sketch, d)

  let height =
    bands.hypsometry *
      hypsometryBand(sketch, grammar, plates, d, bands.hypsometry * budget) +
    bands.belts * beltBand(sketch, grammar, plates, d, bands.belts * budget) +
    bands.volcanism *
      volcanicBand(sketch, grammar, plates, d, bands.volcanism * budget) +
    bands.relief *
      reliefBand(sketch, grammar, surface.roughness, d, bands.relief * budget)
  if (bands.ice > 0) {
    height += bands.ice * iceBand(sketch, grammar, d, bands.ice * budget)
  }
  let elevation = height * budget
  if (sketch.craterLevels.length > 0) {
    elevation += softLimit(
      craterField(sketch, grammar, d),
      bands.craters * budget,
    )
  }
  return elevation
}

/**
 * Elevation of the *ground* below a direction: landform, clamped up to the
 * ocean surface where there is one.
 *
 * This is the single owner of the sea clamp. It used to live inside
 * `surfaceRadius` alone, so physics and frames put a landing pad on the ocean
 * datum while `generateHeightfield` — which calls `elevationAt` directly — drew
 * the seabed underneath it. `seaLevel` was carried the whole way to the mesh
 * and then ignored, on roughly 40% of atmosphered rocky planets.
 */
export function groundElevation(
  surface: SurfaceParameters,
  direction: Vec3,
): Meters {
  const sea = seaDatumElevation(surface)
  const elevation = elevationAt(surface, direction)
  return sea === null ? elevation : Math.max(elevation, sea)
}

/**
 * The elevation the ocean surface sits at, or null on a dry world.
 *
 * Exported because "the single owner of the sea clamp" has to own the *number*
 * as well as the comparison. A second reader — the survey's shore search, which
 * has to score against the unclamped landform and therefore cannot go through
 * `groundElevation` — copied the expression out and put the formula in two
 * places, which is exactly the shape of the bug the docstring above remembers.
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

/**
 * How much of a bump a patch may miss before refining it stops being worth a
 * worker's time, in meters.
 *
 * Half a meter is the canonical floor the plan names for the elevation field
 * itself, and the same number does for the mesh: a landing ship spans tens of
 * meters, so ground that is right to within half a meter is ground.
 *
 * It *is* `CANONICAL_AMPLITUDE_FLOOR`, not a second copy of it: the level past
 * which refinement stops buying detail has to be the level past which the field
 * stops having any, and two constants that must be equal are one constant.
 */
export const TERRAIN_DETAIL_TOLERANCE: Meters = CANONICAL_AMPLITUDE_FLOOR

/** Probe directions for `surfaceDetailFloor`, spread by the golden angle. */
const DETAIL_PROBES = 24

/**
 * How many consecutive quiet levels on dry ground settle the floor.
 *
 * Three. Two is enough for the crater ladder alone — its levels are a factor of
 * two apart, so one quiet level followed by another has already stepped past a
 * feature scale — and the third is for the case where two ladders of different
 * bands sit near enough to leave a gap between them. Each extra level is
 * 120 samples, which is a rounding error against the search's total.
 */
const QUIET_RUN = 3
const detailFloorCache = new WeakMap<SurfaceParameters, Map<string, number>>()

/**
 * The subdivision level past which a patch is an upsample of its parent.
 *
 * Refinement is supposed to buy detail, and below some level this field has
 * none left to sell. A fixed ceiling gets that wrong in both directions: at the
 * three bands this replaced, the streamer asked for level 12 wherever the
 * ground was close, which was sixteen times the patches of level 10 for output
 * identical to the last bit of a float; at the band stack it would stop two
 * levels above the finest crater rim.
 *
 * So the floor is measured rather than assumed, and measured from the field
 * rather than from a model of it: at each level, take one grid cell of a patch
 * at that level, and compare the middle of the cell against the bilinear
 * interpolation of its corners. That difference *is* the detail refinement
 * would add. Twenty-four probe directions spread by the golden angle, five
 * samples each, and the search stops at the first level under tolerance whose
 * stencils touched dry ground — a sea-flattened stencil is the clamp talking,
 * not the field, and the walk carries past it.
 *
 * About 1,500 samples, and **16 to 32 ms for a body on the main thread** —
 * Miranda 15.5, Earth 20.4, Iapetus 21.6, Callisto 30.2, Luna 32.2. That is the
 * same order as deriving the body's survey sites rather than the quarter of it
 * this once was, because the band stack and the crater neighborhood both grew
 * under it.
 *
 * **Cold, and the warm figure is half of it.** This is the first thing to touch
 * the band stack for a body, so nothing is JIT-warm when it runs — the same
 * search costs 4 to 16 ms once the field has been sampled, and quoting that
 * figure would be quoting a number the application never pays. It is memoized,
 * and it is paid by `TerrainStreamer.#update` on the frame a body becomes the
 * terrain target: two dropped frames exactly when the player arrives. Nothing
 * about it needs the main thread — `HeightfieldRequestPayload` already carries
 * everything it reads — so the number is here because it is what would justify
 * making it a second task on the pool.
 *
 * This lives beside `elevationAt` because it is a property of those bands and
 * has to move when they do — the band stack put crater rims and scarps into the
 * field at scales the three bands never reached, and this reported a deeper
 * floor the same day, with no constant to raise.
 *
 * **A quiet level is not a floor, and the band stack is why.** With smooth
 * multi-octave noise the residual falls monotonically and the first quiet level
 * is the answer. A crater ladder is *discrete*: level after level of features at
 * one size each, so a stencil that straddles nothing at one level lands on a rim
 * at the next, and the residual comes back up. Taking the first quiet level
 * returned a floor whose own residual was twice the tolerance. So the search
 * asks for three consecutive quiet levels, which is the claim it was making all
 * along — the field has nothing more to say from here down — rather than the
 * weaker one it was testing.
 *
 * One level of margin is added on top, because twenty-four probes are an
 * estimate of a maximum over a sphere and the cost of being one level shallow
 * is ground that is right to a meter instead of to half of one.
 */
export function surfaceDetailFloor(
  radius: Meters,
  surface: SurfaceParameters,
  resolution: number = HEIGHTFIELD_RESOLUTION,
  tolerance: Meters = TERRAIN_DETAIL_TOLERANCE,
): number {
  const held = detailFloorCache.get(surface)
  /*
   * A string, because the arithmetic version collided. `radius * 1e6 +
   * resolution + tolerance` folds three numbers additively, so (65, 0.5) and
   * (64, 1.5) hash the same and whichever call ran first won for both — a pure
   * function whose answer depended on the order it was asked in, which is the
   * one thing generation may never do.
   */
  const key = `${radius}|${resolution}|${tolerance}`
  const cached = held?.get(key)
  if (cached !== undefined) return cached

  const half = 0.5 / (resolution - 1)
  const sea = seaDatumElevation(surface)
  let floor = MAX_REGION_LEVEL
  let flooded: number | null = null
  let everAshore = sea === null
  // How many quiet levels have run consecutively, and the shallowest of them —
  // which is the level the search answers with once the run reaches its length.
  let run = 0
  let runStart = 0
  for (let level = 0; level <= MAX_REGION_LEVEL; level += 1) {
    let peak = 0
    let ashore = sea === null
    for (let probe = 0; probe < DETAIL_PROBES; probe += 1) {
      // Golden-angle spiral: deterministic, and spread rather than clustered at
      // the poles the way a latitude/longitude lattice would be.
      const z = 1 - (2 * probe + 1) / DETAIL_PROBES
      const around = probe * Math.PI * (3 - Math.sqrt(5))
      const ring = Math.sqrt(Math.max(0, 1 - z * z))
      const region = regionForDirection(
        vec3(Math.cos(around) * ring, z, Math.sin(around) * ring),
        level,
      )
      const at = (s: number, t: number): number => {
        const ground = groundElevation(surface, regionDirection(region, s, t))
        if (sea !== null && ground > sea) ashore = true
        return ground
      }
      const corners =
        at(0.5 - half, 0.5 - half) +
        at(0.5 + half, 0.5 - half) +
        at(0.5 - half, 0.5 + half) +
        at(0.5 + half, 0.5 + half)
      const error = Math.abs(at(0.5, 0.5) - corners / 4)
      if (error > peak) peak = error
    }
    /*
     * A quiet level proves nothing when every stencil was at sea. The clamp
     * manufactures exact zeros wherever a probe lands on ocean, and at level 0
     * the twenty-four probes alias onto at most six face-center stencils — so
     * an ocean world whose face centers are all submerged read as "the field
     * has nothing to say" at level 0 and streamed its islands, with kilometers
     * of relief, as six patches forever. A flooded quiet level keeps walking;
     * it settles the floor only on a world with no dry ground at all, where
     * the shallowest one is the honest answer.
     */
    if (peak <= tolerance && ashore) {
      if (run === 0) runStart = level
      run += 1
      if (run >= QUIET_RUN) {
        floor = runStart
        break
      }
    } else {
      /*
       * A flooded level breaks the run rather than extending it, and that is
       * the whole force of the paragraph above. `runStart` is the level the
       * search answers with, so a run that may begin on a flooded level answers
       * with one — the field would never have been asked about the ground
       * there, and the streamer would take a clamp's silence for the field's.
       */
      run = 0
      if (peak <= tolerance && flooded === null) flooded = level
    }
    if (ashore) everAshore = true
  }
  if (floor === MAX_REGION_LEVEL && !everAshore && flooded !== null) {
    floor = flooded
  }

  const answer = Math.min(MAX_REGION_LEVEL, floor + 1)
  const map = held ?? new Map<string, number>()
  map.set(key, answer)
  detailFloorCache.set(surface, map)
  return answer
}

/**
 * The datum radius in a direction, before terrain.
 *
 * For a spheroid this is `radius`, exactly as it has always been. For a body
 * with a `figure` it is that body's measured ellipsoid, and the difference is
 * not cosmetic: `radius` is `a`, the *largest* half-extent, so a sphere of it
 * sits above the real surface everywhere except at the two tips of the long
 * axis. Haumea is 1050 × 840 × 537 km, which puts its poles 513 km inside a
 * sphere of its own equatorial radius — a ship would latch `landed` half a
 * Haumea-radius above anything, with the altitude readout at zero. Phobos was
 * the smaller version of the same bug and a genuine regression: its datum was
 * the 11.27 km mean radius until it gained a figure, and became 13.3.
 *
 * The lumps *below* the ellipsoid are not accounted for here and cannot be:
 * they live in `data/shapes/`, and `packages/universe` may not read a file.
 * That leaves an error bounded by the body's own roughness — a median of 9% of
 * the mean radius across the measured set — against the 50% a sphere of `a`
 * leaves on a body like Haumea. It is the difference between a datum that is
 * approximately the surface and one that is definitely not.
 *
 * A spheroid's own flattening is *also* not accounted for, and that is
 * deliberate rather than an oversight: it has always been that way, Earth's
 * 21 km of polar flattening is the largest case that can be landed on, and
 * changing it moves the ground under every existing save.
 */
export function datumRadius(body: Body, direction: Vec3): Meters {
  const figure = body.figure
  if (figure === null) return body.radius
  /*
   * `+Y is the pole` in body-fixed axes — the same convention `spinEvaluator`
   * and `geodeticDirection` use — so `polarRadius` divides Y and the two
   * equatorial half-extents divide X and Z. Which of `a` and `b` lands on
   * which is a *convention*, not a measurement: the half-extents arrive sorted
   * and nothing records the prime meridian's orientation relative to the long
   * axis. Getting that pair the wrong way round is an error of `a − b`, which
   * is bounded by the difference between two equatorial axes; putting `a` on
   * all three, which is what this replaced, is an error of `a − c`.
   */
  const x = direction.x / body.radius
  const y = direction.y / body.polarRadius
  const z = direction.z / figure.intermediateRadius
  const inverseSquare = x * x + y * y + z * z
  return inverseSquare <= 0 ? body.radius : 1 / Math.sqrt(inverseSquare)
}

/** Radius of the surface below a direction, including elevation and any ocean. */
export function surfaceRadius(
  body: Body,
  direction: BodyFixedDirection,
): Meters {
  return datumRadius(body, direction) + groundElevation(body.surface, direction)
}

/**
 * Vertices per side of a terrain patch. 65 gives a 64-quad patch with a shared
 * edge row, which is what lets neighboring patches stitch without a seam.
 *
 * Single-sourced here because the streamer, the worker task and capability
 * check 10 all have to agree: that check compares worker output to main-thread
 * output sample-by-sample, so two of them drifting apart would not fail, it
 * would compare two differently-sized grids.
 */
export const HEIGHTFIELD_RESOLUTION = 65

/**
 * Rings of samples generated outside the patch's own edge.
 *
 * A central difference needs a neighbor on both sides, so without any border
 * the edge row falls back to a one-sided difference — half the gradient over
 * half the span — and every patch boundary draws as a hairline of mis-shaded
 * ground. That is one ring. The second is the morph: a patch about to hand over
 * to its parent has to shade like its parent as well as sit where its parent
 * sits, and the parent's normal is a difference across *two* of this patch's
 * cells, so the outermost vertex reaches two samples out.
 *
 * Taking those rows from the neighboring *patch* is the other way to get them
 * and is strictly worse: it makes a patch's geometry depend on which of its
 * neighbors happen to be loaded, which is an order dependency in a system whose
 * whole premise is that a patch is a pure function of its address.
 *
 * The cost is (69² − 65²) / 65² = 12.7% more samples, and it buys a patch that
 * needs to know nothing about anybody.
 */
export const HEIGHTFIELD_BORDER = 2

export interface HeightfieldRequest {
  readonly region: RegionAddress
  /** Vertices per side of the patch itself; see HEIGHTFIELD_RESOLUTION. */
  readonly resolution: number
  /** Rings of samples outside the patch. Default `HEIGHTFIELD_BORDER`. */
  readonly border?: number
}

export interface Heightfield {
  readonly region: RegionAddress
  /** Vertices per side of the patch itself, excluding the border. */
  readonly resolution: number
  readonly border: number
  /**
   * Row-major elevations relative to the body datum, meters.
   *
   * `(resolution + 2 · border)²` of them: sample (row, col) of the patch is at
   * `(row + border) · stride + (col + border)`, and negative indices are the
   * border. `heightfieldStride` and `heightfieldSample` are the two readers, so
   * that arithmetic is written once.
   */
  readonly elevations: Float32Array
  /** Over the patch itself. The border is generated but not summarized. */
  readonly minElevation: Meters
  readonly maxElevation: Meters
}

/** Samples per row of a heightfield's array, border included. */
export const heightfieldStride = (field: {
  readonly resolution: number
  readonly border: number
}): number => field.resolution + 2 * field.border

/**
 * One sample, in patch coordinates: (0, 0) is the patch's first vertex and
 * (−1, −1) is the border sample diagonally outside it.
 */
export function heightfieldSample(
  field: Heightfield,
  row: number,
  col: number,
): Meters {
  const stride = heightfieldStride(field)
  const r = row + field.border
  const c = col + field.border
  if (r < 0 || c < 0 || r >= stride || c >= stride) return 0
  return field.elevations[r * stride + c] ?? 0
}

/**
 * Generate one terrain patch.
 *
 * This is the meaningful CPU work that runs in a worker: a bordered 65×65 patch
 * is 4,761 samples and each is six bands and a crater ladder — 32 ms on a rocky
 * airless world, 34 on an icy dead one, 38 on an atmosphered one where the
 * erosion damping reads the analytic gradient. A world with no craters at all
 * is 9.5. The crater neighborhood is nearly all of that spread and most of the
 * total: it walks about five cells an axis, which is what containing the ejecta
 * reach costs (`craters.ts`). The result is a Float32Array precisely so it can be
 * transferred rather than copied back to the main thread.
 *
 * The border samples run `s` and `t` outside [0,1], which `regionDirection`
 * answers on the neighboring face — so the outer ring of a patch at the edge of
 * a cube face is the first interior row of a patch on a different face, exactly
 * equal to what that patch generates for itself. Nothing here knows that
 * happened.
 */
export function generateHeightfield(
  surface: SurfaceParameters,
  request: HeightfieldRequest,
): Heightfield {
  const { region, resolution } = request
  const border = request.border ?? HEIGHTFIELD_BORDER
  invariant(
    resolution >= 2 && resolution <= 513,
    `Bad heightfield resolution ${resolution}`,
  )
  invariant(
    Number.isInteger(border) && border >= 0 && border <= 4,
    `Bad heightfield border ${border}`,
  )
  const stride = resolution + 2 * border
  const elevations = new Float32Array(stride * stride)
  const step = resolution - 1
  let min = Infinity
  let max = -Infinity
  for (let row = -border; row < resolution + border; row += 1) {
    const t = row / step
    for (let col = -border; col < resolution + border; col += 1) {
      const s = col / step
      const index = (row + border) * stride + (col + border)
      elevations[index] = groundElevation(
        surface,
        regionDirection(region, s, t),
      )
      // The extremes describe the patch, not the border: they size the bounding
      // volume the renderer culls against, and a border sample is ground the
      // next patch draws.
      if (row < 0 || col < 0 || row >= resolution || col >= resolution) continue
      // Read back rather than kept: the array is Float32 and the extremes have
      // to bound *it*, not the float64 the generator computed. A bounding
      // volume sized from a value the mesh does not contain is a volume that
      // can be a rounding step too small.
      const elevation = elevations[index] as number
      if (elevation < min) min = elevation
      if (elevation > max) max = elevation
    }
  }
  return {
    region,
    resolution,
    border,
    elevations,
    minElevation: min,
    maxElevation: max,
  }
}
