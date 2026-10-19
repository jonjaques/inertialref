import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Quaternion as Q, Vec, type Vec3, vec3 } from '@inertialref/spatial'
import {
  compassBasis,
  directionToGeodetic,
  geodeticDirection,
} from './frames.ts'

/*
 * The compass every surface basis reads. Orthonormal and right-handed to
 * rounding, east and north the directions `geodeticDirection`'s angles
 * increase along, and a heading that turns about up and nothing else. Those
 * are the four claims the surface frame, a placement and a walker's spawn
 * make about each other by reading one function.
 */

const latitude = fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true })
const longitude = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true })
const heading = fc.double({ min: -2 * Math.PI, max: 2 * Math.PI, noNaN: true })

/** Closed forms with no normalization: a few ulps of a unit vector. */
const ROUNDING = 1e-14

const axes = (orientation: ReturnType<typeof Q.fromBasis>) => ({
  right: Q.rotate(orientation, vec3(1, 0, 0)),
  up: Q.rotate(orientation, vec3(0, 1, 0)),
  forward: Q.rotate(orientation, vec3(0, 0, -1)),
})

const near = (a: Vec3, b: Vec3, tolerance: number): boolean =>
  Vec.length(Vec.sub(a, b)) <= tolerance

describe('compassBasis', () => {
  it('is orthonormal and right-handed everywhere, the poles included (property)', () => {
    fc.assert(
      fc.property(
        fc.oneof(latitude, fc.constantFrom(Math.PI / 2, -Math.PI / 2)),
        longitude,
        heading,
        (lat, lon, h) => {
          const { up, east, north, orientation } = compassBasis(lat, lon, h)
          for (const axis of [up, east, north])
            expect(Math.abs(Vec.length(axis) - 1)).toBeLessThan(ROUNDING)
          expect(Math.abs(Vec.dot(up, east))).toBeLessThan(ROUNDING)
          expect(Math.abs(Vec.dot(up, north))).toBeLessThan(ROUNDING)
          expect(Math.abs(Vec.dot(east, north))).toBeLessThan(ROUNDING)
          // East, north, up: the same handedness as +X, −Z, +Y.
          expect(near(Vec.cross(east, north), up, ROUNDING)).toBe(true)
          // The quaternion's own normalization costs a few ulps more.
          const local = axes(orientation)
          expect(near(local.up, up, 1e-12)).toBe(true)
          expect(
            near(
              Vec.cross(local.right, local.up),
              Vec.negate(local.forward),
              1e-12,
            ),
          ).toBe(true)
        },
      ),
    )
  })

  it('points east where longitude increases and north where latitude does, matching geodeticDirection (property)', () => {
    /*
     * A central difference of `geodeticDirection` is the tangent itself to
     * O(step²); 1e-5 rad leaves the truncation at 1e-10 and the cancellation
     * at 1e-11. East has length cos(latitude) in the derivative, so the band
     * stops short of the poles, where the property is the definition below.
     */
    const step = 1e-5
    fc.assert(
      fc.property(
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        longitude,
        heading,
        (lat, lon, h) => {
          const { up, east, north } = compassBasis(lat, lon, h)
          expect(near(up, geodeticDirection(lat, lon), 0)).toBe(true)
          const alongLongitude = Vec.normalize(
            Vec.sub(
              geodeticDirection(lat, lon + step),
              geodeticDirection(lat, lon - step),
            ),
          )
          const alongLatitude = Vec.normalize(
            Vec.sub(
              geodeticDirection(lat + step, lon),
              geodeticDirection(lat - step, lon),
            ),
          )
          expect(near(east, alongLongitude, 1e-9)).toBe(true)
          expect(near(north, alongLatitude, 1e-9)).toBe(true)
          // And the inverse agrees: a step east reads back as more longitude.
          const stepped = directionToGeodetic(
            Vec.add(up, Vec.scale(east, 1e-6)),
          )
          const gained = Math.atan2(
            Math.sin(stepped.longitude - lon),
            Math.cos(stepped.longitude - lon),
          )
          expect(gained).toBeGreaterThan(0)
        },
      ),
    )
  })

  it("is the meridian's east at a pole, where cross(+Y, up) has no length", () => {
    for (const lon of [-2.5, 0, 0.7, Math.PI]) {
      const { east } = compassBasis(Math.PI / 2, lon, 0)
      const below = compassBasis(Math.PI / 2 - 1e-9, lon, 0)
      expect(near(east, below.east, 1e-12)).toBe(true)
    }
  })

  it('faces north at heading 0 and turns about up, compass-wise, by the heading (property)', () => {
    fc.assert(
      fc.property(latitude, longitude, heading, heading, (lat, lon, a, b) => {
        const level = compassBasis(lat, lon, 0)
        const zero = axes(level.orientation)
        expect(near(zero.forward, level.north, 1e-12)).toBe(true)
        expect(near(zero.right, level.east, 1e-12)).toBe(true)

        const turned = compassBasis(lat, lon, a)
        const local = axes(turned.orientation)
        // Clockwise seen from above: north at 0, east at a quarter turn.
        const expected = Vec.add(
          Vec.scale(level.north, Math.cos(a)),
          Vec.scale(level.east, Math.sin(a)),
        )
        expect(near(local.forward, expected, 1e-12)).toBe(true)
        // A turn about up and nothing else: up is fixed, and it composes.
        expect(near(local.up, level.up, 1e-12)).toBe(true)
        const about = Q.fromAxisAngle(level.up, -b)
        const composed = axes(Q.multiply(about, turned.orientation))
        const direct = axes(compassBasis(lat, lon, a + b).orientation)
        expect(near(composed.forward, direct.forward, 1e-11)).toBe(true)
        expect(near(composed.right, direct.right, 1e-11)).toBe(true)
      }),
    )
  })
})
