import fc from 'fast-check'
import { expect, it } from 'vitest'
import { Quaternion as Q, Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { clipOccludedSegment, occludedAt, type Occluder } from './occlusion.ts'

const sphere: Occluder = {
  address: 'body',
  center: vec3(0, 0, -10),
  axes: vec3(2, 2, 2),
  inverse: Q.IDENTITY,
  bounds: [-Infinity, Infinity, -Infinity, Infinity],
}

it('clips the hidden middle even when both endpoints are visible', () => {
  const pieces: [Vec3, Vec3][] = []
  clipOccludedSegment(vec3(-10, 0, -20), vec3(10, 0, -20), [sphere], (a, b) =>
    pieces.push([a, b]),
  )
  expect(pieces).toHaveLength(2)
  const limb = (20 * 2) / Math.sqrt(100 - 4)
  expect(pieces[0]![1].x).toBeCloseTo(-limb, 10)
  expect(pieces[1]![0].x).toBeCloseTo(limb, 10)
})

it('preserves a foreground orbit and clips at the surface when the orbit enters it', () => {
  const foreground: [Vec3, Vec3][] = []
  clipOccludedSegment(vec3(-1, 0, -5), vec3(1, 0, -5), [sphere], (a, b) =>
    foreground.push([a, b]),
  )
  expect(foreground).toEqual([[vec3(-1, 0, -5), vec3(1, 0, -5)]])
  const entering: [Vec3, Vec3][] = []
  clipOccludedSegment(vec3(0, 0, -5), vec3(0, 0, -20), [sphere], (a, b) =>
    entering.push([a, b]),
  )
  expect(entering).toHaveLength(1)
  expect(entering[0]![1].z).toBeCloseTo(-8, 10)
})

it("uses the tilted polar axis and excludes a label's own body", () => {
  const oblate = { ...sphere, axes: vec3(2, 1, 2) }
  expect(occludedAt(vec3(0, 3, -20), [oblate])).toBe(false)
  expect(occludedAt(vec3(3, 0, -20), [oblate])).toBe(true)
  expect(occludedAt(vec3(0, 0, -20), [oblate], 'body')).toBe(false)
  const rotated = {
    ...oblate,
    inverse: Q.conjugate(Q.fromAxisAngle(Vec.UNIT_Z, Math.PI / 2)),
  }
  expect(occludedAt(vec3(0, 3, -20), [rotated])).toBe(true)
  expect(occludedAt(vec3(3, 0, -20), [rotated])).toBe(false)
})

it('agrees with ray intersections at interior points across random segments', () => {
  fc.assert(
    fc.property(
      fc.tuple(
        fc.double({ min: -30, max: 30, noNaN: true }),
        fc.double({ min: -30, max: 30, noNaN: true }),
        fc.double({ min: -30, max: -1, noNaN: true }),
      ),
      fc.tuple(
        fc.double({ min: -30, max: 30, noNaN: true }),
        fc.double({ min: -30, max: 30, noNaN: true }),
        fc.double({ min: -30, max: -1, noNaN: true }),
      ),
      (aa, bb) => {
        const a = vec3(...aa),
          b = vec3(...bb)
        const segments: [Vec3, Vec3][] = []
        clipOccludedSegment(a, b, [sphere], (start, end) =>
          segments.push([start, end]),
        )
        for (let i = 1; i < 20; i++) {
          const p = Vec.lerp(a, b, i / 20)
          const visible = segments.some(
            ([start, end]) =>
              Vec.distance(start, p) + Vec.distance(p, end) <
              Vec.distance(start, end) + 1e-8,
          )
          expect(visible).toBe(!occludedAt(p, [sphere]))
        }
      },
    ),
    { numRuns: 500 },
  )
})
