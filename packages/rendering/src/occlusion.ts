import {
  Quaternion as Q,
  Vec,
  vec3,
  type Vec3,
  type Quat,
} from '@inertialref/spatial'
import type { RenderPlacement } from './placement.ts'
import type { RenderScene } from './scene.ts'

/** Camera-local physical coordinates, before radius-dependent compression. */
export function physicalViewPosition(
  scene: RenderScene,
  placement: RenderPlacement,
): Vec3 {
  return Q.rotateInverse(
    scene.camera.orientation,
    Vec.scale(
      Vec.sub(placement.position, scene.camera.position),
      1 / placement.compression,
    ),
  )
}

export interface Occluder {
  readonly address: string
  readonly center: Vec3
  readonly inverse: Quat
  readonly axes: Vec3
  /** A conservative perspective bound, in x/-z and y/-z. */
  readonly bounds: readonly [number, number, number, number]
}

export function sceneOccluders(scene: RenderScene): readonly Occluder[] {
  const result: Occluder[] = []
  const add = (
    address: string,
    placement: RenderPlacement,
    orientation: Quat,
    axes: Vec3,
  ): void => {
    if (placement.scale <= 0 || placement.tier === 'point') return
    const center = physicalViewPosition(scene, placement)
    const radius = Math.max(axes.x, axes.y, axes.z)
    if (center.z >= radius) return
    const d = -center.z
    const bounds: [number, number, number, number] = [
      -Infinity,
      Infinity,
      -Infinity,
      Infinity,
    ]
    if (d > radius) {
      const denominator = d * d - radius * radius
      const x = radius * Math.sqrt(center.x * center.x + denominator)
      const y = radius * Math.sqrt(center.y * center.y + denominator)
      bounds[0] = (center.x * d - x) / denominator
      bounds[1] = (center.x * d + x) / denominator
      bounds[2] = (center.y * d - y) / denominator
      bounds[3] = (center.y * d + y) / denominator
    }
    result.push({
      address,
      center,
      axes,
      bounds,
      inverse: Q.conjugate(
        Q.multiply(Q.conjugate(scene.camera.orientation), orientation),
      ),
    })
  }
  for (const body of scene.bodies) {
    const radius = body.placement.scale / body.placement.compression
    const axes =
      body.figure === null
        ? vec3(radius, radius * body.flattening, radius)
        : vec3(
            (radius * body.figure.semiAxes[0]) / body.trueRadius,
            (radius * body.figure.semiAxes[2]) / body.trueRadius,
            (radius * body.figure.semiAxes[1]) / body.trueRadius,
          )
    add(body.address, body.placement, body.orientation, axes)
  }
  for (const star of scene.stars) {
    const radius = star.placement.scale / star.placement.compression
    add(star.system, star.placement, Q.IDENTITY, vec3(radius, radius, radius))
  }
  return result
}

const units = (p: Vec3, body: Occluder): Vec3 => {
  const v = Q.rotate(body.inverse, p)
  return vec3(v.x / body.axes.x, v.y / body.axes.y, v.z / body.axes.z)
}

function hidden(p: Vec3, c: Vec3): boolean {
  const a = Vec.dot(p, p),
    b = Vec.dot(p, c),
    k = Vec.dot(c, c) - 1
  const discriminant = b * b - a * k
  if (a === 0 || b <= 0 || discriminant <= 0) return false
  const entry = (b - Math.sqrt(discriminant)) / a
  return entry >= 0 && entry < 1
}

export function occludedAt(
  point: Vec3,
  occluders: readonly Occluder[],
  ownAddress = '',
): boolean {
  return occluders.some(
    (body) =>
      body.address !== ownAddress &&
      hidden(units(point, body), units(body.center, body)),
  )
}

/** Visible pieces of a segment, cut exactly at ellipsoid silhouettes and surfaces. */
export function clipOccludedSegment(
  a: Vec3,
  b: Vec3,
  occluders: readonly Occluder[],
  emit: (a: Vec3, b: Vec3) => void,
): void {
  let visible: [number, number][] = [[0, 1]]
  for (const body of occluders) {
    const ax = -a.x / a.z,
      ay = -a.y / a.z,
      bx = -b.x / b.z,
      by = -b.y / b.z
    const [left, right, bottom, top] = body.bounds
    if (
      Math.max(ax, bx) < left ||
      Math.min(ax, bx) > right ||
      Math.max(ay, by) < bottom ||
      Math.min(ay, by) > top
    )
      continue
    const p = units(a, body),
      end = units(b, body),
      d = Vec.sub(end, p),
      c = units(body.center, body)
    const k = Vec.dot(c, c) - 1,
      pc = Vec.dot(p, c),
      dc = Vec.dot(d, c)
    const roots = [0, 1]
    const quadratic = (aa: number, bb: number, cc: number): void => {
      const discriminant = bb * bb - 4 * aa * cc
      if (discriminant < 0) return
      if (Math.abs(aa) < 1e-20) {
        const t = -cc / bb
        if (t > 0 && t < 1) roots.push(t)
        return
      }
      const q = -0.5 * (bb + (bb >= 0 ? 1 : -1) * Math.sqrt(discriminant))
      for (const t of [q / aa, cc / q]) if (t > 0 && t < 1) roots.push(t)
    }
    // Tangent cone, followed by the surface itself. The latter distinguishes
    // a foreground transit from a point behind the same projected disk.
    quadratic(
      dc * dc - k * Vec.dot(d, d),
      2 * (pc * dc - k * Vec.dot(p, d)),
      pc * pc - k * Vec.dot(p, p),
    )
    const fromCenter = Vec.sub(p, c)
    quadratic(
      Vec.dot(d, d),
      2 * Vec.dot(fromCenter, d),
      Vec.dot(fromCenter, fromCenter) - 1,
    )
    roots.sort((x, y) => x - y)
    const next: [number, number][] = []
    for (let i = 1; i < roots.length; i++) {
      const lo = roots[i - 1]!,
        hi = roots[i]!
      if (hidden(Vec.lerp(p, end, (lo + hi) / 2), c)) continue
      for (const [start, stop] of visible) {
        const l = Math.max(lo, start),
          h = Math.min(hi, stop)
        if (h > l) next.push([l, h])
      }
    }
    visible = next
    if (visible.length === 0) return
  }
  for (const [lo, hi] of visible)
    emit(lo === 0 ? a : Vec.lerp(a, b, lo), hi === 1 ? b : Vec.lerp(a, b, hi))
}

/** Screen-motion bound for the solid silhouettes, including their axial rotation. */
export function occluderViewChange(
  before: readonly Occluder[],
  after: readonly Occluder[],
  perRadian: number,
  size: { width: number; height: number },
): number {
  if (before.length !== after.length) return Infinity
  let worst = 0
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!,
      b = after[i]!
    if (a.address !== b.address) return Infinity
    const radius = Math.max(
      a.axes.x,
      a.axes.y,
      a.axes.z,
      b.axes.x,
      b.axes.y,
      b.axes.z,
    )
    const dot = Math.abs(
      a.inverse.x * b.inverse.x +
        a.inverse.y * b.inverse.y +
        a.inverse.z * b.inverse.z +
        a.inverse.w * b.inverse.w,
    )
    const rotation =
      2 *
      (radius -
        Math.min(a.axes.x, a.axes.y, a.axes.z, b.axes.x, b.axes.y, b.axes.z)) *
      Math.sqrt(Math.max(0, 1 - Math.min(1, dot) * Math.min(1, dot)))
    const movement =
      Vec.distance(a.center, b.center) + Vec.distance(a.axes, b.axes) + rotation
    const depth = Math.min(-a.center.z, -b.center.z) - radius - movement
    if (depth <= 0) return Infinity
    worst = Math.max(
      worst,
      (perRadian *
        movement *
        (1 + Math.hypot(size.width, size.height) / (2 * perRadian))) /
        depth,
    )
  }
  return worst
}
