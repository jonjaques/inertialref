import fc from 'fast-check'
import { expect, it } from 'vitest'
import { Vec, vec3 } from '@inertialref/spatial'
import { launchArc, SpringRope } from './springRope.ts'

const anchors = {
  from: vec3(-2, -0.5, 1.2),
  up: vec3(0, 1, 0),
}

it('pins both ends exactly while the interior follows with spring inertia', () => {
  const rope = new SpringRope()
  rope.step(launchArc(anchors.from, anchors.up), 0)
  const held = rope.points[8]!
  const moved = { ...anchors, from: vec3(-1.5, -0.2, 1.2) }
  rope.step(launchArc(moved.from, moved.up), 1 / 120)
  expect(rope.points[0]).toEqual(moved.from)
  expect(rope.points.at(-1)).toEqual(launchArc(moved.from, moved.up).at(-1))
  expect(Vec.distance(rope.points[8]!, held)).toBeLessThan(0.1)
  const first = rope.points[8]!
  for (let index = 0; index < 120; index += 1)
    rope.step(launchArc(moved.from, moved.up), 1 / 120)
  expect(Vec.distance(first, rope.points[8]!)).toBeGreaterThan(0.05)
})

it('takes the same fixed steps at 30, 60 and 120 frames per second', () => {
  const samples = [30, 60, 120].map((fps) => {
    const rope = new SpringRope()
    rope.step(launchArc(anchors.from, anchors.up), 0)
    const moved = { ...anchors, from: vec3(-1.7, -0.2, 1.2) }
    for (let frame = 0; frame < fps; frame += 1)
      rope.step(launchArc(moved.from, moved.up), 1 / fps)
    return rope.points
  })
  expect(samples[0]).toEqual(samples[1])
  expect(samples[1]).toEqual(samples[2])
})

it('stays finite through abrupt pointer moves and delayed frames', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.double({ min: -4, max: 4, noNaN: true }),
          fc.double({ min: -4, max: 4, noNaN: true }),
          fc.double({ min: 0, max: 2, noNaN: true }),
        ),
        { minLength: 1, maxLength: 30 },
      ),
      (moves) => {
        const rope = new SpringRope()
        for (const [x, y, delta] of moves) {
          const next = { ...anchors, from: vec3(x, y, 1.2) }
          rope.step(launchArc(next.from, next.up), delta)
          expect(rope.points[0]).toEqual(next.from)
          expect(rope.points.at(-1)).toEqual(
            launchArc(next.from, next.up).at(-1),
          )
          for (const point of rope.points)
            for (const value of [point.x, point.y, point.z])
              expect(Number.isFinite(value)).toBe(true)
        }
      },
    ),
    { numRuns: 30 },
  )
})

it('launches upward and reaches the ground, with every earlier sample outside it', () => {
  const path = launchArc(anchors.from, anchors.up)
  expect(path[1]!.y).toBeGreaterThan(path[0]!.y)
  expect(Vec.length(path.at(-1)!)).toBeCloseTo(1, 12)
  for (const point of path.slice(0, -1))
    expect(Vec.length(point)).toBeGreaterThan(1)
})

it('reaches ground without an invented final segment when held far away', () => {
  for (const radius of [10, 1e3, 1e8]) {
    const path = launchArc(vec3(-radius, 0, 1.15), anchors.up)
    expect(path.length).toBeGreaterThan(2)
    expect(path.length).toBeLessThan(4096)
    expect(Vec.length(path.at(-1)!)).toBeCloseTo(1, 10)
    expect(Vec.length(path.at(-2)!)).toBeLessThan(1.05)
  }
})
