import { describe, expect, it } from 'vitest'
import { type Meters, tick } from '@inertialref/shared'
import { circularSpeed } from '@inertialref/physics'
import {
  canonicalPosition,
  reframe,
  restState,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  type Body,
  type BodyFixedDirection,
  bodyFixedDirection,
  bodyFixedFrameId,
  bodyFrameId,
  dynamicEntityId,
  installSurfaceFrame,
  formatAddress,
  hasSolidSurface,
  surfaceRadius,
  systemId,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import { World } from './world.ts'

/** A world that counts how often the integrator asks it about decks. */
class CountingWorld extends World {
  contactAsks = 0
  override contactRadius(
    body: Body,
    direction: BodyFixedDirection,
    terrain?: Meters,
  ): Meters {
    this.contactAsks += 1
    return super.contactRadius(body, direction, terrain)
  }
}

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
  it('is never asked about a deck from orbit, and asked once a tick over one', () => {
    // Two operating points: the seeded pad on Mars, and a pad on a generated
    // world at Alpha Centauri, so the gate is not a fact about one body.
    const points = [
      {
        system: 'SOL',
        body: 3,
        latitude: 0.6031917532451286,
        longitude: 1.4844702100937137,
      },
      { system: 'HIP71683', body: -1, latitude: 0.3, longitude: 0.5 },
    ]
    for (const point of points) {
      const world = new CountingWorld({
        seed: 'inertialref',
        catalog: TEST_CATALOG,
      })
      const system = world.loadSystem(systemId(point.system))
      const body =
        point.body >= 0
          ? system.planets[point.body]!
          : [...walkBodies(system)].find(
              (candidate) =>
                hasSolidSurface(candidate) && candidate.radius > 1e6,
            )!
      const placement = world.placeStructure({
        id: 'pad',
        assetId: 'mars-pad',
        bodyAddress: formatAddress(body.address),
        latitude: point.latitude,
        longitude: point.longitude,
        height: 30,
        heading: 0,
      })
      // The drive is lit so every tick is integrated rather than coasted on
      // rails, which is the tick that pays for the deck when it is asked.
      const radius = body.radius + 400_000
      const orbiter = world.spawnShip(
        'orbiter',
        bodyFrameId(body.address),
        vec3(radius, 0, 0),
        vec3(0, 0, -circularSpeed(body.mu, radius)),
      )
      world.setControl(orbiter.id, vec3(0, 0, 1), Vec.ZERO)
      world.runTicks(640)
      expect(world.isLanded(orbiter.id), body.name).toBe(false)
      expect(world.contactAsks, body.name).toBe(0)

      const frame = installSurfaceFrame(
        world.frames,
        body,
        placement.latitude,
        placement.longitude,
      )
      const hovering = world.spawn({
        id: dynamicEntityId(98),
        kind: 'probe',
        name: 'hover probe',
        state: reframe(
          world.frames,
          { ...restState(frame), position: vec3(0, 60, 0) },
          bodyFrameId(body.address),
          world.clock.time,
        ),
      })
      const before = world.contactAsks
      world.runTicks(8)
      expect(world.isLanded(hovering.id), body.name).toBe(false)
      expect(world.contactAsks, body.name).toBe(before + 8)
    }
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
