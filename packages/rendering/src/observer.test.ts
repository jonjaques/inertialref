import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, LIGHT_YEAR } from '@inertialref/shared'
import {
  POSITION_RESOLUTION,
  Quaternion as Q,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  anglesForPhase,
  applyDrag,
  applyZoom,
  approachState,
  clampDistance,
  ELEVATION_LIMIT,
  framingDistance,
  MAX_OBSERVER_DISTANCE,
  type ObserverState,
  observerOffset,
  observerPose,
  compassDegrees,
  shortestAngle,
  zoomFactorForNotches,
} from './observer.ts'

/*
 * The planetarium camera, as arithmetic.
 *
 * Property tests rather than examples almost throughout, because every claim
 * this module makes is a claim about a *range*: the elevation clamp has to hold
 * for any drag, the distance clamp for any zoom, and the pose has to be
 * finite from a moon's surface to a hundred light years — nineteen decades, in
 * which a formula can be right in the middle and wrong at both ends.
 */

const EARTH_RADIUS = 6.371e6

const anyState = fc.record({
  azimuth: fc.double({ min: -20, max: 20, noNaN: true }),
  elevation: fc.double({
    min: -ELEVATION_LIMIT,
    max: ELEVATION_LIMIT,
    noNaN: true,
  }),
  // Three metres to a hundred light years: the band the clamp actually
  // permits. Generating past `MAX_OBSERVER_DISTANCE` would only be testing
  // that `UV.translate` refuses to leave the universe, which is its own test.
  distance: fc
    .double({ min: 3, max: 18, noNaN: true })
    .map((exponent) => Math.pow(10, exponent)),
})

describe('the elevation clamp', () => {
  it('holds for any drag, however violent', () => {
    fc.assert(
      fc.property(
        anyState,
        fc.double({ min: -1e5, max: 1e5, noNaN: true }),
        fc.double({ min: -1e5, max: 1e5, noNaN: true }),
        (state, dx, dy) => {
          const next = applyDrag(state, dx, dy)
          expect(Math.abs(next.elevation)).toBeLessThanOrEqual(ELEVATION_LIMIT)
        },
      ),
    )
  })

  it('keeps the view direction off the pole', () => {
    // The reason the clamp exists: at the pole the up hint is parallel to the
    // view and the frame rolls a half turn in one pixel. Two degrees of margin
    // is what stops that, so assert the margin rather than the number.
    const offset = observerOffset({
      azimuth: 0,
      elevation: ELEVATION_LIMIT,
      distance: 1e9,
    })
    const cosine = Math.abs(Vec.dot(Vec.normalize(offset), vec3(0, 1, 0)))
    expect(cosine).toBeLessThan(0.9995)
  })
})

describe('zoom', () => {
  it('never goes inside the body or past the ceiling', () => {
    fc.assert(
      fc.property(
        anyState,
        fc.integer({ min: -400, max: 400 }),
        (state, notches) => {
          const next = applyZoom(
            state,
            zoomFactorForNotches(notches),
            EARTH_RADIUS,
          )
          expect(next.distance).toBeGreaterThanOrEqual(EARTH_RADIUS)
          expect(next.distance).toBeLessThanOrEqual(MAX_OBSERVER_DISTANCE)
          expect(Number.isFinite(next.distance)).toBe(true)
        },
      ),
    )
  })

  it('is symmetric: in then out returns to where it started', () => {
    // A multiplicative zoom has this for free and a linear one does not, which
    // is the whole reason the wheel is a ratio.
    const start: ObserverState = {
      azimuth: 0.4,
      elevation: 0.2,
      distance: 40 * AU,
    }
    const there = applyZoom(start, zoomFactorForNotches(7), EARTH_RADIUS)
    const back = applyZoom(there, zoomFactorForNotches(-7), EARTH_RADIUS)
    expect(back.distance / start.distance).toBeCloseTo(1, 9)
  })

  it('clamps a target with no radius to a finite band', () => {
    // A barycentre, a Lagrange point or a ship: zero radius is a real target
    // and a naive `radius * k` band would collapse to a point at the origin.
    const near = clampDistance(1e-9, 0)
    const far = clampDistance(1e30, 0)
    expect(near).toBeGreaterThan(0)
    expect(far).toBe(MAX_OBSERVER_DISTANCE)
  })

  it('lets a moon retreat as far as a star can', () => {
    // The reason the ceiling is absolute rather than a multiple of the radius:
    // "zoom out until the neighbouring stars appear" has to mean the same
    // thing at Luna as at the Sun, or the gesture teaches nothing.
    const LUNA = 1.737e6
    const SUN = 6.957e8
    expect(clampDistance(1e30, LUNA)).toBe(clampDistance(1e30, SUN))
  })
})

describe('the pose', () => {
  it('sits exactly `distance` from the target, at every scale', () => {
    fc.assert(
      fc.property(anyState, (state) => {
        const target = UV.fromMeters(3 * LIGHT_YEAR, -2 * AU, 7 * LIGHT_YEAR)
        const pose = observerPose(target, state)
        const measured = UV.distance(pose.position, target)
        /*
         * Two named limits rather than one tolerance that happens to pass.
         *
         * `POSITION_RESOLUTION` is the universe's own floor — a sector offset
         * is a double inside 2^40 m — and it is what dominates at a kilometre,
         * where it is 2.4e-7 of the answer. Past a few light years it is the
         * 53-bit mantissa of the sum of squares instead, which is relative.
         * Eight resolutions covers rounding on three axes at both ends.
         */
        expect(Math.abs(measured - state.distance)).toBeLessThanOrEqual(
          Math.max(POSITION_RESOLUTION * 8, state.distance * 1e-12),
        )
      }),
    )
  })

  it('looks at the target, not past it', () => {
    fc.assert(
      fc.property(anyState, (state) => {
        const target = UV.fromMeters(0, 0, 0)
        const pose = observerPose(target, state)
        const forward = Q.rotate(pose.orientation, vec3(0, 0, -1))
        const toTarget = Vec.normalize(UV.difference(target, pose.position))
        // The dot product is the whole assertion: 1 means the nose is on it.
        expect(Vec.dot(forward, toTarget)).toBeGreaterThan(1 - 1e-9)
      }),
    )
  })

  it('keeps the horizon level — the pole projects to screen up', () => {
    // Away from the poles, the body's rotation axis must appear vertical, or
    // every planetarium screenshot is subtly Dutch-angled.
    const pose = observerPose(UV.UNIVERSE_ORIGIN, {
      azimuth: 1.1,
      elevation: 0.3,
      distance: 5 * EARTH_RADIUS,
    })
    const right = Q.rotate(pose.orientation, vec3(1, 0, 0))
    expect(Math.abs(Vec.dot(right, vec3(0, 1, 0)))).toBeLessThan(1e-9)
  })
})

describe('easing', () => {
  it('converges without overshooting, at any frame rate', () => {
    const from: ObserverState = {
      azimuth: 0,
      elevation: 0,
      distance: 400 * EARTH_RADIUS,
    }
    const to: ObserverState = {
      azimuth: 2.5,
      elevation: 0.7,
      distance: 4 * LIGHT_YEAR,
    }
    expect(to.distance).toBeLessThan(MAX_OBSERVER_DISTANCE)
    for (const fps of [30, 60, 144]) {
      let state = from
      for (let i = 0; i < fps * 4; i += 1) {
        state = approachState(state, to, 1 / fps, 0.35)
        // Log-space easing means the distance is always between the two ends;
        // a naive lerp on a 14-decade gap is not, once damping is added.
        expect(state.distance).toBeGreaterThanOrEqual(from.distance * 0.999)
        expect(state.distance).toBeLessThanOrEqual(to.distance * 1.001)
      }
      expect(Math.abs(state.distance / to.distance - 1)).toBeLessThan(1e-3)
      expect(state.azimuth).toBeCloseTo(to.azimuth, 3)
    }
  })

  it('is frame-rate independent to within a percent over a second', () => {
    // The reason `1 - exp(-dt/tau)` is used instead of a fixed lerp factor:
    // the same wall-clock second must produce the same result whatever the
    // display did. A fixed 0.1 lerp is 2.4× further along at 144 Hz.
    const from: ObserverState = { azimuth: 0, elevation: 0, distance: 1e9 }
    const to: ObserverState = { azimuth: 0, elevation: 0, distance: 1e15 }
    const run = (fps: number): number => {
      let state = from
      for (let i = 0; i < fps; i += 1)
        state = approachState(state, to, 1 / fps, 0.5)
      return Math.log(state.distance)
    }
    expect(Math.abs(run(30) - run(144)) / Math.log(to.distance)).toBeLessThan(
      0.01,
    )
  })

  it('takes the short way round, however many turns the drag accumulated', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.double({ min: -100, max: 100, noNaN: true }),
        (from, to) => {
          const delta = shortestAngle(from, to)
          expect(Math.abs(delta)).toBeLessThanOrEqual(Math.PI + 1e-12)
          // It still names the same direction: adding it lands on `to` modulo a
          // whole number of turns.
          const residue = (from + delta - to) / (Math.PI * 2)
          expect(Math.abs(residue - Math.round(residue))).toBeLessThan(1e-9)
        },
      ),
    )
  })

  it('reads as a compass bearing however far the drag accumulated', () => {
    /*
     * The readout half of the same fact. `%` in JavaScript is a remainder and
     * keeps the sign, so the panel's `Math.round(deg) % 360` showed `-23° az`
     * after a rightward drag from the opening state and `-327°` for a heading
     * of 33° — a bearing that swings between −359 and 359.
     */
    expect(compassDegrees(0)).toBe(0)
    expect(compassDegrees(-Math.PI / 2)).toBe(270)
    expect(compassDegrees(-6 * Math.PI - Math.PI)).toBe(180)
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 100, noNaN: true }),
        (azimuth) => {
          const bearing = compassDegrees(azimuth)
          expect(bearing).toBeGreaterThanOrEqual(0)
          expect(bearing).toBeLessThan(360)
          expect(Number.isInteger(bearing)).toBe(true)
          // It still names the direction it was given, to within the rounding.
          const residue = (azimuth * 180) / Math.PI - bearing
          expect(
            Math.abs(residue / 360 - Math.round(residue / 360)),
          ).toBeLessThan(0.5 / 360 + 1e-9)
        },
      ),
    )
  })
})

describe('framing', () => {
  it('puts a body edge to edge at fill 1', () => {
    const distance = framingDistance(EARTH_RADIUS, 65, 1)
    // sin(half fov) = r / d is the true limb of a sphere. Assert the geometry
    // rather than a number, so a changed default lens does not falsify it.
    expect(Math.asin(EARTH_RADIUS / distance)).toBeCloseTo(
      (65 * Math.PI) / 360,
      12,
    )
  })

  it('retreats as the lens narrows', () => {
    expect(framingDistance(EARTH_RADIUS, 20)).toBeGreaterThan(
      framingDistance(EARTH_RADIUS, 90),
    )
  })
})

describe('phase angles', () => {
  it('produce the phase they were asked for, wherever the star is', () => {
    // The bug this guards is the one `placeShot` documents: rotating about the
    // pole rather than about the sun line gets the phase wrong by an amount
    // that depends on how far the star sits out of the reference plane, so it
    // is right in the one test case anybody writes by hand.
    fc.assert(
      fc.property(
        fc.record({
          x: fc.double({ min: -1, max: 1, noNaN: true }),
          y: fc.double({ min: -1, max: 1, noNaN: true }),
          z: fc.double({ min: -1, max: 1, noNaN: true }),
        }),
        fc.double({ min: 5, max: 175, noNaN: true }),
        (raw, phaseDeg) => {
          fc.pre(Vec.length(raw) > 0.2)
          const toStar = Vec.normalize(raw)
          const { azimuth, elevation } = anglesForPhase(toStar, phaseDeg)
          const direction = Vec.normalize(
            observerOffset({ azimuth, elevation, distance: 1 }),
          )
          const measured =
            (Math.acos(Math.max(-1, Math.min(1, Vec.dot(direction, toStar)))) *
              180) /
            Math.PI
          // The elevation clamp can steal degrees from a phase that would have
          // put the camera over a pole; everywhere else it is exact.
          const clamped = Math.abs(elevation) >= ELEVATION_LIMIT - 1e-9
          if (!clamped) expect(Math.abs(measured - phaseDeg)).toBeLessThan(1e-6)
        },
      ),
    )
  })
})
