import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, EARTH_MASS, EARTH_RADIUS, SUN_MU } from '@inertialref/shared'
import { Vec, vec3 } from '@inertialref/spatial'
import {
  escapeSpeed,
  type OrbitalElements,
  orbitalPeriod,
  type StateVector,
  stateVectorAt,
} from './kepler.ts'
import { standardGravitationalParameter } from './rigidBody.ts'
import { conicOf, propagateTwoBody } from './universal.ts'

const EARTH_MU = standardGravitationalParameter(EARTH_MASS)

const arbitraryElements = fc
  .record({
    a: fc.double({ min: 0.2, max: 30, noNaN: true }),
    e: fc.double({ min: 0, max: 0.99, noNaN: true }),
    i: fc.double({ min: 0, max: Math.PI, noNaN: true }),
    raan: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
    argp: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
    m0: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
  })
  .map(({ a, e, i, raan, argp, m0 }): OrbitalElements => ({
    semiMajorAxis: a * AU,
    eccentricity: e,
    inclination: i,
    longitudeOfAscendingNode: raan,
    argumentOfPeriapsis: argp,
    meanAnomalyAtEpoch: m0,
    epoch: 0,
  }))

/** A state at a random radius, moving at a multiple of escape speed. */
const arbitraryState = (
  speedFactor: fc.Arbitrary<number>,
): fc.Arbitrary<{ state: StateVector; mu: number }> =>
  fc
    .record({
      radius: fc.double({ min: 1.1, max: 200, noNaN: true }),
      direction: fc.tuple(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
      ),
      heading: fc.tuple(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
      ),
      factor: speedFactor,
    })
    .filter(
      ({ direction, heading }) =>
        Vec.length(vec3(...direction)) > 0.1 &&
        Vec.length(Vec.cross(vec3(...direction), vec3(...heading))) > 0.05,
    )
    .map(({ radius, direction, heading, factor }) => {
      const r = radius * EARTH_RADIUS
      const position = Vec.withLength(vec3(...direction), r)
      const velocity = Vec.withLength(
        vec3(...heading),
        escapeSpeed(EARTH_MU, r) * factor,
      )
      return { state: { position, velocity }, mu: EARTH_MU }
    })

const specificEnergy = (s: StateVector, mu: number): number =>
  Vec.lengthSquared(s.velocity) / 2 - mu / Vec.length(s.position)

const relative = (a: number, b: number): number =>
  Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300)

describe('universal-variable propagation', () => {
  it('agrees with the element form on every ellipse (property)', () => {
    fc.assert(
      fc.property(
        arbitraryElements,
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        fc.double({ min: -3, max: 50, noNaN: true }),
        (elements, t0, periods) => {
          const period = orbitalPeriod(SUN_MU, elements.semiMajorAxis)
          const dt = periods * period
          const from = stateVectorAt(elements, SUN_MU, t0)
          const expected = stateVectorAt(elements, SUN_MU, t0 + dt)
          const got = propagateTwoBody(from, SUN_MU, dt)
          /*
           * The bound grows with the revolutions, and the growth is measured
           * rather than chosen. The state vector the elements produce is
           * rounded onto an ellipse whose period differs from the nominal one
           * by parts in 10¹³, and this propagator follows the state it was
           * given — so the two drift apart along track by about 0.3 m per
           * revolution at e = 0.98, linearly, with the energy agreeing to
           * every printed digit. That is the element solution's rounding, not
           * this one's; the properties below are what check this one.
           */
          const bound = 5e-9 * (1 + Math.abs(periods))
          expect(
            Vec.distance(got.position, expected.position) /
              elements.semiMajorAxis,
          ).toBeLessThan(bound)
          const speed = Math.max(
            Vec.length(expected.velocity),
            Vec.length(got.velocity),
          )
          expect(
            Vec.distance(got.velocity, expected.velocity) / speed,
          ).toBeLessThan(bound)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('holds a low orbit to the millimeter across a year of revolutions', () => {
    /*
     * A ship at 400 km goes round every 92 minutes; a year of warp is 5,700
     * revolutions. The elapsed time is reduced modulo the period before the
     * anomaly is solved, so the precision here is that of one revolution
     * rather than of five thousand.
     */
    const r = EARTH_RADIUS + 400_000
    const speed = Math.sqrt(EARTH_MU / r)
    const from: StateVector = {
      position: vec3(r, 0, 0),
      velocity: vec3(0, 0, -speed),
    }
    const year = 31_557_600
    const period = 2 * Math.PI * Math.sqrt((r * r * r) / EARTH_MU)
    const whole = Math.floor(year / period) * period
    const direct = propagateTwoBody(from, EARTH_MU, year - whole)
    const long = propagateTwoBody(from, EARTH_MU, year)
    expect(Vec.distance(direct.position, long.position)).toBeLessThan(1e-3)
    expect(Vec.length(long.position)).toBeCloseTo(r, 3)
  })

  it('conserves energy and angular momentum on hyperbolas and parabolas (property)', () => {
    fc.assert(
      fc.property(
        arbitraryState(
          fc.oneof(
            fc.constant(1),
            fc.double({ min: 1.001, max: 4, noNaN: true }),
          ),
        ),
        fc.double({ min: -1e6, max: 1e7, noNaN: true }),
        ({ state, mu }, dt) => {
          const after = propagateTwoBody(state, mu, dt)
          // Against the kinetic energy, not the total: a parabola's total is
          // zero by definition, and a relative error against zero is meaningless.
          expect(
            Math.abs(specificEnergy(after, mu) - specificEnergy(state, mu)) /
              (Vec.lengthSquared(state.velocity) / 2),
          ).toBeLessThan(1e-9)
          /*
           * 10⁻⁹ is twenty times the worst this domain produces, and the
           * distance between those two numbers is the whole reason to say so.
           *
           * Angular momentum is the sensitive one: it is a cross product of a
           * position that grows by four orders of magnitude along a hyperbola
           * and a velocity that does not, so it loses digits where the energy
           * — a difference of two quantities that stay the same size — keeps
           * all of them at 10⁻¹⁶. Swept over 20,000 states across this
           * arbitrary's own range, the worst relative error is **4.9 × 10⁻¹¹**.
           *
           * It was 4.6 × 10⁻⁹ and this bound caught it, which is the only
           * reason the bound is worth having: the universal anomaly's Newton
           * iteration was exiting on the size of its *step* rather than on its
           * residual, and a far propagation divides a large residual by a
           * large radius into a small step. See `solveUniversal`.
           */
          const h0 = Vec.cross(state.position, state.velocity)
          const h1 = Vec.cross(after.position, after.velocity)
          expect(Vec.distance(h0, h1) / Vec.length(h0)).toBeLessThan(1e-9)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('composes: two legs land where one leg does (property)', () => {
    fc.assert(
      fc.property(
        arbitraryState(fc.double({ min: 0.3, max: 3, noNaN: true })),
        fc.double({ min: 0, max: 3e5, noNaN: true }),
        fc.double({ min: 0, max: 3e5, noNaN: true }),
        ({ state, mu }, a, b) => {
          const conic = conicOf(state, mu)
          // A conic that dives through the center is not a flight anyone takes.
          fc.pre(conic.periapsis > EARTH_RADIUS * 0.5)
          const twoLegs = propagateTwoBody(
            propagateTwoBody(state, mu, a),
            mu,
            b,
          )
          const oneLeg = propagateTwoBody(state, mu, a + b)
          const scale = Math.max(
            Vec.length(oneLeg.position),
            Vec.length(state.position),
          )
          expect(
            Vec.distance(twoLegs.position, oneLeg.position) / scale,
          ).toBeLessThan(1e-8)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('runs backward to where it started (property)', () => {
    fc.assert(
      fc.property(
        arbitraryState(fc.double({ min: 0.3, max: 3, noNaN: true })),
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        ({ state, mu }, dt) => {
          fc.pre(conicOf(state, mu).periapsis > EARTH_RADIUS * 0.5)
          const back = propagateTwoBody(
            propagateTwoBody(state, mu, dt),
            mu,
            -dt,
          )
          expect(
            Vec.distance(back.position, state.position) /
              Vec.length(state.position),
          ).toBeLessThan(1e-8)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('is a straight line with no attractor', () => {
    const from: StateVector = {
      position: vec3(1, 2, 3),
      velocity: vec3(10, -20, 5),
    }
    expect(propagateTwoBody(from, 0, 4)).toEqual({
      position: vec3(41, -78, 23),
      velocity: from.velocity,
    })
  })

  it('is the identity at zero elapsed time', () => {
    const from: StateVector = {
      position: vec3(EARTH_RADIUS * 2, 0, 0),
      velocity: vec3(0, 0, 5_000),
    }
    expect(propagateTwoBody(from, EARTH_MU, 0)).toBe(from)
  })
})

describe('the conic a state lies on', () => {
  it('reads periapsis and eccentricity off an ellipse (property)', () => {
    fc.assert(
      fc.property(
        arbitraryElements,
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        (elements, t) => {
          const conic = conicOf(stateVectorAt(elements, SUN_MU, t), SUN_MU)
          const periapsis = elements.semiMajorAxis * (1 - elements.eccentricity)
          expect(relative(conic.periapsis, periapsis)).toBeLessThan(1e-6)
          expect(
            Math.abs(conic.eccentricity - elements.eccentricity),
          ).toBeLessThan(1e-6)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('bounds the speed everywhere on the conic by the periapsis speed (property)', () => {
    fc.assert(
      fc.property(
        arbitraryState(fc.double({ min: 0.3, max: 3, noNaN: true })),
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), {
          minLength: 1,
          maxLength: 8,
        }),
        ({ state, mu }, times) => {
          const conic = conicOf(state, mu)
          fc.pre(conic.periapsis > EARTH_RADIUS * 0.5)
          for (const t of times) {
            const speed = Vec.length(propagateTwoBody(state, mu, t).velocity)
            expect(speed).toBeLessThanOrEqual(conic.periapsisSpeed * (1 + 1e-9))
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('calls an escape an escape', () => {
    const r = EARTH_RADIUS * 3
    const state: StateVector = {
      position: vec3(r, 0, 0),
      velocity: vec3(0, 0, escapeSpeed(EARTH_MU, r) * 1.2),
    }
    expect(conicOf(state, EARTH_MU).eccentricity).toBeGreaterThan(1)
    const fall: StateVector = { position: vec3(r, 0, 0), velocity: Vec.ZERO }
    expect(conicOf(fall, EARTH_MU).periapsis).toBe(0)
    expect(conicOf(fall, EARTH_MU).periapsisSpeed).toBe(Infinity)
  })
})
