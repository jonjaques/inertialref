import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  AU,
  EARTH_RADIUS,
  SECONDS_PER_DAY,
  SECONDS_PER_YEAR,
  SUN_MU,
} from '@inertialref/shared'
import { Vec } from '@inertialref/spatial'
import {
  apoapsis,
  circularSpeed,
  elementsFromStateVector,
  meanAnomalyAt,
  normalizeAngle,
  type OrbitalElements,
  orbitalPeriod,
  periapsis,
  solveKepler,
  sphereOfInfluence,
  stateVectorAt,
  visViva,
} from './kepler.ts'

const EARTH_LIKE: OrbitalElements = {
  semiMajorAxis: AU,
  eccentricity: 0.0167,
  inclination: 0,
  longitudeOfAscendingNode: 0,
  argumentOfPeriapsis: 1.796,
  meanAnomalyAtEpoch: 6.239,
  epoch: 0,
}

describe('Kepler', () => {
  it("reproduces the Earth year from the Sun's gravitational parameter", () => {
    const period = orbitalPeriod(SUN_MU, AU)
    expect(period / SECONDS_PER_YEAR).toBeCloseTo(1.0, 3)
  })

  it("obeys Kepler's third law", () => {
    // T² ∝ a³: quadrupling the period means a 2^(2/3) larger orbit.
    const inner = orbitalPeriod(SUN_MU, AU)
    const outer = orbitalPeriod(SUN_MU, 4 * AU)
    expect(outer / inner).toBeCloseTo(8, 6)
  })

  /*
   * 0.9999, not 0.95.
   *
   * The bound used to be 0.95 because nothing in the game had an orbit more
   * eccentric than that. Then the comets arrived: C/2020 F3 (NEOWISE) is
   * 0.99913 and Halley is 0.96714, and at 0.9991 the plain Newton iteration
   * returned a residual of 1.5 radians — a body on the wrong side of the Sun,
   * with nothing to say it had failed. `solveKepler` now falls back to a
   * bracketed solve; this is the bound that would have caught it.
   */
  it("solves Kepler's equation for eccentricities up to 0.9999 (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 0.9999, noNaN: true }),
        (M, e) => {
          const E = solveKepler(M, e)
          // The residual of the equation we claim to have solved.
          expect(
            Math.abs(normalizeAngle(E - e * Math.sin(E)) - normalizeAngle(M)),
          ).toBeLessThan(1e-9)
        },
      ),
    )
  })

  it('keeps a circular orbit circular and at the right speed', () => {
    const circular: OrbitalElements = {
      ...EARTH_LIKE,
      eccentricity: 0,
      argumentOfPeriapsis: 0,
    }
    const expectedSpeed = circularSpeed(SUN_MU, AU)
    for (let i = 0; i <= 16; i += 1) {
      const t = (i / 16) * orbitalPeriod(SUN_MU, AU)
      const { position, velocity } = stateVectorAt(circular, SUN_MU, t)
      expect(Vec.length(position) / AU).toBeCloseTo(1, 9)
      expect(Vec.length(velocity)).toBeCloseTo(expectedSpeed, 3)
      // In the reference plane, so no component along system north.
      expect(Math.abs(position.y)).toBeLessThan(1)
    }
  })

  it('orbits prograde about +Y', () => {
    const circular: OrbitalElements = {
      ...EARTH_LIKE,
      eccentricity: 0,
      argumentOfPeriapsis: 0,
    }
    const { position, velocity } = stateVectorAt(circular, SUN_MU, 0)
    const h = Vec.cross(position, velocity)
    expect(h.y).toBeGreaterThan(0)
    expect(Math.abs(h.x)).toBeLessThan(Math.abs(h.y) * 1e-9)
  })

  it('conserves energy and angular momentum over a full orbit', () => {
    const period = orbitalPeriod(SUN_MU, EARTH_LIKE.semiMajorAxis)
    let minEnergy = Infinity
    let maxEnergy = -Infinity
    let minH = Infinity
    let maxH = -Infinity
    for (let i = 0; i < 64; i += 1) {
      const { position, velocity } = stateVectorAt(
        EARTH_LIKE,
        SUN_MU,
        (i / 64) * period,
      )
      const r = Vec.length(position)
      const v = Vec.length(velocity)
      const energy = (v * v) / 2 - SUN_MU / r
      const h = Vec.length(Vec.cross(position, velocity))
      minEnergy = Math.min(minEnergy, energy)
      maxEnergy = Math.max(maxEnergy, energy)
      minH = Math.min(minH, h)
      maxH = Math.max(maxH, h)
      // Vis-viva must agree with the state vector everywhere on the ellipse.
      expect(v).toBeCloseTo(visViva(SUN_MU, r, EARTH_LIKE.semiMajorAxis), 3)
    }
    expect(Math.abs((maxEnergy - minEnergy) / minEnergy)).toBeLessThan(1e-12)
    expect(Math.abs((maxH - minH) / minH)).toBeLessThan(1e-12)
  })

  it('returns to the same state after exactly one period', () => {
    const period = orbitalPeriod(SUN_MU, EARTH_LIKE.semiMajorAxis)
    const a = stateVectorAt(EARTH_LIKE, SUN_MU, 12_345)
    const b = stateVectorAt(EARTH_LIKE, SUN_MU, 12_345 + period)
    // Relative to a 1.5e11 m orbit, this is parts in 1e15.
    expect(Vec.distance(a.position, b.position)).toBeLessThan(1e-3)
    expect(Vec.distance(a.velocity, b.velocity)).toBeLessThan(1e-6)
  })

  it('stays inside periapsis and apoapsis', () => {
    const eccentric: OrbitalElements = { ...EARTH_LIKE, eccentricity: 0.7 }
    const period = orbitalPeriod(SUN_MU, eccentric.semiMajorAxis)
    for (let i = 0; i < 128; i += 1) {
      const r = Vec.length(
        stateVectorAt(eccentric, SUN_MU, (i / 128) * period).position,
      )
      expect(r).toBeGreaterThanOrEqual(periapsis(eccentric) - 1)
      expect(r).toBeLessThanOrEqual(apoapsis(eccentric) + 1)
    }
  })

  it('round-trips elements through a state vector (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.2, max: 30, noNaN: true }),
        fc.double({ min: 0.001, max: 0.8, noNaN: true }),
        fc.double({ min: 0.01, max: Math.PI - 0.01, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        (aAu, e, inc, raan, argP, m0) => {
          const elements: OrbitalElements = {
            semiMajorAxis: aAu * AU,
            eccentricity: e,
            inclination: inc,
            longitudeOfAscendingNode: raan,
            argumentOfPeriapsis: argP,
            meanAnomalyAtEpoch: m0,
            epoch: 0,
          }
          const t = 4_000_000
          const state = stateVectorAt(elements, SUN_MU, t)
          const recovered = elementsFromStateVector(state, SUN_MU, t)
          const again = stateVectorAt(recovered, SUN_MU, t)

          // The elements themselves may differ by a 2π wrap or a degenerate
          // Ω/ω split; what must match is the physical state they describe.
          expect(
            Vec.distance(state.position, again.position) /
              Vec.length(state.position),
          ).toBeLessThan(1e-9)
          expect(
            Vec.distance(state.velocity, again.velocity) /
              Vec.length(state.velocity),
          ).toBeLessThan(1e-9)
          expect(recovered.semiMajorAxis / elements.semiMajorAxis).toBeCloseTo(
            1,
            9,
          )
          expect(recovered.eccentricity).toBeCloseTo(elements.eccentricity, 9)
          expect(recovered.inclination).toBeCloseTo(elements.inclination, 9)
        },
      ),
      { numRuns: 150 },
    )
  })

  it('advances the mean anomaly linearly in time', () => {
    const n = (2 * Math.PI) / orbitalPeriod(SUN_MU, AU)
    const m0 = meanAnomalyAt(EARTH_LIKE, SUN_MU, 0)
    const m1 = meanAnomalyAt(EARTH_LIKE, SUN_MU, SECONDS_PER_DAY)
    expect(normalizeAngle(m1 - m0)).toBeCloseTo(n * SECONDS_PER_DAY, 9)
  })

  it('sizes a sphere of influence the way the textbooks do', () => {
    // Earth's SOI is ~0.929e9 m.
    const soi = sphereOfInfluence(AU, 5.972e24, 1.989e30)
    expect(soi / 1e9).toBeCloseTo(0.929, 2)
    expect(soi).toBeGreaterThan(EARTH_RADIUS * 100)
  })
})
