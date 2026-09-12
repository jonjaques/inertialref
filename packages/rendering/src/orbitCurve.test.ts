import { expect, it } from 'vitest'
import { UV, Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { orbitCurve, orbitViewChange, tessellateOrbit } from './orbitCurve.ts'

it('recovers the analytic ellipse without solving another period of Kepler motion', () => {
  const center = UV.fromMeters(4e16, 1e12, -1e10)
  const points = Array.from({ length: 97 }, (_, i) =>
    UV.translate(
      center,
      vec3(
        1e8 * Math.cos((i * 2 * Math.PI) / 96),
        2e7 * Math.sin((i * 2 * Math.PI) / 96),
        0,
      ),
    ),
  )
  const curve = orbitCurve(points)
  expect(
    Vec.length(UV.difference(UV.translate(curve.anchor, curve.center), center)),
  ).toBeLessThan(0.01)
  expect(Vec.distance(curve.cosine, vec3(1e8, 0, 0))).toBeLessThan(0.01)
  expect(Vec.distance(curve.sine, vec3(0, 2e7, 0))).toBeLessThan(0.01)
})

it('keeps a near-camera ellipse below a third of a pixel of chord error', () => {
  const curve = {
    center: vec3(0, 0, -1e8),
    cosine: vec3(8e7, 0, 0),
    sine: vec3(0, 8e7, 0),
  }
  const segments: [Vec3, Vec3][] = []
  tessellateOrbit(curve, 1500, { width: 3000, height: 3000 }, (a, b) =>
    segments.push([a, b]),
  )
  for (const [a, b] of segments) {
    const midpoint = Vec.lerp(a, b, 0.5)
    const radius = Math.hypot(midpoint.x, midpoint.y)
    expect(((8e7 - radius) / 1e8) * 1500).toBeLessThan(0.33)
  }
  expect(segments.length).toBeLessThanOrEqual(4096)
})

it('spends fewer segments on a distant ellipse and none on one outside the view', () => {
  let count = 0
  const curve = {
    center: vec3(0, 0, -1e12),
    cosine: vec3(8e7, 0, 0),
    sine: vec3(0, 8e7, 0),
  }
  tessellateOrbit(curve, 1500, { width: 3000, height: 3000 }, () => count++)
  expect(count).toBeLessThan(96)
  count = 0
  tessellateOrbit(
    { ...curve, center: vec3(0, 0, 1e12) },
    1500,
    { width: 3000, height: 3000 },
    () => count++,
  )
  expect(count).toBe(0)
})

it('bounds cumulative screen movement and invalidates an offscreen curve entering the view', () => {
  const size = { width: 1600, height: 900 }
  const curve = {
    center: vec3(0, 0, -1e8),
    cosine: vec3(1e7, 0, 0),
    sine: vec3(0, 1e7, 0),
  }
  const depth = tessellateOrbit(curve, 1000, size, () => {})
  const shifted = { ...curve, center: vec3(1000, 0, -1e8) }
  expect(orbitViewChange(curve, shifted, depth, 1000, size)).toBeCloseTo(
    0.01,
    6,
  )
  expect(
    orbitViewChange(
      curve,
      { ...curve, center: vec3(10000, 0, -1e8) },
      depth,
      1000,
      size,
    ),
  ).toBeGreaterThan(0.05)
  const behind = { ...curve, center: vec3(0, 0, 1e8) }
  expect(orbitViewChange(behind, curve, Infinity, 1000, size)).toBe(Infinity)
  expect(orbitViewChange(behind, behind, Infinity, 1000, size)).toBe(0)
})

it('refines the tiny visible part of a planetary orbit beside its own planet', () => {
  const curve = {
    center: vec3(1e12, 0, -2e8),
    cosine: vec3(-1e12, 0, 0),
    sine: vec3(0, 1e10, 1e12),
  }
  const segments: [Vec3, Vec3][] = []
  tessellateOrbit(curve, 1000, { width: 2000, height: 2000 }, (a, b) =>
    segments.push([a, b]),
  )
  let worst = 0
  for (let i = 0; i <= 2000; i++) {
    const t = -0.01 + (i * 0.01019) / 2000
    const p = Vec.add(
      curve.center,
      Vec.add(
        Vec.scale(curve.cosine, Math.cos(t)),
        Vec.scale(curve.sine, Math.sin(t)),
      ),
    )
    if (p.z >= -1) continue
    const x = (-p.x / p.z) * 1000,
      y = (-p.y / p.z) * 1000
    if (Math.abs(x) > 1000 || Math.abs(y) > 1000) continue
    let closest = Infinity
    for (const [a, b] of segments) {
      const ax = (-a.x / a.z) * 1000,
        ay = (-a.y / a.z) * 1000,
        bx = (-b.x / b.z) * 1000,
        by = (-b.y / b.z) * 1000
      const dx = bx - ax,
        dy = by - ay
      const u = Math.max(
        0,
        Math.min(
          1,
          ((x - ax) * dx + (y - ay) * dy) / Math.max(1e-20, dx * dx + dy * dy),
        ),
      )
      closest = Math.min(closest, Math.hypot(x - ax - u * dx, y - ay - u * dy))
    }
    worst = Math.max(worst, closest)
  }
  expect(worst).toBeLessThan(0.33)
  expect(segments.length).toBeLessThan(512)
})
