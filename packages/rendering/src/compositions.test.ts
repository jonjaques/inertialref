import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Quaternion as Q, Vec, vec3 } from '@inertialref/spatial'
import {
  aimPoint,
  COMPOSITIONS,
  compositionLook,
  findComposition,
  placeComposition,
  standoffRadii,
} from './compositions.ts'
import { lookAlong } from './cinematic.ts'
import { FLIGHT_FOV, FOV_MAX } from './lens.ts'
import {
  anglesForPhase,
  clampElevation,
  ELEVATION_LIMIT,
  framingDistance,
  isCentred,
  lookToward,
  MIN_DISTANCE_RADII,
  NO_LOOK,
  observerOffset,
  observerPose,
  turn,
} from './observer.ts'
import { localTriad, stanceToward, surfaceStancePose } from './surfaceStance.ts'
import { UV } from '@inertialref/spatial'

/*
 * The aim solve, and the promise it makes to everything composed before it.
 *
 * Free look is an *offset*, so the whole list of compositions has to be
 * unmoved by its arrival: a centre-aimed picture is the pose it always was,
 * bit for bit, and the three that aim elsewhere are the ones that could not be
 * expressed at all. Both halves are stated here, because "the offset defaults
 * to zero" is not the same claim as "zero costs nothing".
 */

const EARTH_RADIUS = 6_371_000

/**
 * What a distance solved two ways may differ by, relative.
 *
 * The same bound `devtools/compositions.test.ts` holds the lens conversion to,
 * and for the same reason: one part in 1e15 of a framing distance is 7.5
 * nanometers at Earth's radius, which is the honest way to say "the same
 * number" about a quantity that is 7e10 at one end of its range and 1e3 at the
 * other.
 */
const FRAMING_TOLERANCE = 1e-14
const SUN = Vec.normalize(vec3(0.6, 0.2, -0.77))

describe('a zero look offset', () => {
  it('returns the base orientation itself', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        fc.double({ min: 1e3, max: 1e12, noNaN: true }),
        (azimuth, elevation, distance) => {
          const state = {
            azimuth,
            elevation: clampElevation(elevation),
            distance,
          }
          const base = lookAlong(
            Vec.negate(observerOffset(state)),
            vec3(0, 1, 0),
          )
          // `toBe` on every field: the compositions are fitted against this
          // pose and an ulp of drift moves every framed body by a number that
          // appears nowhere in the diff.
          expect(turn(base, NO_LOOK)).toEqual(base)
        },
      ),
    )
  })

  it('leaves the observatory pose where it was', () => {
    const target = UV.fromMeters(1e11, 2e10, -3e11)
    const state = { azimuth: 0.6, elevation: 0.25, distance: 4e7 }
    expect(observerPose(target, state, NO_LOOK)).toEqual(
      observerPose(target, state),
    )
  })
})

describe('the look offset', () => {
  it('round-trips through the orientation it produces (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI + 1e-6, max: Math.PI - 1e-6, noNaN: true }),
        fc.double({
          min: -ELEVATION_LIMIT,
          max: ELEVATION_LIMIT,
          noNaN: true,
        }),
        (yaw, pitch) => {
          // Solved in the camera's own axes, so the base is the identity: what
          // is under test is `turn` against `lookToward`, not a frame change.
          const oriented = turn(Q.IDENTITY, { yaw, pitch })
          const forward = Q.rotate(oriented, vec3(0, 0, -1))
          const back = lookToward(forward)
          expect(back.yaw).toBeCloseTo(yaw, 9)
          expect(back.pitch).toBeCloseTo(pitch, 9)
        },
      ),
    )
  })

  it('keeps the horizon level under a pure yaw', () => {
    /*
     * Why yaw runs before pitch. Reversed, the pitch tilts the axis the yaw
     * then turns about, and a look that is up and to the left arrives rolled —
     * the horizon goes off level for a gesture that never asked it to. A pure
     * yaw is the case where the two orders visibly differ least, so the claim
     * is stated on the composed one.
     */
    const oriented = turn(Q.IDENTITY, { yaw: 1.1, pitch: 0.4 })
    const right = Q.rotate(oriented, vec3(1, 0, 0))
    // The camera's right axis stays in the base frame's horizontal plane.
    expect(right.y).toBeCloseTo(0, 12)
  })
})

describe('every composition', () => {
  it('has a unique id and a standoff of exactly one kind', () => {
    const ids = COMPOSITIONS.map((one) => one.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const one of COMPOSITIONS) {
      expect(findComposition(one.id)).toBe(one)
      expect(standoffRadii(one, FLIGHT_FOV)).toBeGreaterThan(1)
    }
  })

  it('solves a fill standoff to the distance that fills the frame', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.double({ min: 20, max: 110, noNaN: true }),
        fc.double({ min: 1e3, max: 7e8, noNaN: true }),
        (value, fov, radius) => {
          const composition = {
            ...findComposition('portrait'),
            standoff: { kind: 'fill', fill: value } as const,
          }
          // Linear in the radius, which is the whole reason the ratio can be
          // solved on a unit sphere and handed to both placers. The bound is
          // relative because the quantity is a distance in meters and spans
          // eight decades here: one ulp of 7e10 is 1.5e-5, which no absolute
          // tolerance can be written to accept and still mean anything at 1e3.
          const wanted = framingDistance(radius, fov, value)
          expect(
            Math.abs(standoffRadii(composition, fov) * radius - wanted) /
              wanted,
          ).toBeLessThan(FRAMING_TOLERANCE)
        },
      ),
    )
  })

  it('gives a centre-aimed one no look offset at all', () => {
    for (const composition of COMPOSITIONS) {
      if (composition.aim !== 'centre') continue
      const placement = placeComposition(
        composition,
        EARTH_RADIUS,
        SUN,
        FLIGHT_FOV,
      )
      expect(placement.kind).toBe('orbit')
      if (placement.kind !== 'orbit') return
      expect(isCentred(placement.look)).toBe(true)
      // And the angles are `anglesForPhase`'s own, unrouted through the solve.
      const angles = anglesForPhase(
        SUN,
        composition.phaseDeg,
        composition.tiltDeg,
      )
      expect(placement.azimuth).toBe(angles.azimuth)
      expect(placement.elevation).toBe(angles.elevation)
    }
  })

  it('puts an aimed one’s aim point in the middle of the frame', () => {
    /*
     * The claim the aim solve exists to make, checked against the geometry
     * rather than against the solve: build the pose the placement describes and
     * confirm its forward axis points at the aim point. `glint` is the only
     * aimed composition that stays on the orbit arm — the other two are low
     * enough to be stances, and they are checked below.
     */
    const composition = findComposition('glint')
    const placement = placeComposition(
      composition,
      EARTH_RADIUS,
      SUN,
      FLIGHT_FOV,
    )
    expect(placement.kind).toBe('orbit')
    if (placement.kind !== 'orbit') return
    const position = observerOffset(placement)
    const base = lookAlong(Vec.negate(position), vec3(0, 1, 0))
    const forward = Q.rotate(turn(base, placement.look), vec3(0, 0, -1))
    const wanted = Vec.normalize(
      Vec.sub(aimPoint(composition.aim, position, EARTH_RADIUS, SUN), position),
    )
    expect(Vec.dot(forward, wanted)).toBeCloseTo(1, 9)
  })

  it('lands the two low ones on the surface arm, facing their aim', () => {
    for (const id of ['sunset', 'oblique']) {
      const composition = findComposition(id)
      const placement = placeComposition(
        composition,
        EARTH_RADIUS,
        SUN,
        FLIGHT_FOV,
      )
      // Below `MIN_DISTANCE_RADII`, so there is no orbit-arm answer for it —
      // which is exactly why these two existed only as ship bookmarks.
      expect(standoffRadii(composition, FLIGHT_FOV)).toBeLessThan(
        MIN_DISTANCE_RADII,
      )
      expect(placement.kind).toBe('surface')
      if (placement.kind !== 'surface') return

      const { orientation } = surfaceStancePose(placement.up, EARTH_RADIUS, {
        latitude: 0,
        longitude: 0,
        height: placement.height,
        ...stanceToward(placement.up, placement.forward),
      })
      const forward = Q.rotate(orientation, vec3(0, 0, -1))
      const eye = Vec.scale(placement.up, EARTH_RADIUS + placement.height)
      const wanted = Vec.normalize(
        Vec.sub(
          Vec.add(
            aimPoint(composition.aim, eye, EARTH_RADIUS, SUN),
            Vec.scale(placement.up, (composition.aimLift ?? 0) * EARTH_RADIUS),
          ),
          eye,
        ),
      )
      expect(Vec.dot(forward, wanted)).toBeCloseTo(1, 9)
    }
  })

  it('never lets a wide lens turn a framing into a stance', () => {
    /*
     * `close` wants 1.95 radii at 65° and 1.27 at 110°, which is below the
     * orbit floor — and the floor is where the surface arm begins. Left to fall
     * through, a centre-aimed framing becomes a stance whose aim point is the
     * body's own centre: `forward` is `-up`, the heading is `atan2(0, 0)` and
     * the camera stares straight down 0.265 radii above the ground, which is
     * not "the disk overflowing the frame" by any reading.
     *
     * A `radii` standoff is the opposite case and stays a stance at any lens,
     * because the author wrote the number rather than the lens producing it.
     */
    for (const id of ['close', 'raking', 'portrait']) {
      const placement = placeComposition(
        findComposition(id),
        EARTH_RADIUS,
        SUN,
        FOV_MAX,
      )
      expect(placement.kind, id).toBe('orbit')
      if (placement.kind !== 'orbit') return
      expect(placement.distance / EARTH_RADIUS, id).toBeGreaterThanOrEqual(
        MIN_DISTANCE_RADII,
      )
    }
    expect(
      placeComposition(findComposition('sunset'), EARTH_RADIUS, SUN, FOV_MAX)
        .kind,
    ).toBe('surface')
  })

  it('keeps a limb stance level with the local horizon', () => {
    // What the surface arm gives for free and `placeShot` has to ask for: a
    // limb shot levels against the local vertical, not the body's axis, so the
    // camera's right axis is horizontal where the eye stands.
    const placement = placeComposition(
      findComposition('sunset'),
      EARTH_RADIUS,
      SUN,
      FLIGHT_FOV,
    )
    if (placement.kind !== 'surface') throw new Error('expected a stance')
    const { orientation } = surfaceStancePose(placement.up, EARTH_RADIUS, {
      latitude: 0,
      longitude: 0,
      height: placement.height,
      ...stanceToward(placement.up, placement.forward),
    })
    const right = Q.rotate(orientation, vec3(1, 0, 0))
    expect(Vec.dot(right, localTriad(placement.up).up)).toBeCloseTo(0, 12)
  })
})

describe('the aim solve', () => {
  it('agrees with the direction it was asked for (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -1.4, max: 1.4, noNaN: true }),
        fc.double({ min: 2, max: 40, noNaN: true }),
        fc.constantFrom('limb' as const, 'specular' as const),
        (azimuth, elevation, ratio, aim) => {
          const distance = ratio * EARTH_RADIUS
          const position = observerOffset({
            azimuth,
            elevation: clampElevation(elevation),
            distance,
          })
          const look = compositionLook(
            { ...findComposition('glint'), aim },
            position,
            EARTH_RADIUS,
            SUN,
          )
          const base = lookAlong(Vec.negate(position), vec3(0, 1, 0))
          const forward = Q.rotate(turn(base, look), vec3(0, 0, -1))
          const wanted = Vec.normalize(
            Vec.sub(aimPoint(aim, position, EARTH_RADIUS, SUN), position),
          )
          expect(Vec.dot(forward, wanted)).toBeCloseTo(1, 8)
        },
      ),
    )
  })
})
