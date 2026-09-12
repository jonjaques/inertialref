import { expect, it } from 'vitest'
import { UV, Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { orbitCurve, tessellateOrbit } from './orbitCurve.ts'

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
