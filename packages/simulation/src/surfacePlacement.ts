import { invariant, type Meters } from '@inertialref/shared'
import {
  type FramePose,
  Quaternion as Q,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  type Body,
  type BodyFixedDirection,
  geodeticDirection,
  type SurfacePlacement,
  surfaceAsset,
  surfaceRadius,
} from '@inertialref/universe'

export type { SurfacePlacement }

/**
 * Radius where a body-fixed ray meets this asset's horizontal support disk.
 *
 * The disk is metres across on a body thousands of kilometres across, so
 * nearly every ray misses it, and the miss is decided before the terrain is
 * sampled. The ray's offset across the deck grows with the deck's radius, so a
 * deck no lower than the body's deepest ground rejects every ray the real one
 * rejects, and only a ray that survives that pays for the noise stack under
 * the pad. This runs per placement per tick for every ship in the ground band.
 */
export function surfaceSupportRadius(
  placement: SurfacePlacement,
  body: Body,
  direction: BodyFixedDirection,
): Meters | null {
  const support = surfaceAsset(placement.assetId)?.supportRadius
  if (support === null || support === undefined) return null
  const up = geodeticDirection(placement.latitude, placement.longitude)
  const cosine = Vec.dot(up, direction)
  if (cosine <= 0) return null
  const tangent = Vec.lengthSquared(Vec.sub(direction, Vec.scale(up, cosine)))
  const limit = support * support * cosine * cosine
  // Every band is bounded by the relief and the datum by the polar radius;
  // twice the relief is the margin that keeps a crater floor honest.
  const floor = Math.max(
    0,
    Math.min(body.radius, body.polarRadius) -
      2 * body.surface.maxElevation +
      placement.height,
  )
  if (tangent * floor * floor > limit) return null
  const deck = surfaceRadius(body, up) + placement.height
  if (tangent * deck * deck > limit) return null
  return deck / cosine
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
  const up = geodeticDirection(placement.latitude, placement.longitude)
  const across = Vec.cross(vec3(0, 1, 0), up)
  const east =
    Vec.length(across) > 1e-6
      ? Vec.normalize(across)
      : Vec.normalize(Vec.cross(vec3(1, 0, 0), up))
  const south = Vec.cross(east, up)
  const base = Q.fromBasis(east, up, south)
  const heading = Q.fromAxisAngle(vec3(0, 1, 0), -placement.heading)
  return {
    position: UV.translate(
      spin.position,
      Q.rotate(spin.orientation, Vec.scale(up, radius + placement.height)),
    ),
    orientation: Q.multiply(spin.orientation, Q.multiply(base, heading)),
  }
}
