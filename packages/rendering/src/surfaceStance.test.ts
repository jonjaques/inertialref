import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, vec3, Quaternion as Q } from '@inertialref/spatial'
import { MIN_DISTANCE_RADII } from './observer.ts'
import {
  clampPitch,
  heightForScrub,
  horizonPitch,
  localTriad,
  MIN_STANCE_HEIGHT,
  PITCH_LIMIT,
  scrubForHeight,
  surfaceHeightBounds,
  surfaceStancePose,
} from './surfaceStance.ts'

/*
 * The surface arm's arithmetic, in Node with no world in it.
 *
 * The same bargain `observer.test.ts` makes for the orbit arm. What is proved
 * here is that the numbers are right; that an address resolves to the body they
 * are about is `devtools/terrainRig.test.ts`.
 */

const EARTH = 6_371_000
const LUNA = 1_737_400

/** Radii spanning what the catalog actually contains: Deimos to a super-Earth. */
const radii = fc.double({ min: 6_000, max: 2e7, noNaN: true })

describe('the two observer arms', () => {
  it('meet exactly, with no band that is both or neither', () => {
    // The whole seam. Above `MIN_DISTANCE_RADII` the orbit arm owns the camera;
    // below it this one does. A gap would be a range of heights neither arm
    // could reach, and an overlap would be two cameras claiming the same one.
    fc.assert(
      fc.property(radii, (radius) => {
        const ceiling = surfaceHeightBounds(radius).max
        const floor = radius * MIN_DISTANCE_RADII - radius
        expect(ceiling).toBeCloseTo(floor, 6)
      }),
    )
  })

  it('keeps a usable band even on a body smaller than the eye height', () => {
    // A 6 km asteroid's half-radius is 3 km, which is fine — but the formula
    // has to stay ordered for anything the catalog might grow, and a ceiling
    // below the 2 m floor would invert `clampStanceHeight`.
    fc.assert(
      fc.property(fc.double({ min: 1, max: 2e7, noNaN: true }), (radius) => {
        const { min, max } = surfaceHeightBounds(radius)
        expect(max).toBeGreaterThan(min)
      }),
    )
  })
})

describe('the height scrub', () => {
  it('round-trips through its logarithmic mapping', () => {
    fc.assert(
      fc.property(
        radii,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (radius, t) => {
          const height = heightForScrub(radius, t)
          expect(scrubForHeight(radius, height)).toBeCloseTo(t, 9)
        },
      ),
    )
  })

  it('puts the ground at 0 and the orbit arm’s floor at 1', () => {
    const { min, max } = surfaceHeightBounds(EARTH)
    expect(heightForScrub(EARTH, 0)).toBeCloseTo(min, 9)
    expect(heightForScrub(EARTH, 1)).toBeCloseTo(max, 9)
  })

  it('spends half its travel below 2.5 km on an Earth-sized body', () => {
    /*
     * The reason the mapping is logarithmic rather than linear, as a number.
     *
     * The band is 2 m to 3,186 km. A linear slider puts its midpoint at
     * 1,593 km — above the altitude terrain is drawn at at all — so every
     * interesting height would live in the last few pixels of travel. The log
     * mapping's midpoint is the geometric mean, √(2 · 3.186e6) ≈ 2.5 km, which
     * is a low pass over a mountain range.
     */
    const middle = heightForScrub(EARTH, 0.5)
    expect(middle).toBeGreaterThan(2_000)
    expect(middle).toBeLessThan(3_000)
  })
})

describe('the local triad', () => {
  it('is orthonormal and right-handed everywhere on the sphere', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (sinLat, lon) => {
          const lat = Math.asin(sinLat)
          const up = vec3(
            Math.cos(lat) * Math.cos(lon),
            Math.sin(lat),
            -Math.cos(lat) * Math.sin(lon),
          )
          const { east, north, up: u } = localTriad(up)
          for (const v of [east, north, u]) {
            expect(Vec.length(v)).toBeCloseTo(1, 12)
          }
          expect(Vec.dot(east, north)).toBeCloseTo(0, 12)
          expect(Vec.dot(east, u)).toBeCloseTo(0, 12)
          expect(Vec.dot(north, u)).toBeCloseTo(0, 12)
          // east × north = up is what makes "turn right and you head east" true.
          expect(Vec.distance(Vec.cross(east, north), u)).toBeCloseTo(0, 12)
        },
      ),
    )
  })

  it('produces a finite basis at the poles', () => {
    // Where the pole and the up direction are parallel and east is undefined.
    // Without the fallback the triad is zeros and the camera's orientation
    // becomes NaN — a black frame, with nothing in the console.
    for (const pole of [vec3(0, 1, 0), vec3(0, -1, 0)]) {
      const triad = localTriad(pole)
      expect(Vec.length(triad.east)).toBeCloseTo(1, 12)
      expect(Vec.length(triad.north)).toBeCloseTo(1, 12)
    }
  })
})

describe('the stance pose', () => {
  const up = vec3(0, 0, 1)

  it('puts the eye exactly `height` above the ground radius', () => {
    fc.assert(
      fc.property(
        radii,
        fc.double({ min: MIN_STANCE_HEIGHT, max: 1e6, noNaN: true }),
        (ground, height) => {
          const { offset } = surfaceStancePose(up, ground, {
            latitude: 0,
            longitude: 0,
            height,
            heading: 0,
            pitch: 0,
          })
          // Relative, not absolute: at 2e7 m of ground radius, float64 still
          // resolves millimeters, but the assertion should not pretend to more
          // precision than the magnitude carries.
          expect(Vec.length(offset) / (ground + height)).toBeCloseTo(1, 12)
        },
      ),
    )
  })

  it('aims north at heading 0 and east at heading 90 degrees', () => {
    const triad = localTriad(up)
    const at = (heading: number) =>
      Q.basis(
        surfaceStancePose(up, 1e6, {
          latitude: 0,
          longitude: 0,
          height: 2,
          heading,
          pitch: 0,
        }).orientation,
      ).forward
    expect(Vec.distance(at(0), triad.north)).toBeCloseTo(0, 9)
    expect(Vec.distance(at(Math.PI / 2), triad.east)).toBeCloseTo(0, 9)
    // A compass, not a math angle: heading increases toward east, so a right
    // turn from north is +90 rather than −90.
    expect(Vec.dot(at(Math.PI / 4), triad.east)).toBeGreaterThan(0)
  })

  it('never rolls the horizon, at any latitude', () => {
    /*
     * The bug the local-up hint exists to prevent.
     *
     * Levelling against the pole instead of against the local up tilts the
     * frame by the co-latitude — at 60° north the whole world appears to be on
     * a 30° slope. The test is that the camera's own right vector stays
     * perpendicular to local up, which is what "level" means on a sphere.
     */
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        (sinLat, lon, heading) => {
          const lat = Math.asin(sinLat)
          const u = vec3(
            Math.cos(lat) * Math.cos(lon),
            Math.sin(lat),
            -Math.cos(lat) * Math.sin(lon),
          )
          const { orientation } = surfaceStancePose(u, 1e6, {
            latitude: lat,
            longitude: lon,
            height: 2,
            heading,
            pitch: -0.2,
          })
          expect(Vec.dot(Q.basis(orientation).right, u)).toBeCloseTo(0, 9)
        },
      ),
    )
  })

  it('clamps pitch short of vertical', () => {
    expect(clampPitch(Math.PI)).toBe(PITCH_LIMIT)
    expect(clampPitch(-Math.PI)).toBe(-PITCH_LIMIT)
    const { orientation } = surfaceStancePose(up, 1e6, {
      latitude: 0,
      longitude: 0,
      height: 2,
      heading: 0,
      pitch: Math.PI,
    })
    for (const v of Object.values(Q.basis(orientation))) {
      expect(Number.isFinite(Vec.length(v))).toBe(true)
    }
  })
})

describe('the horizon', () => {
  it('matches the exact dip to the tangent point', () => {
    /*
     * `acos(r / (r + h))`, not the small-angle version, and two anchors are why.
     * From 2 m on Earth the horizon is 5 km away and 0.045° below level —
     * invisible, and a level camera is fine. From 400 km it is 19.79° below, so
     * a camera at pitch zero at the top of a descent is aimed at empty sky with
     * the planet out of frame beneath it. The small-angle approximation √(2h/r)
     * gives 20.30° there: 2.6% wrong, and the error grows with height.
     */
    expect((-horizonPitch(EARTH, 2) * 180) / Math.PI).toBeCloseTo(0.0453, 3)
    expect((-horizonPitch(EARTH, 400_000) * 180) / Math.PI).toBeCloseTo(
      19.793,
      2,
    )
    // Luna's horizon is much closer, which is why its landscapes read as small.
    expect((-horizonPitch(LUNA, 2) * 180) / Math.PI).toBeCloseTo(0.0868, 3)
  })

  it('always looks down, and further down the higher you are', () => {
    fc.assert(
      fc.property(
        radii,
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        (radius, a, b) => {
          expect(horizonPitch(radius, a)).toBeLessThanOrEqual(0)
          if (a < b) {
            expect(horizonPitch(radius, a)).toBeGreaterThanOrEqual(
              horizonPitch(radius, b),
            )
          }
        },
      ),
    )
  })
})
