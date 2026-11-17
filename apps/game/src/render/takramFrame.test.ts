import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { RenderBody, RenderScene } from '@inertialref/rendering'
import {
  type Quat,
  Quaternion as Q,
  type Vec3,
  Vec,
} from '@inertialref/spatial'
import {
  takramAnchor,
  takramPlacement,
  takramSun,
  WGS84_EQUATORIAL_RADIUS,
} from './takramFrame.ts'

/** A body as the placement reads it: where it is, how it is turned, how large. */
function bodyAt(center: Vec3, orientation: Quat, radius: number): RenderBody {
  return {
    address: 'b:test',
    orientation,
    trueRadius: radius,
    placement: { position: center, compression: 1 },
  } as unknown as RenderBody
}

/** A row-major 4×4 on a point. */
const through = (m: readonly number[], p: Vec3): Vec3 => ({
  x: m[0]! * p.x + m[1]! * p.y + m[2]! * p.z + m[3]!,
  y: m[4]! * p.x + m[5]! * p.y + m[6]! * p.z + m[7]!,
  z: m[8]! * p.x + m[9]! * p.y + m[10]! * p.z + m[11]!,
})

const unit = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter(([x, y, z]) => Math.hypot(x, y, z) > 0.2)
  .map(([x, y, z]) => Vec.normalize({ x, y, z }))

const turn = fc
  .tuple(unit, fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }))
  .map(([axis, angle]) => Q.fromAxisAngle(axis, angle))

/** A world, an eye over it and a sun, with the eye well off the body's pole. */
const stance = fc
  .record({
    orientation: turn,
    radius: fc.double({ min: 1e6, max: 2e7, noNaN: true }),
    height: fc.double({ min: 1, max: 20_000, noNaN: true }),
    // Body-fixed, held off the poles, where north has no direction.
    over: unit.filter((v) => Math.abs(v.y) < 0.9),
    sun: unit,
  })
  .map(({ orientation, radius, height, over, sun }) => {
    const up = Q.rotate(orientation, over)
    // The eye near the render origin, as the floating origin keeps it.
    const eye: Vec3 = { x: 12, y: -7, z: 30 }
    const center = Vec.sub(eye, Vec.scale(up, radius + height))
    return { body: bodyAt(center, orientation, radius), eye, up, height, sun }
  })

describe('takramPlacement', () => {
  it('stands the eye over Earth’s equator at its own height, with up along +X', () => {
    fc.assert(
      fc.property(stance, ({ body, eye, up, height, sun }) => {
        const anchor = takramAnchor(body, eye)
        const placed = takramPlacement(body, anchor, eye, sun)
        // A meter in 2e7 is float64's rounding through the body's radius.
        expect(placed.altitude).toBeCloseTo(height, 5)
        expect(placed.drift).toBeLessThan(1e-5)
        expect(placed.eye.x).toBeCloseTo(WGS84_EQUATORIAL_RADIUS + height, 5)
        const at = through(placed.worldToEcef, eye)
        expect(Vec.distance(at, placed.eye)).toBeLessThan(1e-6)
        const above = through(
          placed.worldToEcef,
          Vec.add(eye, Vec.scale(up, 1000)),
        )
        expect(
          Vec.distance(above, Vec.add(at, { x: 1000, y: 0, z: 0 })),
        ).toBeLessThan(1e-6)
      }),
    )
  })

  it('is rigid and right-handed: lengths hold, and east × north is up', () => {
    fc.assert(
      fc.property(stance, unit, ({ body, eye, sun }, away) => {
        const placed = takramPlacement(body, takramAnchor(body, eye), eye, sun)
        const m = placed.worldToEcef
        const point = Vec.add(eye, Vec.scale(away, 5000))
        const moved = Vec.sub(through(m, point), through(m, eye))
        expect(Vec.length(moved)).toBeCloseTo(5000, 6)
        const east: Vec3 = { x: m[4]!, y: m[5]!, z: m[6]! }
        const north: Vec3 = { x: m[8]!, y: m[9]!, z: m[10]! }
        const upward: Vec3 = { x: m[0]!, y: m[1]!, z: m[2]! }
        expect(Vec.distance(Vec.cross(east, north), upward)).toBeLessThan(1e-12)
      }),
    )
  })

  it('points +Z at the body’s pole and carries the sun’s height over the horizon', () => {
    fc.assert(
      fc.property(stance, ({ body, eye, up, sun }) => {
        const placed = takramPlacement(body, takramAnchor(body, eye), eye, sun)
        const pole = Q.rotate(body.orientation, { x: 0, y: 1, z: 0 })
        const toward = through(placed.worldToEcef, Vec.add(eye, pole))
        // The pole's own height over the horizon goes to +X, the rest to +Z.
        expect(toward.z - placed.eye.z).toBeGreaterThan(0)
        expect(Math.abs(toward.y - placed.eye.y)).toBeLessThan(1e-9)
        expect(placed.sun.x).toBeCloseTo(Vec.dot(sun, up), 12)
        expect(Vec.length(placed.sun)).toBeCloseTo(1, 12)
      }),
    )
  })

  it('moves the eye through the field when it moves over the ground, about a held anchor', () => {
    fc.assert(
      fc.property(
        stance,
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        ({ body, eye, up, sun }, step) => {
          const anchor = takramAnchor(body, eye)
          const first = takramPlacement(body, anchor, eye, sun)
          // East in render axes, from the matrix's own second row.
          const east: Vec3 = {
            x: first.worldToEcef[4]!,
            y: first.worldToEcef[5]!,
            z: first.worldToEcef[6]!,
          }
          expect(Math.abs(Vec.dot(east, up))).toBeLessThan(1e-12)
          const moved = Vec.add(eye, Vec.scale(east, step))
          const second = takramPlacement(body, anchor, moved, sun)
          expect(second.eye.y - first.eye.y).toBeCloseTo(step, 5)
          expect(second.eye.z - first.eye.z).toBeCloseTo(0, 5)
          expect(second.drift).toBeCloseTo(Math.abs(step), 5)
        },
      ),
    )
  })
})

/** A placed object as the sun reads it: a render position and a true distance. */
const placedAt = (position: Vec3, distance: number) => ({ position, distance })

/** A scene as the sun reads it: the eye, and the key star or none. */
const sceneOf = (eye: Vec3, star: ReturnType<typeof placedAt> | null) =>
  ({
    camera: { position: eye },
    stars: star === null ? [] : [{ placement: star }],
  }) as unknown as RenderScene

describe('takramSun', () => {
  const eye: Vec3 = { x: 12, y: -7, z: 30 }

  it('is the star’s true direction from the body’s center, whatever compression draws them at', () => {
    fc.assert(
      fc.property(
        unit,
        unit,
        fc.double({ min: 1e10, max: 1e12, noNaN: true }),
        fc.double({ min: 1e7, max: 1e9, noNaN: true }),
        // The share of its true distance each is drawn at.
        fc.double({ min: 1e-6, max: 1, noNaN: true }),
        fc.double({ min: 1e-3, max: 1, noNaN: true }),
        (toStar, toBody, starAway, bodyAway, starDrawn, bodyDrawn) => {
          const star = placedAt(
            Vec.add(eye, Vec.scale(toStar, starAway * starDrawn)),
            starAway,
          )
          const body = {
            orientation: Q.IDENTITY,
            placement: placedAt(
              Vec.add(eye, Vec.scale(toBody, bodyAway * bodyDrawn)),
              bodyAway,
            ),
          } as unknown as RenderBody
          const truly = Vec.normalize(
            Vec.sub(Vec.scale(toStar, starAway), Vec.scale(toBody, bodyAway)),
          )
          // Each render offset is 1e4 m at the least, taken off a position
          // float64 holds to 1e-10 m: 1e-14 of a radian. Nothing after it
          // cancels, the star standing ten times farther than the body.
          expect(
            Vec.distance(takramSun(body, sceneOf(eye, star)), truly),
          ).toBeLessThan(1e-12)
        },
      ),
    )
  })

  it('faces the body’s pole where there is no star to face, and never nowhere', () => {
    fc.assert(
      fc.property(turn, unit, (orientation, toBody) => {
        const body = {
          orientation,
          placement: placedAt(Vec.add(eye, Vec.scale(toBody, 1e7)), 1e7),
        } as unknown as RenderBody
        const pole = Q.rotate(orientation, { x: 0, y: 1, z: 0 })
        // No star in the scene, and a star the eye stands on.
        expect(takramSun(body, sceneOf(eye, null))).toEqual(pole)
        expect(takramSun(body, sceneOf(eye, placedAt(eye, 0)))).toEqual(pole)
      }),
    )
  })
})
