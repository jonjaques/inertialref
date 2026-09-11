import { describe, expect, it } from 'vitest'
import { tick } from '@inertialref/shared'
import {
  canonicalPosition,
  reframe,
  restState,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  bodyFixedDirection,
  bodyFixedFrameId,
  bodyFrameId,
  dynamicEntityId,
  installSurfaceFrame,
  surfaceRadius,
  systemId,
} from '@inertialref/universe'
import { World } from './world.ts'

const make = (time = 0, east = 0) => {
  const world = new World({ seed: 'inertialref', startTick: tick(time * 64) })
  const body = world.loadSystem(systemId('SOL')).planets[3]!
  const placement = world.placeStructure({
    id: 'pad',
    assetId: 'mars-pad',
    bodyAddress: 'g:milky-way/s:SOL/b:3',
    latitude: 0.6031917532451286,
    longitude: 1.4844702100937137,
    height: 30,
    heading: 0,
  })
  const frame = installSurfaceFrame(
    world.frames,
    body,
    placement.latitude,
    placement.longitude,
  )
  const state = reframe(
    world.frames,
    {
      ...restState(frame),
      position: vec3(east, 35, 0),
      velocity: vec3(0, -20, 0),
    },
    bodyFrameId(body.address),
    world.clock.time,
  )
  const ship = world.spawn({
    id: dynamicEntityId(99),
    kind: 'probe',
    name: 'contact probe',
    state,
  })
  const height = () => {
    const entity = world.entities.require(ship.id),
      spin = world.frames.pose(bodyFixedFrameId(body.address), world.clock.time)
    const position = canonicalPosition(
      world.frames,
      entity.state,
      world.clock.time,
    )
    return (
      UV.distance(position, spin.position) -
      surfaceRadius(body, bodyFixedDirection(spin, position))
    )
  }
  return { world, body, placement, ship, height }
}

describe('a structure supports ordinary flight', () => {
  it('contacts the raised disk on a rotating body and settles through the ordinary landing verb', () => {
    for (const time of [0, 12000]) {
      const { world, ship, height } = make(time)
      world.runTicks(64)
      expect(world.isLanded(ship.id)).toBe(true)
      expect(height()).toBeCloseTo(30, 1)
      expect(Vec.length(world.entities.require(ship.id).state.velocity)).toBe(0)
    }
  })
  it('lands on terrain outside the support disk', () => {
    const { world, ship, height } = make(0, 80)
    world.runTicks(160)
    expect(world.isLanded(ship.id)).toBe(true)
    expect(height()).toBeLessThan(1)
  })
  it('releases an occupant when its support is removed or moved away', () => {
    for (const operation of ['remove', 'move']) {
      const { world, ship, placement, height } = make()
      world.runTicks(64)
      expect(world.isLanded(ship.id)).toBe(true)
      if (operation === 'remove') world.removeStructure(placement.id)
      else
        world.moveStructure({
          ...placement,
          longitude: placement.longitude + 0.01,
        })
      expect(world.isLanded(ship.id)).toBe(false)
      world.runTicks(400)
      expect(world.isLanded(ship.id)).toBe(true)
      expect(height()).toBeLessThan(1)
    }
  })
})
