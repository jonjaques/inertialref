import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Quaternion as Q, Vec, type Vec3, vec3 } from '@inertialref/spatial'
import {
  type Attitude,
  attitudeOf,
  horizonDirection,
  horizonOrientation,
  hullInHorizon,
  INERTIAL_HORIZON,
  onBall,
  orientationFor,
  wrapHeading,
} from './navball.ts'

const unit = fc.double({ min: -1, max: 1, noNaN: true })
const direction = fc
  .tuple(unit, unit, unit)
  .map(([x, y, z]) => vec3(x, y, z))
  .filter((v) => Vec.length(v) > 0.1)
  .map((v) => Vec.normalize(v))
const rotation = fc
  .tuple(direction, fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }))
  .map(([axis, angle]) => Q.fromAxisAngle(axis, angle))

/** A horizon that is not degenerate: north not along up. */
const horizonArb = fc
  .tuple(direction, direction)
  .filter(([up, north]) => Math.abs(Vec.dot(up, north)) < 0.95)
  .map(([up, north]) => ({ up, north }))

/** Away from the poles, where the heading stops being a number. */
const attitudeArb: fc.Arbitrary<Attitude> = fc.record({
  pitch: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
  heading: fc.double({ min: 0, max: Math.PI * 2 - 1e-6, noNaN: true }),
  roll: fc.double({ min: -Math.PI + 1e-6, max: Math.PI - 1e-6, noNaN: true }),
})

// Five digits rather than six: a horizon whose north lies within a few
// degrees of its up is conditioned that badly, and the claim is about the
// reading rather than the ulps.
const closeAngle = (a: number, b: number, digits = 5): void => {
  const TAU = Math.PI * 2
  const delta = ((((b - a) % TAU) + TAU + Math.PI) % TAU) - Math.PI
  expect(delta).toBeCloseTo(0, digits)
}

describe('the horizon orientation', () => {
  it('has east, up and north for its axes (property)', () => {
    fc.assert(
      fc.property(horizonArb, (horizon) => {
        const q = horizonOrientation(horizon)
        const up = Vec.normalize(horizon.up)
        expect(Vec.dot(Q.rotate(q, vec3(0, 1, 0)), up)).toBeCloseTo(1, 9)
        // North is the given one squared against up, which is where it lies
        // once the projection is taken out.
        const north = Vec.normalize(
          Vec.sub(horizon.north, Vec.scale(up, Vec.dot(horizon.north, up))),
        )
        expect(Vec.dot(Q.rotate(q, vec3(0, 0, -1)), north)).toBeCloseTo(1, 9)
        const east = Q.rotate(q, vec3(1, 0, 0))
        expect(Vec.dot(east, Vec.cross(north, up))).toBeCloseTo(1, 9)
      }),
    )
  })

  it('is the identity for the inertial reference', () => {
    const q = horizonOrientation(INERTIAL_HORIZON)
    expect(Q.approxEquals(q, Q.IDENTITY, 1e-12)).toBe(true)
  })
})

describe('the attitude', () => {
  it('is zero for a level hull pointing north', () => {
    const level = attitudeOf(Q.IDENTITY, INERTIAL_HORIZON)
    expect(level.pitch).toBeCloseTo(0, 12)
    expect(level.heading).toBeCloseTo(0, 12)
    expect(level.roll).toBeCloseTo(0, 12)
  })

  it('reads a quarter turn to starboard as a heading of east, and a nose-up as pitch', () => {
    // A yaw about up that takes the nose from north to east is clockwise
    // from above, which is a negative turn about +Y.
    const east = attitudeOf(
      Q.fromAxisAngle(vec3(0, 1, 0), -Math.PI / 2),
      INERTIAL_HORIZON,
    )
    expect(east.heading).toBeCloseTo(Math.PI / 2, 9)
    expect(east.pitch).toBeCloseTo(0, 9)
    const up = attitudeOf(Q.fromAxisAngle(vec3(1, 0, 0), 0.3), INERTIAL_HORIZON)
    expect(up.pitch).toBeCloseTo(0.3, 9)
    expect(up.heading).toBeCloseTo(0, 9)
  })

  it('reads a roll to starboard the way the roll key turns it', () => {
    // `flight.rollRight` is a negative turn about +Z, which is a positive
    // one about the nose at −Z: the starboard side goes down.
    const banked = attitudeOf(
      Q.fromAxisAngle(vec3(0, 0, 1), -0.4),
      INERTIAL_HORIZON,
    )
    expect(banked.roll).toBeCloseTo(0.4, 9)
    expect(banked.pitch).toBeCloseTo(0, 9)
    expect(banked.heading).toBeCloseTo(0, 9)
  })

  it('reads the bank in the plane of the nose, however far the nose is pitched', () => {
    // Pitched to 86° and banked a radian: the bank is a radian. Measured
    // against the horizon's up rather than the level up that goes with the
    // nose, it reads a quarter of that — the cosine of the pitch.
    const steep = { pitch: 1.5, heading: 5.04, roll: -1.316 }
    const read = attitudeOf(
      orientationFor(steep, INERTIAL_HORIZON),
      INERTIAL_HORIZON,
    )
    expect(read.roll).toBeCloseTo(steep.roll, 6)
    expect(read.pitch).toBeCloseTo(steep.pitch, 6)
    closeAngle(read.heading, steep.heading)
  })

  it('round-trips through the orientation that has it, against any horizon (property)', () => {
    fc.assert(
      fc.property(attitudeArb, horizonArb, (attitude, horizon) => {
        const read = attitudeOf(orientationFor(attitude, horizon), horizon)
        expect(read.pitch).toBeCloseTo(attitude.pitch, 5)
        closeAngle(read.heading, attitude.heading)
        closeAngle(read.roll, attitude.roll)
      }),
    )
  })

  it('does not depend on the axes the hull and the horizon are posed in (property)', () => {
    // Turn the hull and the horizon together by any rotation: the reading
    // is about their relation and nothing else.
    fc.assert(
      fc.property(rotation, rotation, horizonArb, (ship, turn, horizon) => {
        const here = attitudeOf(ship, horizon)
        const there = attitudeOf(Q.multiply(turn, ship), {
          up: Q.rotate(turn, horizon.up),
          north: Q.rotate(turn, horizon.north),
        })
        expect(there.pitch).toBeCloseTo(here.pitch, 5)
        // Along the pole the heading is a convention; skip the ulp there.
        if (Math.abs(here.pitch) < 1.5) {
          closeAngle(there.heading, here.heading)
          closeAngle(there.roll, here.roll)
        }
      }),
    )
  })
})

describe('the ball', () => {
  it('puts the nose at the centre, facing the viewer (property)', () => {
    fc.assert(
      fc.property(rotation, horizonArb, (ship, horizon) => {
        const local = hullInHorizon(ship, horizon)
        const nose = onBall(local, Q.rotate(local, vec3(0, 0, -1)))
        expect(nose.x).toBeCloseTo(0, 9)
        expect(nose.y).toBeCloseTo(0, 9)
        expect(nose.depth).toBeCloseTo(1, 9)
      }),
    )
  })

  it('paints the horizon at the attitude the reading says (property)', () => {
    // The point of the horizon dead ahead of a level hull lands at the
    // centre; pitch the hull up and it drops down the ball by the sine.
    fc.assert(
      fc.property(
        fc.double({ min: -1.2, max: 1.2, noNaN: true }),
        fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
        (pitch, heading) => {
          const ship = orientationFor(
            { pitch, heading, roll: 0 },
            INERTIAL_HORIZON,
          )
          const local = hullInHorizon(ship, INERTIAL_HORIZON)
          const ahead = onBall(local, horizonDirection(heading, 0))
          expect(ahead.x).toBeCloseTo(0, 6)
          expect(ahead.y).toBeCloseTo(-Math.sin(pitch), 6)
          expect(ahead.depth).toBeCloseTo(Math.cos(pitch), 6)
        },
      ),
    )
  })

  it('lays out the painted directions on the unit sphere (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -1.57, max: 1.57, noNaN: true }),
        (heading, pitch) => {
          const d: Vec3 = horizonDirection(heading, pitch)
          expect(Vec.length(d)).toBeCloseTo(1, 9)
          expect(d.y).toBeCloseTo(Math.sin(pitch), 9)
        },
      ),
    )
    expect(horizonDirection(0, 0)).toEqual(vec3(0, 0, -1))
    expect(horizonDirection(Math.PI / 2, 0).x).toBeCloseTo(1, 9)
  })

  it('wraps a heading onto the compass', () => {
    expect(wrapHeading(-0.5)).toBeCloseTo(Math.PI * 2 - 0.5, 12)
    expect(wrapHeading(Math.PI * 7)).toBeCloseTo(Math.PI, 12)
    expect(wrapHeading(0)).toBe(0)
  })
})
