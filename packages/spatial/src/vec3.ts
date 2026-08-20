import type { Meters } from '@inertialref/shared'

/**
 * Double-precision 3-vector, in whatever frame the caller is holding.
 *
 * This is *not* a universe position — see universeVector.ts for that. A Vec3 is
 * always a displacement or a frame-local coordinate, where double precision is
 * plenty (a 1e6 m local frame has 0.2 nm resolution).
 *
 * Plain readonly objects rather than a class: they survive `structuredClone`
 * to a worker, JSON round-trips without a codec, and the engine keeps them in
 * one hidden class as long as the field order below is preserved everywhere.
 */
export interface Vec3 {
  readonly x: Meters
  readonly y: Meters
  readonly z: Meters
}

export const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 })
export const UNIT_X: Vec3 = Object.freeze({ x: 1, y: 0, z: 0 })
export const UNIT_Y: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 })
export const UNIT_Z: Vec3 = Object.freeze({ x: 0, y: 0, z: 1 })

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

export const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
})
export const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
})
export const mul = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x * b.x,
  y: a.y * b.y,
  z: a.z * b.z,
})
export const scale = (a: Vec3, s: number): Vec3 => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s,
})
export const negate = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z })
export const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

export const lengthSquared = (a: Vec3): number =>
  a.x * a.x + a.y * a.y + a.z * a.z

/** Uses hypot to keep magnitudes near the double range (a 1e20 m vector squares to 1e40). */
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)

export const distance = (a: Vec3, b: Vec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export function normalize(a: Vec3): Vec3 {
  const len = length(a)
  return len === 0 ? ZERO : scale(a, 1 / len)
}

/** Rescale to an exact magnitude. Returns ZERO for a zero-length input. */
export function withLength(a: Vec3, target: number): Vec3 {
  const len = length(a)
  return len === 0 ? ZERO : scale(a, target / len)
}

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})

export const equals = (a: Vec3, b: Vec3): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z

export const approxEquals = (a: Vec3, b: Vec3, epsilon = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= epsilon &&
  Math.abs(a.y - b.y) <= epsilon &&
  Math.abs(a.z - b.z) <= epsilon

export const isFinite3 = (a: Vec3): boolean =>
  Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)

/**
 * Round each component to float32.
 *
 * Render coordinates end up in a Float32Array on the GPU, so tests use this to
 * assert that a value actually survives the trip — asserting on doubles would
 * pass for coordinates the renderer cannot represent.
 */
export const toFloat32 = (a: Vec3): Vec3 => ({
  x: Math.fround(a.x),
  y: Math.fround(a.y),
  z: Math.fround(a.z),
})

export const toArray = (a: Vec3): [number, number, number] => [a.x, a.y, a.z]

export const format = (a: Vec3, digits = 3): string =>
  `(${a.x.toFixed(digits)}, ${a.y.toFixed(digits)}, ${a.z.toFixed(digits)})`
