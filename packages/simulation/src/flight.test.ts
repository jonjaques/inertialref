import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, vec3 } from '@inertialref/spatial'
import { systemId, systemFrameId } from '@inertialref/universe'
import { TICK_DURATION } from './clock.ts'
import { DEBUG_SHIP_THRUSTERS } from './entity.ts'
import { commandedAcceleration, thrustDemand } from './flight.ts'
import { snapshot } from './snapshot.ts'
import { World } from './world.ts'

const SOL = systemId('SOL')

/** A ship in deep space, in Sol's frame, with nothing pulling on it. */
function shipInSpace() {
  const world = new World({ seed: 'inertialref' })
  world.loadSystem(SOL)
  const ship = world.spawnShip('probe', systemFrameId(SOL), vec3(1e12, 0, 0))
  return { world, id: ship.id }
}

const unit = fc.double({ min: -1, max: 1, noNaN: true })
const axes = fc.tuple(unit, unit, unit)

describe('the thrust demand', () => {
  it('is nothing for a ship at rest with its hands off', () => {
    const { world, id } = shipInSpace()
    const demand = thrustDemand(world.entities.require(id), TICK_DURATION)
    expect(demand).not.toBeNull()
    expect(demand?.linear).toEqual(Vec.ZERO)
    expect(demand?.angular).toEqual(Vec.ZERO)
  })

  it('is the control itself, in body axes, with forward as −Z (property)', () => {
    fc.assert(
      fc.property(axes, axes, (translation, rotation) => {
        const { world, id } = shipInSpace()
        world.setControl(id, vec3(...translation), vec3(...rotation))
        const demand = thrustDemand(world.entities.require(id), TICK_DURATION)
        expect(demand).not.toBeNull()
        if (demand === null) return
        // The control's z is "thrust ahead"; the demand's z is along the body
        // axis, and ahead is −Z. The other five are the control as given.
        expect(demand.linear.x).toBeCloseTo(translation[0], 12)
        expect(demand.linear.y).toBeCloseTo(translation[1], 12)
        expect(demand.linear.z).toBeCloseTo(-translation[2], 12)
        // With a rotation asked for, the assist stays out of it.
        expect(demand.angular.x).toBeCloseTo(rotation[0], 12)
        expect(demand.angular.y).toBeCloseTo(rotation[1], 12)
        expect(demand.angular.z).toBeCloseTo(rotation[2], 12)
      }),
      { numRuns: 60 },
    )
  })

  it('is the assist nulling a spin, opposed to it and bounded by authority', () => {
    const { world, id } = shipInSpace()
    // Spin up under a held roll, then let go: the assist is the whole demand.
    world.setControl(id, Vec.ZERO, vec3(0, 0, 1))
    for (let i = 0; i < 64; i += 1) world.advance(TICK_DURATION)
    world.setControl(id, Vec.ZERO, Vec.ZERO)
    const entity = world.entities.require(id)
    const spin = entity.state.angularVelocity
    expect(Vec.length(spin)).toBeGreaterThan(0)

    const demand = thrustDemand(entity, TICK_DURATION)
    expect(demand).not.toBeNull()
    if (demand === null) return
    expect(demand.linear).toEqual(Vec.ZERO)
    expect(Vec.dot(demand.angular, spin)).toBeLessThan(0)
    // A second of roll at full torque is far more than one tick can null, so
    // the assist is saturated at exactly the profile's authority.
    expect(Vec.length(demand.angular)).toBeCloseTo(1, 9)
  })

  it('leaves the spin alone with the assist off', () => {
    const { world, id } = shipInSpace()
    world.setControl(id, Vec.ZERO, vec3(1, 0, 0))
    for (let i = 0; i < 16; i += 1) world.advance(TICK_DURATION)
    world.setControl(id, Vec.ZERO, Vec.ZERO)
    world.setFlightAssist(id, false)
    const demand = thrustDemand(world.entities.require(id), TICK_DURATION)
    expect(demand?.angular).toEqual(Vec.ZERO)
  })

  it('is the commanded acceleration over the profile, exactly (property)', () => {
    fc.assert(
      fc.property(axes, axes, (translation, rotation) => {
        const { world, id } = shipInSpace()
        world.setControl(id, vec3(...translation), vec3(...rotation))
        const entity = world.entities.require(id)
        const commanded = commandedAcceleration(entity, TICK_DURATION)
        const demand = thrustDemand(entity, TICK_DURATION)
        if (demand === null) throw new Error('a ship has thrusters')
        const { rcsThrust, mainThrust, torque } = DEBUG_SHIP_THRUSTERS
        expect(demand.linear.x * rcsThrust).toBeCloseTo(commanded.linear.x, 9)
        expect(demand.linear.y * rcsThrust).toBeCloseTo(commanded.linear.y, 9)
        expect(demand.linear.z * mainThrust).toBeCloseTo(commanded.linear.z, 9)
        expect(demand.angular.x * torque).toBeCloseTo(commanded.angular.x, 9)
        expect(demand.angular.y * torque).toBeCloseTo(commanded.angular.y, 9)
        expect(demand.angular.z * torque).toBeCloseTo(commanded.angular.z, 9)
      }),
      { numRuns: 40 },
    )
  })

  it('rides the snapshot, so the picture reads the tick it was drawn from', () => {
    const { world, id } = shipInSpace()
    world.setControl(id, vec3(0, 0, 1), Vec.ZERO)
    const shot = snapshot(world)
    const ship = shot.entities.find((entity) => entity.id === id)
    expect(ship?.thrust?.linear.z).toBe(-1)
  })
})
