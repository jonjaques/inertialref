import { Quaternion, type Quat, type Vec3 } from '@inertialref/spatial'

/**
 * Height in the shell's equatorial metric. Resolve the eye in float64 before
 * upload: subtracting planetary radii in a shader loses submeter continuity.
 * Undoing oblateness makes every point on the drawn ellipsoid height zero.
 */
export function cloudShellAltitude(
  eyeFromCenter: Vec3,
  orientation: Quat,
  radius: number,
  flattening: number,
): number {
  const local = Quaternion.rotate(
    Quaternion.conjugate(orientation),
    eyeFromCenter,
  )
  return Math.hypot(local.x, local.y / flattening, local.z) - radius
}
