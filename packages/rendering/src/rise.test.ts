import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, vec3 } from '@inertialref/spatial'
import { FOV_MAX, FOV_MIN } from './lens.ts'
import {
  HORIZON_THIRD,
  RISE_CLEARANCE,
  riseClearance,
  riseFov,
  riseStance,
} from './rise.ts'
import { horizonPitch, localTriad } from './surfaceStance.ts'

/*
 * A rise is a claim with an inverse, which is what makes it testable at all.
 *
 * `riseStance` solves for a place; `riseClearance` reads the parent's elevation
 * back off one. The two are written from different sides of the same geometry —
 * the solve closes a quadratic in `cos θ`, the reading is a dot product — so a
 * round trip that holds is evidence about the arithmetic rather than about one
 * expression appearing twice.
 */

/** The bodies the picture actually has to work for, in meters. */
const LUNA = { radius: 1_737_400, parent: 6_371_000, distance: 384_400_000 }
const PHOBOS = { radius: 11_267, parent: 3_389_500, distance: 9_376_000 }

describe('a rise stance', () => {
  it('puts the parent exactly the clearance above the horizon (property)', () => {
    fc.assert(
      fc.property(
        // A moon, from Phobos to Ganymede.
        fc.double({ min: 1e4, max: 3e6, noNaN: true }),
        // A parent between three and two thousand moon-radii out, which spans
        // Phobos–Mars (832 radii) and Charon–Pluto (17). Three rather than one,
        // so the parent is always outside the eye: nearer than that is the
        // degenerate branch, which has no rise in it to test.
        fc.double({ min: 3, max: 2000, noNaN: true }),
        // Eye height, as a fraction of the moon's own radius — half a radius up
        // is exactly where the surface arm's ceiling is.
        fc.double({ min: 1e-4, max: 0.5, noNaN: true }),
        // Clearance, from grazing to well up the sky.
        fc.double({ min: 0.001, max: 1.2, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        (radius, ratio, lift, clearance, cosLat, longitude) => {
          const height = radius * lift
          // A parent direction anywhere on the sphere, so the solve cannot be
          // right only in the reference plane.
          const lat = Math.asin(cosLat)
          const toParent = Vec.scale(
            vec3(
              Math.cos(lat) * Math.cos(longitude),
              Math.sin(lat),
              Math.cos(lat) * Math.sin(longitude),
            ),
            radius * ratio,
          )
          const stance = riseStance(radius, toParent, height, clearance)
          const read = riseClearance(radius, toParent, stance)
          // Radians, and 1e-9 of one is a hundredth of a milliarcsecond. The
          // bound is the closed form's own residual, not a tolerance for a
          // search: there is no iteration in here to converge.
          expect(read).toBeCloseTo(clearance, 9)
        },
      ),
    )
  })

  it('faces the parent (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e4, max: 3e6, noNaN: true }),
        fc.double({ min: 3, max: 2000, noNaN: true }),
        fc.double({ min: 1e-4, max: 0.5, noNaN: true }),
        fc.double({ min: 0.001, max: 1.2, noNaN: true }),
        (radius, ratio, lift, clearance) => {
          const height = radius * lift
          const toParent = vec3(0.3, 0.6, -0.74)
          const scaled = Vec.scale(Vec.normalize(toParent), radius * ratio)
          const stance = riseStance(radius, scaled, height, clearance)
          const triad = localTriad(stance.up)
          const toward = Vec.normalize(
            Vec.sub(scaled, Vec.scale(stance.up, radius + height)),
          )
          // The heading is a compass bearing: north at zero, swinging east.
          // Reconstructing the horizontal direction from it and comparing to
          // the real one tests the bearing rather than restating `atan2`.
          const bearing = Vec.add(
            Vec.scale(triad.north, Math.cos(stance.heading)),
            Vec.scale(triad.east, Math.sin(stance.heading)),
          )
          const horizontal = Vec.sub(
            toward,
            Vec.scale(triad.up, Vec.dot(toward, triad.up)),
          )
          expect(Vec.dot(bearing, Vec.normalize(horizontal))).toBeCloseTo(1, 9)
        },
      ),
    )
  })

  it('holds the horizon on the lower-third line', () => {
    /*
     * The composition claim, stated at the frame it is composed in. The
     * horizon sits at `-dip` from the local horizontal and the frame's center
     * at `pitch`, so the horizon's distance below the center must be a sixth
     * of the field — a half minus a third.
     */
    const height = 110_000
    const fov = 20
    const stance = riseStance(
      LUNA.radius,
      vec3(LUNA.distance, 0, 0),
      height,
      RISE_CLEARANCE,
      fov,
    )
    const dip = -horizonPitch(LUNA.radius, height)
    const below = stance.pitch - -dip
    expect((below * 180) / Math.PI).toBeCloseTo(
      fov * (1 / 2 - HORIZON_THIRD),
      9,
    )
  })

  it('stands near the limb for Earthrise, and looks back along the ground', () => {
    // The sanity check the property cannot make: that the answer is the place
    // the photograph was taken from. 110 km up, Earth three degrees over the
    // horizon — the eye is a little past the sub-Earth point's terminator,
    // which from that height is 19.9° of dip further round than 90°.
    const stance = riseStance(
      LUNA.radius,
      vec3(LUNA.distance, 0, 0),
      110_000,
      RISE_CLEARANCE,
    )
    const theta = (Math.acos(stance.up.x) * 180) / Math.PI
    expect(theta).toBeGreaterThan(90)
    expect(theta).toBeLessThan(110)
    // Looking down, not up: from 110 km the horizon is well below level.
    expect(stance.pitch).toBeLessThan(0)
  })

  it('degenerates to the sub-parent point when the parent is inside the eye', () => {
    // Not a case any real pair reaches, and it is guarded because the quadratic
    // has no real root there and would otherwise hand back a NaN `up` — which
    // is a NaN camera orientation and a black frame with nothing in the console.
    const stance = riseStance(1_000_000, vec3(500_000, 0, 0), 10_000)
    expect(Number.isFinite(stance.up.x)).toBe(true)
    expect(stance.up.x).toBeCloseTo(1, 12)
  })
})

describe('the lens a rise is framed with', () => {
  it('gives the parent its share of the frame, or the range runs out first', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e4, max: 1e8, noNaN: true }),
        fc.double({ min: 1e6, max: 1e10, noNaN: true }),
        (parentRadius, distance) => {
          const fov = riseFov(parentRadius, distance)
          expect(fov).toBeGreaterThanOrEqual(FOV_MIN)
          expect(fov).toBeLessThanOrEqual(FOV_MAX)
        },
      ),
    )
  })

  it('spans twenty-two to one between the two pairs it exists for', () => {
    /*
     * Why the lens is solved rather than fixed, as a number. Earth from Luna is
     * 1.90° across and Mars from Phobos is 42.39°, so a single focal length that
     * framed one would put the other off the edges or in a corner as a speck.
     */
    const earth = (2 * Math.asin(LUNA.parent / LUNA.distance) * 180) / Math.PI
    const mars =
      (2 * Math.asin(PHOBOS.parent / PHOBOS.distance) * 180) / Math.PI
    expect(earth).toBeCloseTo(1.9, 1)
    expect(mars).toBeCloseTo(42.4, 1)
    expect(mars / earth).toBeGreaterThan(20)

    // Earth wants 11.4° of field for a sixth of the frame and gets the 20°
    // floor; Mars wants far more than the range holds and gets the 110° wall.
    expect(riseFov(LUNA.parent, LUNA.distance)).toBe(FOV_MIN)
    expect(riseFov(PHOBOS.parent, PHOBOS.distance)).toBe(FOV_MAX)
  })
})
