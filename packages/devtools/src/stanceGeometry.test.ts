import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Quaternion as Q, Vec, type Vec3, vec3 } from '@inertialref/spatial'
import {
  type Body,
  directionToGeodetic,
  drawnSurfaceRadius,
  findBody,
  geodeticDirection,
  parseAddress,
  TEST_CATALOG,
} from '@inertialref/universe'
import {
  clampLatitude,
  entryArc,
  horizonPitch,
  MIN_STANCE_HEIGHT,
  type SurfaceStance,
} from '@inertialref/rendering'
import {
  type Descent,
  descentStance,
  entryArcPreview,
  FLIGHT_FAST,
  FLIGHT_FLOOR_SPEED,
  FLIGHT_MAX_STEP,
  FLIGHT_SPEED_PER_HEIGHT,
  flightDistance,
  flightStep,
  groundRing,
  HOLD_ANGLE,
  holdRing,
  RING_ANGLE,
  RING_LIFT_SHARE,
  RING_SEGMENTS,
} from './stanceGeometry.ts'
import { openSession } from './session.ts'

/*
 * The claims the surface arm's comments make about its figures, as
 * properties: the held ring faces the eye at its stated angle, the ground ring
 * lies on the drawn ground at its stated lift, a flight step covers the
 * distance its speed rule names, and a drop begins at the eye and ends on the
 * point it was given.
 */

function bodyAt(address: string): Body {
  const session = openSession({
    seed: 'inertialref',
    catalog: TEST_CATALOG,
    workers: null,
  })
  const parsed = parseAddress(address)
  if (parsed.kind !== 'body') throw new Error(address)
  const body = findBody(session.world.loadSystem(parsed.system), parsed.body)
  session.dispose()
  if (body === undefined) throw new Error(address)
  return body
}

const MARS = bodyAt('g:milky-way/s:SOL/b:3')

/** A unit vector from two angles, so every direction is reachable. */
const direction = fc
  .record({
    latitude: fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
    longitude: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  })
  .map(({ latitude, longitude }) => geodeticDirection(latitude, longitude))

const point = fc.record({
  x: fc.double({ min: -1e8, max: 1e8, noNaN: true }),
  y: fc.double({ min: -1e8, max: 1e8, noNaN: true }),
  z: fc.double({ min: -1e8, max: 1e8, noNaN: true }),
})

/** Within a relative epsilon of the larger magnitude, or of one. */
function near(a: number, b: number, relative = 1e-9): boolean {
  return Math.abs(a - b) <= relative * Math.max(1, Math.abs(a), Math.abs(b))
}

describe('the held ring', () => {
  it('lies in the plane facing the eye, at range × HOLD_ANGLE from where it is held', () => {
    fc.assert(
      fc.property(point, point, (atXyz, eyeXyz) => {
        const at = vec3(atXyz.x, atXyz.y, atXyz.z)
        const eye = vec3(eyeXyz.x, eyeXyz.y, eyeXyz.z)
        const range = Vec.length(Vec.sub(eye, at))
        fc.pre(range > 1)
        const ring = holdRing(at, eye)
        expect(ring).toHaveLength(RING_SEGMENTS + 1)
        const sight = Vec.scale(Vec.sub(eye, at), 1 / range)
        // Rounded at the scale of the coordinates, not of the ring: a ring a
        // meter across held 1e8 m out carries 1e8 m's float64 step.
        const slack = 1e-12 * (range + Vec.length(at))
        for (const p of ring) {
          const offset = Vec.sub(p, at)
          expect(
            Math.abs(Vec.length(offset) - range * HOLD_ANGLE),
          ).toBeLessThanOrEqual(slack)
          expect(Math.abs(Vec.dot(offset, sight))).toBeLessThanOrEqual(slack)
        }
      }),
    )
  })

  it('takes the screen up it is handed, and closes', () => {
    fc.assert(
      fc.property(direction, direction, (sight, up) => {
        fc.pre(Math.abs(Vec.dot(sight, up)) < 0.99)
        const eye = Vec.scale(sight, 1e6)
        const ring = holdRing(vec3(0, 0, 0), eye, up)
        // The first point is right of the sight line, perpendicular to up.
        expect(Math.abs(Vec.dot(ring[0]!, up))).toBeLessThan(1e-6)
        // A loop: the last point is the first.
        expect(
          Vec.length(Vec.sub(ring[0]!, ring[RING_SEGMENTS]!)),
        ).toBeLessThan(1e-6)
      }),
    )
  })

  it('is empty with the eye on it', () => {
    expect(holdRing(vec3(1, 2, 3), vec3(1, 2, 3))).toEqual([])
  })
})

describe('the ground ring', () => {
  it('sits exactly across × RING_LIFT_SHARE above the drawn ground, along each point’s own direction', () => {
    fc.assert(
      fc.property(
        direction,
        direction,
        fc.double({ min: 1.0001, max: 50, noNaN: true }),
        (center, sight, radii) => {
          const touchdown = MARS.radius
          const eye = Vec.scale(sight, MARS.radius * radii)
          const ring = groundRing(MARS, center, touchdown, eye)
          expect(ring).toHaveLength(RING_SEGMENTS + 1)
          const range = Math.max(
            1,
            Vec.length(Vec.sub(eye, Vec.scale(center, touchdown))),
          )
          const across = Math.min(MARS.radius * 0.22, range * RING_ANGLE)
          for (const p of ring) {
            const { latitude, longitude } = directionToGeodetic(p)
            const up = geodeticDirection(latitude, longitude)
            const lift = Vec.length(p) - drawnSurfaceRadius(MARS, up)
            // Meters at a planetary radius: float64 holds a micrometer there.
            expect(Math.abs(lift - across * RING_LIFT_SHARE)).toBeLessThan(1e-3)
          }
        },
      ),
      { numRuns: 40 },
    )
  })

  it('stays within a sixth of a turn of its center however far the eye is', () => {
    fc.assert(
      fc.property(
        direction,
        direction,
        fc.double({ min: 1.0001, max: 1e4, noNaN: true }),
        (center, sight, radii) => {
          const ring = groundRing(
            MARS,
            center,
            MARS.radius,
            Vec.scale(sight, MARS.radius * radii),
          )
          for (const p of ring)
            expect(Vec.dot(Vec.normalize(p), center)).toBeGreaterThanOrEqual(
              Math.cos(Math.PI / 3) - 1e-9,
            )
        },
      ),
      { numRuns: 40 },
    )
  })
})

describe('the drop aid', () => {
  it('holds the figure above the aim and lands it on the drawn ground', () => {
    fc.assert(
      fc.property(
        direction,
        fc.double({ min: 1.2, max: 20, noNaN: true }),
        (sight, radii) => {
          const eye = Vec.scale(sight, MARS.radius * radii)
          const { latitude, longitude } = directionToGeodetic(sight)
          const aid = entryArcPreview(MARS, eye, { latitude, longitude }, 24)
          expect(aid).not.toBeNull()
          // The aid clamps the latitude short of the pole, as a stance does.
          const ground = geodeticDirection(clampLatitude(latitude), longitude)
          const groundRadius = drawnSurfaceRadius(MARS, ground) / MARS.radius
          // The figure is on the aim's vertical, above the ground.
          expect(
            Vec.length(Vec.cross(Vec.normalize(aid!.from), ground)),
          ).toBeLessThan(1e-9)
          expect(Vec.length(aid!.from)).toBeGreaterThan(groundRadius)
          // And the touchdown is eye height over the drawn ground under it.
          expect(
            Math.abs(
              Vec.length(aid!.touchdown) -
                groundRadius -
                MIN_STANCE_HEIGHT / MARS.radius,
            ),
          ).toBeLessThan(1e-12)
          expect(aid!.arc.length).toBeGreaterThan(0)
          expect(aid!.ring).toHaveLength(RING_SEGMENTS + 1)
          expect(aid!.hold).toHaveLength(RING_SEGMENTS + 1)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('carries a launched aim’s own path and rings it', () => {
    const launch = [vec3(1.5, 0, 0), vec3(1.2, 0.2, 0), vec3(1.001, 0.05, 0)]
    const aid = entryArcPreview(MARS, vec3(MARS.radius * 3, 0, 0), {
      latitude: 0,
      longitude: 0.05,
      launch,
      up: vec3(0, 0, 1),
    })
    expect(aid?.arc).toBe(launch)
    expect(aid?.from).toBe(launch[0])
    expect(aid?.touchdown).toBe(launch[2])
    expect(aid?.through).toEqual([])
    expect(aid?.hold).toHaveLength(RING_SEGMENTS + 1)
  })
})

describe('a flight step', () => {
  const stance = fc.record({
    latitude: fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
    longitude: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
    height: fc.double({ min: MIN_STANCE_HEIGHT, max: 2e6, noNaN: true }),
    heading: fc.double({ min: -10, max: 10, noNaN: true }),
    pitch: fc.constant(0),
  }) as fc.Arbitrary<SurfaceStance>
  const flight = fc.record({
    forward: fc.double({ min: -1, max: 1, noNaN: true }),
    right: fc.double({ min: -1, max: 1, noNaN: true }),
    up: fc.double({ min: -1, max: 1, noNaN: true }),
    fast: fc.boolean(),
  })
  const dt = fc.double({ min: 1e-4, max: 1, noNaN: true })

  it('keeps |latitude| ≤ π/2', () => {
    fc.assert(
      fc.property(stance, flight, dt, (from, keys, seconds) => {
        const step = flightStep(from, keys, MARS.radius, seconds)!
        expect(Math.abs(step.latitude)).toBeLessThanOrEqual(Math.PI / 2)
      }),
    )
  })

  it('covers max(FLIGHT_FLOOR_SPEED, height × FLIGHT_SPEED_PER_HEIGHT) a second, FLIGHT_FAST times that when asked', () => {
    fc.assert(
      fc.property(
        stance.filter((s) => Math.abs(s.latitude) < 1.2),
        flight,
        fc.double({ min: 1e-4, max: FLIGHT_MAX_STEP, noNaN: true }),
        (from, keys, seconds) => {
          const speed =
            Math.max(
              FLIGHT_FLOOR_SPEED,
              from.height * FLIGHT_SPEED_PER_HEIGHT,
            ) * (keys.fast ? FLIGHT_FAST : 1)
          const distance = flightDistance(from.height, keys.fast, seconds)
          expect(near(distance, speed * seconds)).toBe(true)
          const step = flightStep(from, keys, MARS.radius, seconds)!
          const reach = MARS.radius + from.height
          // Never past a pole, and not across the antimeridian, where the
          // longitude difference below would count the wrap.
          fc.pre(
            Math.abs(step.latitude) < Math.PI / 2 &&
              Math.abs(step.longitude - from.longitude) < Math.PI,
          )
          const north = (step.latitude - from.latitude) * reach
          const east =
            (step.longitude - from.longitude) * reach * Math.cos(step.latitude)
          const keyed = Math.hypot(keys.forward, keys.right)
          expect(
            Math.abs(Math.hypot(north, east) - distance * keyed),
          ).toBeLessThanOrEqual(1e-6 * Math.max(1, distance))
          expect(near(step.height, from.height + keys.up * distance)).toBe(true)
        },
      ),
    )
  })

  it('trusts no frame longer than FLIGHT_MAX_STEP, and moves nothing in no time', () => {
    expect(flightDistance(100, false, 5)).toBe(
      flightDistance(100, false, FLIGHT_MAX_STEP),
    )
    const still: SurfaceStance = {
      latitude: 0,
      longitude: 0,
      height: 10,
      heading: 0,
      pitch: 0,
    }
    const keys = { forward: 1, right: 0, up: 0, fast: false }
    expect(flightStep(still, keys, MARS.radius, 0)).toBeNull()
    expect(flightStep(still, keys, MARS.radius, -1)).toBeNull()
    expect(flightStep(still, keys, MARS.radius, Number.NaN)).toBeNull()
  })

  it('wraps a step across the antimeridian rather than past it', () => {
    const step = flightStep(
      {
        latitude: 0,
        longitude: Math.PI - 1e-9,
        height: 1e5,
        heading: Math.PI / 2,
        pitch: 0,
      },
      { forward: 1, right: 0, up: 0, fast: true },
      MARS.radius,
      FLIGHT_MAX_STEP,
    )!
    expect(step.longitude).toBeLessThan(0)
    expect(step.longitude).toBeGreaterThan(-Math.PI)
  })
})

describe('a drop', () => {
  /** A release from `radii` out over `from`, aimed at `to`. */
  function descent(from: Vec3, to: Vec3, radii: number): Descent | null {
    const { latitude, longitude } = directionToGeodetic(to)
    const ground = geodeticDirection(latitude, longitude)
    const arc = entryArc(
      Vec.scale(from, MARS.radius * radii),
      Vec.scale(ground, drawnSurfaceRadius(MARS, ground) + MIN_STANCE_HEIGHT),
    )
    if (arc === null) return null
    return {
      arc,
      from: Q.IDENTITY,
      ground,
      latitude,
      longitude,
      seconds: 8,
      elapsed: 0,
      blend: 0,
    }
  }

  it('stands at the release at progress 0', () => {
    fc.assert(
      fc.property(
        direction,
        direction,
        fc.double({ min: 1.5, max: 30, noNaN: true }),
        fc.option(fc.double({ min: -Math.PI, max: Math.PI, noNaN: true })),
        (from, to, radii, star) => {
          const drop = descent(from, to, radii)
          fc.pre(drop !== null)
          const stance = descentStance(MARS, drop!, 0, star)
          const up = geodeticDirection(stance.latitude, stance.longitude)
          expect(Vec.length(Vec.cross(up, from))).toBeLessThan(1e-9)
          const radius = drawnSurfaceRadius(MARS, up) + stance.height
          expect(near(radius, MARS.radius * radii, 1e-12)).toBe(true)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('stands on the touchdown, level with the horizon and facing the star, at progress 1', () => {
    fc.assert(
      fc.property(
        direction,
        direction,
        fc.double({ min: 1.5, max: 30, noNaN: true }),
        fc.option(fc.double({ min: -Math.PI, max: Math.PI, noNaN: true })),
        fc.double({ min: 1, max: 3, noNaN: true }),
        (from, to, radii, star, beyond) => {
          const drop = descent(from, to, radii)
          fc.pre(drop !== null)
          const stance = descentStance(MARS, drop!, beyond, star)
          expect(stance).toEqual({
            latitude: drop!.latitude,
            longitude: drop!.longitude,
            height: MIN_STANCE_HEIGHT,
            heading: star ?? 0,
            pitch: horizonPitch(MARS.radius, MIN_STANCE_HEIGHT),
          })
        },
      ),
      { numRuns: 40 },
    )
  })

  it('never stands below eye height on the way down', () => {
    fc.assert(
      fc.property(
        direction,
        direction,
        fc.double({ min: 1.5, max: 30, noNaN: true }),
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        (from, to, radii, progress) => {
          const drop = descent(from, to, radii)
          fc.pre(drop !== null)
          const stance = descentStance(MARS, drop!, progress, null)
          expect(stance.height).toBeGreaterThanOrEqual(MIN_STANCE_HEIGHT)
          expect(Number.isFinite(stance.heading)).toBe(true)
          expect(Number.isFinite(stance.pitch)).toBe(true)
        },
      ),
      { numRuns: 40 },
    )
  })
})
