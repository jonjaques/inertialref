import { invariant, type Meters } from '@inertialref/shared'
import {
  type FramePose,
  type Quat,
  Quaternion as Q,
  UV,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  type Body,
  type BodyFixedDirection,
  geodeticDirection,
  type SurfacePlacement,
  supportHeightAt,
  surfaceAsset,
  surfaceRadius,
} from '@inertialref/universe'

export type { SurfacePlacement }

/** The asset's own axes in body-fixed coordinates: +X east, +Y up, −Z north, turned by the heading. */
export interface PlacementBasis {
  readonly up: BodyFixedDirection
  readonly east: Vec3
  readonly south: Vec3
  readonly orientation: Quat
}

/*
 * Memoized on the record, which the world freezes and never mutates: a move
 * is a new record. The controller asks for the basis a few times per substep
 * per placement, and two quaternion rotations per ask is the whole cost of
 * a turned pad, but not one worth paying sixty-four times a second for a
 * heading that does not change.
 */
const bases = new WeakMap<SurfacePlacement, PlacementBasis>()

export function placementBasis(placement: SurfacePlacement): PlacementBasis {
  const held = bases.get(placement)
  if (held !== undefined) return held
  const up = geodeticDirection(placement.latitude, placement.longitude)
  const across = Vec.cross(vec3(0, 1, 0), up)
  const east =
    Vec.length(across) > 1e-6
      ? Vec.normalize(across)
      : Vec.normalize(Vec.cross(vec3(1, 0, 0), up))
  const south = Vec.cross(east, up)
  const orientation = Q.multiply(
    Q.fromBasis(east, up, south),
    Q.fromAxisAngle(vec3(0, 1, 0), -placement.heading),
  )
  const basis: PlacementBasis = {
    up,
    east: Q.rotate(orientation, vec3(1, 0, 0)),
    south: Q.rotate(orientation, vec3(0, 0, 1)),
    orientation,
  }
  bases.set(placement, basis)
  return basis
}

/**
 * Radius where a body-fixed ray meets this asset's walkable relief.
 *
 * The relief is meters across on a body thousands of kilometers across, so
 * nearly every ray misses it, and the miss is decided before the terrain is
 * sampled. The ray's offset across the deck grows with the deck's radius, so a
 * deck no lower than the body's deepest ground rejects every ray the real one
 * rejects, and only a ray that survives that pays for the noise stack under
 * the pad. This runs per placement per tick for every ship in the ground band.
 *
 * A ray that reaches the datum plane is then a point on it, in the asset's
 * own meters, and the relief says how high a top stands there. The point is
 * taken on the datum plane rather than on the top it finds, which puts a
 * 2 m enclosure's footprint 30 µm out on a body the size of Mars.
 */
export function surfaceSupportRadius(
  placement: SurfacePlacement,
  body: Body,
  direction: BodyFixedDirection,
): Meters | null {
  const asset = surfaceAsset(placement.assetId)
  if (asset === undefined || asset.support.length === 0) return null
  const basis = placementBasis(placement)
  const cosine = Vec.dot(basis.up, direction)
  if (cosine <= 0) return null
  const tangent = Vec.sub(direction, Vec.scale(basis.up, cosine))
  const reach = asset.footprintRadius
  const limit = reach * reach * cosine * cosine
  const spread = Vec.lengthSquared(tangent)
  // Every band is bounded by the relief and the datum by the polar radius;
  // twice the relief is the margin that keeps a crater floor honest.
  const floor = Math.max(
    0,
    Math.min(body.radius, body.polarRadius) -
      2 * body.surface.maxElevation +
      placement.height,
  )
  if (spread * floor * floor > limit) return null
  const datum = surfaceRadius(body, basis.up) + placement.height
  if (spread * datum * datum > limit) return null
  const scale = datum / cosine
  const x = scale * Vec.dot(tangent, basis.east)
  const z = scale * Vec.dot(tangent, basis.south)
  const top = supportHeightAt(asset, x, z)
  return top === null ? null : (datum + top) / cosine
}

/** Validate before resolving a body, so a rejected placement has no world effects. */
export function validateSurfacePlacement(placement: SurfacePlacement): void {
  for (const field of ['id', 'assetId', 'bodyAddress'] as const)
    invariant(
      typeof placement[field] === 'string' &&
        placement[field].length > 0 &&
        placement[field].length <= 256,
      `Invalid structure ${field}`,
    )
  for (const field of ['latitude', 'longitude', 'height', 'heading'] as const)
    invariant(Number.isFinite(placement[field]), `Invalid structure ${field}`)
  invariant(
    Math.abs(placement.latitude) <= Math.PI / 2,
    'Structure latitude is outside the poles',
  )
  invariant(
    Math.abs(placement.longitude) <= Math.PI,
    'Structure longitude is outside ±pi',
  )
  invariant(placement.height >= 0, 'Structure height must be nonnegative')
  invariant(
    Math.abs(placement.heading) <= Math.PI * 2,
    'Structure heading is outside ±2pi',
  )
}

/** +X east, +Y up, −Z north; supply the drawn radius for presentation. */
export function surfacePlacementPose(
  placement: SurfacePlacement,
  body: Body,
  spin: Pick<FramePose, 'position' | 'orientation'>,
  radius = surfaceRadius(
    body,
    geodeticDirection(placement.latitude, placement.longitude),
  ),
) {
  const basis = placementBasis(placement)
  return {
    position: UV.translate(
      spin.position,
      Q.rotate(
        spin.orientation,
        Vec.scale(basis.up, radius + placement.height),
      ),
    ),
    orientation: Q.multiply(spin.orientation, basis.orientation),
  }
}
