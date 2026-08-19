import { type Vec3, vec3 } from './vec3.ts'

/**
 * Unit quaternion, (x, y, z) vector part and w scalar part.
 *
 * Orientations are quaternions everywhere in the simulation. Euler angles show
 * up only at presentation boundaries: 6-DoF flight has no privileged axis, so
 * any Euler convention gimbal-locks somewhere a player will actually fly.
 */
export interface Quat {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
}

export const IDENTITY: Quat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })

export function quat(x: number, y: number, z: number, w: number): Quat {
  return { x, y, z, w }
}

export function fromAxisAngle(axis: Vec3, angle: number): Quat {
  const len = Math.hypot(axis.x, axis.y, axis.z)
  if (len === 0) return IDENTITY
  const half = angle * 0.5
  const s = Math.sin(half) / len
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) }
}

/** Hamilton product: `a` then `b` applied in `a`'s frame, i.e. rotate by b∘a. */
export function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** Inverse of a unit quaternion. */
export const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })

export function normalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w)
  if (len === 0) return IDENTITY
  const inv = 1 / len
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv }
}

/** Rotate a vector from local axes into the quaternion's parent axes. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  // t = 2 * (q_vec × v); v' = v + q_w * t + q_vec × t
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  }
}

/** Rotate a vector from parent axes into the quaternion's local axes. */
export const rotateInverse = (q: Quat, v: Vec3): Vec3 => rotate(conjugate(q), v)

/**
 * Integrate an orientation by a body-frame angular velocity over dt.
 *
 * Exact rotation about the (constant over the step) angular velocity axis
 * rather than the usual first-order `q + 0.5*ω*q*dt`: the first-order form
 * denormalises, and at time-warp the accumulated drift is visible within a few
 * seconds of wall clock.
 */
export function integrate(q: Quat, angularVelocity: Vec3, dt: number): Quat {
  const omega = Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z)
  if (omega === 0) return q
  const delta = fromAxisAngle(angularVelocity, omega * dt)
  return normalize(multiply(q, delta))
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let end = b
  if (cos < 0) {
    // Take the short way round; -q is the same orientation as q.
    end = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }
    cos = -cos
  }
  if (cos > 0.9995) {
    return normalize({
      x: a.x + (end.x - a.x) * t,
      y: a.y + (end.y - a.y) * t,
      z: a.z + (end.z - a.z) * t,
      w: a.w + (end.w - a.w) * t,
    })
  }
  const theta = Math.acos(cos)
  const sinTheta = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / sinTheta
  const wb = Math.sin(t * theta) / sinTheta
  return {
    x: a.x * wa + end.x * wb,
    y: a.y * wa + end.y * wb,
    z: a.z * wa + end.z * wb,
    w: a.w * wa + end.w * wb,
  }
}

/** Shortest rotation taking unit vector `from` to unit vector `to`. */
export function fromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = from.x * to.x + from.y * to.y + from.z * to.z
  if (d > 0.999_999) return IDENTITY
  if (d < -0.999_999) {
    // Antiparallel: any perpendicular axis works; pick the most stable one.
    const axis = Math.abs(from.x) < 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0)
    const ortho = {
      x: from.y * axis.z - from.z * axis.y,
      y: from.z * axis.x - from.x * axis.z,
      z: from.x * axis.y - from.y * axis.x,
    }
    return fromAxisAngle(ortho, Math.PI)
  }
  return normalize({
    x: from.y * to.z - from.z * to.y,
    y: from.z * to.x - from.x * to.z,
    z: from.x * to.y - from.y * to.x,
    w: 1 + d,
  })
}

/**
 * Quaternion from an orthonormal basis, given as the images of +X, +Y and +Z.
 *
 * Shepperd's method: pick the largest diagonal term first. The naive
 * single-branch formula divides by a quantity that goes to zero for rotations
 * near 180 degrees, which is exactly the case a surface frame on the far side
 * of a planet hits.
 */
export function fromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const trace = x.x + y.y + z.z
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    return normalize({ x: (y.z - z.y) / s, y: (z.x - x.z) / s, z: (x.y - y.x) / s, w: s / 4 })
  }
  if (x.x > y.y && x.x > z.z) {
    const s = Math.sqrt(1 + x.x - y.y - z.z) * 2
    return normalize({ x: s / 4, y: (y.x + x.y) / s, z: (z.x + x.z) / s, w: (y.z - z.y) / s })
  }
  if (y.y > z.z) {
    const s = Math.sqrt(1 + y.y - x.x - z.z) * 2
    return normalize({ x: (y.x + x.y) / s, y: s / 4, z: (z.y + y.z) / s, w: (z.x - x.z) / s })
  }
  const s = Math.sqrt(1 + z.z - x.x - y.y) * 2
  return normalize({ x: (z.x + x.z) / s, y: (z.y + y.z) / s, z: s / 4, w: (x.y - y.x) / s })
}

/** Column-major 3x3 basis of the quaternion, for building render matrices. */
export function basis(q: Quat): { right: Vec3; up: Vec3; forward: Vec3 } {
  return {
    right: rotate(q, { x: 1, y: 0, z: 0 }),
    up: rotate(q, { x: 0, y: 1, z: 0 }),
    // -Z is forward, matching the camera convention Three.js uses.
    forward: rotate(q, { x: 0, y: 0, z: -1 }),
  }
}

export const equals = (a: Quat, b: Quat): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w

export const approxEquals = (a: Quat, b: Quat, epsilon = 1e-9): boolean => {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
  return Math.abs(1 - d) <= epsilon
}
