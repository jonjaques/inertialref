import {
  Quaternion as Q,
  Vec,
  type Quat,
  type Vec3,
} from '@inertialref/spatial'

/** The pair's separation and orbital plane define a frame without a preferred pole. */
export function pairFrame(
  separation: Vec3,
  velocity: Vec3,
): { orientation: Quat; distance: number } {
  const distance = Vec.length(separation)
  if (!Number.isFinite(distance) || distance < 1)
    throw new Error('Choose two distinct bodies to track.')
  const x = Vec.scale(separation, 1 / distance)
  const normal = Vec.cross(x, velocity)
  const z = Vec.normalize(
    Vec.length(normal) > 1e-9
      ? normal
      : Vec.cross(
          x,
          Math.abs(x.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 },
        ),
  )
  return { orientation: Q.fromBasis(x, Vec.cross(z, x), z), distance }
}
