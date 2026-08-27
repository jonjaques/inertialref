import type { Brand, Meters } from '@inertialref/shared'
import { invariant } from '@inertialref/shared'
import { deriveSeed, fbm3, ridged3 } from '@inertialref/procedural'
import {
  type FramePose,
  type UniverseVector,
  type Vec3,
  universeToLocal,
  vec3,
  Vec,
} from '@inertialref/spatial'
import { type RegionAddress, regionAddress } from './address.ts'
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

/** Direction of a normalized (s, t) ∈ [0,1]² position inside a region. */
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
 * Elevation model.
 *
 * Three bands, which is the smallest number that reads as a planet rather than
 * as noise: continents (very low frequency, decides land from sea), mountains
 * (ridged, so crests are sharp instead of dune-like), and detail. Continents
 * modulate the mountain amplitude so ranges sit on landmasses rather than
 * marching across the ocean floor.
 */
export function elevationAt(
  surface: SurfaceParameters,
  direction: Vec3,
): Meters {
  const d = Vec.normalize(direction)
  const f = surface.roughness
  const continents = fbm3(
    surface.seed,
    d.x * f * 0.5,
    d.y * f * 0.5,
    d.z * f * 0.5,
    { octaves: 4 },
  )
  const mountainSeed = deriveSeed(surface.seed, 'mountains')
  const mountains = ridged3(
    mountainSeed,
    d.x * f * 2.2,
    d.y * f * 2.2,
    d.z * f * 2.2,
    { octaves: 6 },
  )
  const detailSeed = deriveSeed(surface.seed, 'detail')
  const detail = fbm3(detailSeed, d.x * f * 24, d.y * f * 24, d.z * f * 24, {
    octaves: 4,
  })

  const landMask = Math.max(0, continents)
  const height = continents * 0.55 + mountains * landMask * 0.5 + detail * 0.06
  return height * surface.maxElevation
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
 * Change the 0.55 or the `2s − 1` remap here and both move together.
 */
export function seaDatumElevation(surface: SurfaceParameters): Meters | null {
  const sea = surface.seaLevel
  return sea === null ? null : (sea * 2 - 1) * surface.maxElevation * 0.55
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
function datumRadius(body: Body, direction: Vec3): Meters {
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

export interface HeightfieldRequest {
  readonly region: RegionAddress
  /** Vertices per side; see HEIGHTFIELD_RESOLUTION. */
  readonly resolution: number
}

export interface Heightfield {
  readonly region: RegionAddress
  readonly resolution: number
  /** Row-major elevations relative to the body datum, meters. */
  readonly elevations: Float32Array
  readonly minElevation: Meters
  readonly maxElevation: Meters
}

/**
 * Generate one terrain patch.
 *
 * This is the meaningful CPU work that runs in a worker: a 65×65 patch is 4,225
 * samples and each is 14 octaves of 3D noise. The result is a Float32Array
 * precisely so it can be transferred rather than copied back to the main thread.
 */
export function generateHeightfield(
  surface: SurfaceParameters,
  request: HeightfieldRequest,
): Heightfield {
  const { region, resolution } = request
  invariant(
    resolution >= 2 && resolution <= 513,
    `Bad heightfield resolution ${resolution}`,
  )
  const elevations = new Float32Array(resolution * resolution)
  let min = Infinity
  let max = -Infinity
  for (let row = 0; row < resolution; row += 1) {
    const t = row / (resolution - 1)
    for (let col = 0; col < resolution; col += 1) {
      const s = col / (resolution - 1)
      const elevation = groundElevation(surface, regionDirection(region, s, t))
      elevations[row * resolution + col] = elevation
      if (elevation < min) min = elevation
      if (elevation > max) max = elevation
    }
  }
  return {
    region,
    resolution,
    elevations,
    minElevation: min,
    maxElevation: max,
  }
}
