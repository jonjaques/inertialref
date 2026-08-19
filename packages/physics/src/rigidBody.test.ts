import { describe, expect, it } from 'vitest'
import { EARTH_RADIUS, SUN_MU } from '@inertialref/shared'
import { Quaternion as Q, Vec, vec3 } from '@inertialref/spatial'
import { orbitalPeriod } from './kepler.ts'
import {
  type Atmosphere,
  atmosphericDensity,
  type BodyState,
  dampingTorque,
  dragAcceleration,
  integrateBody,
  pointMassAcceleration,
  resolveThrust,
  surfaceGravity,
  type ThrusterProfile,
} from './rigidBody.ts'

const AT_REST: BodyState = {
  position: vec3(0, 0, 0),
  velocity: vec3(0, 0, 0),
  orientation: Q.IDENTITY,
  angularVelocity: vec3(0, 0, 0),
}

const SHIP: ThrusterProfile = { mainThrust: 30, rcsThrust: 8, torque: 1.2 }

describe('rigid body integration', () => {
  it('accelerates at exactly a·t under constant thrust', () => {
    let state = AT_REST
    const dt = 1 / 64
    const accel = vec3(0, 0, -30)
    for (let i = 0; i < 640; i += 1) state = integrateBody(state, accel, Vec.ZERO, dt)
    // Ten seconds at 30 m/s².
    expect(state.velocity.z).toBeCloseTo(-300, 9)
    // Semi-implicit Euler leads the analytic ½at² by exactly one half-step of
    // velocity, which is a known, bounded offset rather than drift.
    expect(state.position.z).toBeCloseTo(-(0.5 * 30 * 100) - 0.5 * 30 * dt * 10, 6)
  })

  it('keeps orientation normalised under sustained rotation', () => {
    let state: BodyState = { ...AT_REST, angularVelocity: vec3(0.7, -0.3, 1.1) }
    for (let i = 0; i < 100_000; i += 1) state = integrateBody(state, Vec.ZERO, Vec.ZERO, 1 / 64)
    const norm = Math.hypot(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
      state.orientation.w,
    )
    expect(norm).toBeCloseTo(1, 12)
  })

  it('completes exactly one turn per rotation period', () => {
    const rate = (2 * Math.PI) / 8 // one revolution in 8 s
    let state: BodyState = { ...AT_REST, angularVelocity: vec3(0, rate, 0) }
    for (let i = 0; i < 8 * 64; i += 1) state = integrateBody(state, Vec.ZERO, Vec.ZERO, 1 / 64)
    expect(Q.approxEquals(state.orientation, Q.IDENTITY, 1e-9)).toBe(true)
  })

  it('holds a circular orbit without spiralling', () => {
    // Semi-implicit Euler is symplectic: the orbit precesses slightly but does
    // not gain or lose energy, which is the property that matters over hours of
    // time warp. Explicit Euler fails this within one orbit.
    const r = 1.5e11
    const speed = Math.sqrt(SUN_MU / r)
    let state: BodyState = {
      position: vec3(r, 0, 0),
      velocity: vec3(0, 0, -speed),
      orientation: Q.IDENTITY,
      angularVelocity: Vec.ZERO,
    }
    const period = orbitalPeriod(SUN_MU, r)
    const dt = period / 20_000
    for (let i = 0; i < 20_000; i += 1) {
      state = integrateBody(state, pointMassAcceleration(SUN_MU, state.position), Vec.ZERO, dt)
    }
    expect(Vec.length(state.position) / r).toBeCloseTo(1, 3)
    expect(Vec.length(state.velocity) / speed).toBeCloseTo(1, 3)
  })

  it('resolves control input into body-axis acceleration', () => {
    const { linear, angular } = resolveThrust(SHIP, {
      translation: vec3(0, 0, 1),
      rotation: vec3(0, 0, 0),
    })
    // Full forward throttle is main-drive thrust along −Z.
    expect(linear.z).toBeCloseTo(-30, 9)
    expect(angular).toEqual(vec3(0, 0, 0))

    const clamped = resolveThrust(SHIP, { translation: vec3(5, 0, 0), rotation: vec3(-9, 0, 0) })
    expect(clamped.linear.x).toBeCloseTo(8, 9)
    expect(clamped.angular.x).toBeCloseTo(-1.2, 9)
  })

  it('damps rotation without overshooting the available torque', () => {
    const dt = 1 / 64
    let state: BodyState = { ...AT_REST, angularVelocity: vec3(0, 0.05, 0) }
    for (let i = 0; i < 64; i += 1) {
      state = integrateBody(state, Vec.ZERO, dampingTorque(state.angularVelocity, SHIP, dt), dt)
      expect(Vec.length(state.angularVelocity)).toBeLessThanOrEqual(0.0501)
    }
    expect(Vec.length(state.angularVelocity)).toBeCloseTo(0, 12)
  })
})

describe('atmosphere', () => {
  const AIR: Atmosphere = { surfaceDensity: 1.225, scaleHeight: 8_500, ceiling: 140_000 }

  it('falls off exponentially and stops at the ceiling', () => {
    expect(atmosphericDensity(AIR, 0)).toBeCloseTo(1.225, 6)
    expect(atmosphericDensity(AIR, 8_500)).toBeCloseTo(1.225 / Math.E, 6)
    expect(atmosphericDensity(AIR, 140_000)).toBe(0)
    // Sea level pressure gives ~9.8 m/s² of surface gravity for Earth's numbers.
    expect(surfaceGravity(3.986e14, EARTH_RADIUS)).toBeCloseTo(9.82, 1)
  })

  it('opposes motion and scales with the square of speed', () => {
    const slow = dragAcceleration(1.225, vec3(0, 0, -100), 500)
    const fast = dragAcceleration(1.225, vec3(0, 0, -200), 500)
    expect(slow.z).toBeGreaterThan(0)
    expect(Vec.length(fast) / Vec.length(slow)).toBeCloseTo(4, 9)
    expect(dragAcceleration(0, vec3(0, 0, -100), 500)).toEqual(Vec.ZERO)
  })
})
