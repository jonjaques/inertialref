import {
  Quaternion as Q,
  toRenderSpace,
  UV,
  Vec,
  type Vec3,
  type UniverseVector,
} from '@inertialref/spatial'
import type { RenderScene } from './scene.ts'

export interface OrbitCurve {
  readonly anchor: UniverseVector
  readonly center: Vec3
  readonly cosine: Vec3
  readonly sine: Vec3
}

/** Recover an ellipse from its uniformly spaced eccentric-anomaly samples. */
export function orbitCurve(points: readonly UniverseVector[]): OrbitCurve {
  const anchor = points[0]!
  const step = (2 * Math.PI) / (points.length - 1)
  const next = UV.difference(points[1]!, anchor)
  const previous = UV.difference(points[points.length - 2]!, anchor)
  const center = Vec.scale(
    Vec.add(next, previous),
    1 / (2 * (1 - Math.cos(step))),
  )
  return {
    anchor,
    center,
    cosine: Vec.negate(center),
    sine: Vec.scale(Vec.sub(next, previous), 1 / (2 * Math.sin(step))),
  }
}

export function viewOrbit(
  curve: OrbitCurve,
  shift: Vec3,
  scene: RenderScene,
): Omit<OrbitCurve, 'anchor'> {
  const inverse = Q.conjugate(scene.camera.orientation)
  const originInverse = Q.conjugate(scene.origin.orientation)
  const rotate = (v: Vec3): Vec3 =>
    Q.rotate(inverse, Q.rotate(originInverse, v))
  return {
    center: Vec.add(
      Q.rotate(
        inverse,
        Vec.sub(
          toRenderSpace(scene.origin, curve.anchor),
          scene.camera.position,
        ),
      ),
      rotate(Vec.add(curve.center, shift)),
    ),
    cosine: rotate(curve.cosine),
    sine: rotate(curve.sine),
  }
}

/** A quarter-pixel chord target, with at most 4,096 segments per orbit. */
export function tessellateOrbit(
  curve: Omit<OrbitCurve, 'anchor'>,
  pixelsPerRadian: number,
  size: { width: number; height: number },
  emit: (a: Vec3, b: Vec3) => void,
): void {
  const at = (t: number): Vec3 =>
    Vec.add(
      curve.center,
      Vec.add(
        Vec.scale(curve.cosine, Math.cos(t)),
        Vec.scale(curve.sine, Math.sin(t)),
      ),
    )
  const halfX = size.width / (2 * pixelsPerRadian)
  const halfY = size.height / (2 * pixelsPerRadian)
  const outside = (points: readonly Vec3[]): boolean =>
    points.every((p) => p.z >= -1) ||
    points.every((p) => p.x + p.z * halfX > 0) ||
    points.every((p) => -p.x + p.z * halfX > 0) ||
    points.every((p) => p.y + p.z * halfY > 0) ||
    points.every((p) => -p.y + p.z * halfY > 0)
  const error = (a: Vec3, b: Vec3, m: Vec3): number => {
    if (a.z >= -1 || b.z >= -1 || m.z >= -1) return Infinity
    const ax = -a.x / a.z,
      ay = -a.y / a.z
    const bx = -b.x / b.z,
      by = -b.y / b.z
    const mx = -m.x / m.z,
      my = -m.y / m.z
    const dx = bx - ax,
      dy = by - ay
    const t = Math.max(
      0,
      Math.min(
        1,
        ((mx - ax) * dx + (my - ay) * dy) / Math.max(1e-30, dx * dx + dy * dy),
      ),
    )
    return Math.hypot(mx - ax - t * dx, my - ay - t * dy) * pixelsPerRadian
  }
  const walk = (
    lo: number,
    hi: number,
    a: Vec3,
    b: Vec3,
    depth: number,
  ): void => {
    const mid = (lo + hi) / 2
    const m = at(mid)
    // The ellipse arc lies in the triangle formed by its endpoints and the
    // intersection of their tangents. Unlike three samples, this bound cannot
    // cull a curved arc that enters the viewport between those samples.
    const control = Vec.add(
      curve.center,
      Vec.scale(Vec.sub(m, curve.center), 1 / Math.cos((hi - lo) / 2)),
    )
    if (outside([a, b, control])) return
    if (
      depth < 8 &&
      Math.max(
        error(a, b, m),
        error(a, b, at((lo + mid) / 2)),
        error(a, b, at((mid + hi) / 2)),
      ) > 0.25
    ) {
      walk(lo, mid, a, m, depth + 1)
      walk(mid, hi, m, b, depth + 1)
    } else {
      // A segment crossing the eye cannot be projected onto the trace shell.
      if (a.z >= -1 && b.z >= -1) return
      if (a.z >= -1) a = Vec.lerp(a, b, (-1 - a.z) / (b.z - a.z))
      if (b.z >= -1) b = Vec.lerp(a, b, (-1 - a.z) / (b.z - a.z))
      emit(a, b)
    }
  }
  for (let i = 0; i < 16; i++) {
    const lo = (i * Math.PI * 2) / 16,
      hi = ((i + 1) * Math.PI * 2) / 16
    walk(lo, hi, at(lo), at(hi), 0)
  }
}
