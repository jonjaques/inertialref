import fc from 'fast-check'
import { CHARACTER } from './character.ts'
import { describe, expect, it } from 'vitest'
import { Quaternion as Q, Vec } from '@inertialref/spatial'
import {
  systemId,
  surfaceRadius,
  bodyFixedDirection,
  bodyFrameId,
  directionToGeodetic,
  type EntityId,
  MARS_PAD,
} from '@inertialref/universe'
import { placementBasis } from './surfacePlacement.ts'
import { World } from './world.ts'

function setup(canFly = false) {
  const world = new World({ seed: 'inertialref' })
  const system = world.loadSystem(systemId('SOL'))
  const body = system.planets.find((body) => body.name === 'Mars')!
  const character = world.spawnCharacter(body, 0, 0, { canFly })
  world.runTicks(1)
  return { world, body, id: character.id }
}

describe('surface characters', () => {
  it('finds the ground through contact and walks without lifting into ship flight', () => {
    const { world, id } = setup()
    expect(world.isLanded(id)).toBe(true)
    const before = world.entities.require(id).state.position
    world.setCharacterInput(id, { forward: 1 })
    world.runTicks(64)
    const entity = world.entities.require(id)
    // A third of a second of the second is spent reaching the walk.
    expect(Vec.distance(entity.state.position, before)).toBeGreaterThan(
      CHARACTER.walkSpeed -
        CHARACTER.walkSpeed ** 2 / CHARACTER.groundAcceleration,
    )
    expect(entity.character?.grounded).toBe(true)
    expect(entity.rails).toBeNull()
  })

  it('jumps once per press and lands without penetrating the terrain', () => {
    const { world, body, id } = setup()
    world.setCharacterInput(id, { jump: true })
    world.runTicks(8)
    expect(world.entities.require(id).character?.grounded).toBe(false)
    expect(world.altitudeOf(id)).toBeGreaterThan(0.1)
    world.runTicks(256)
    const entity = world.entities.require(id)
    expect(entity.character?.grounded).toBe(true)
    const spin = world.frames.pose(entity.state.frame, world.clock.time)
    const direction = bodyFixedDirection(spin, world.canonicalPositionOf(id))
    expect(Vec.length(entity.state.position)).toBeCloseTo(
      surfaceRadius(body, direction),
      5,
    )
  })

  it('requires the spawn capability before enabling flight', () => {
    const visitor = setup()
    expect(visitor.world.setCharacterFlying(visitor.id, true)).toBe(false)
    const admin = setup(true)
    expect(admin.world.setCharacterFlying(admin.id, true)).toBe(true)
    admin.world.setCharacterInput(admin.id, { ascend: true })
    admin.world.runTicks(64)
    expect(admin.world.altitudeOf(admin.id)).toBeGreaterThan(5)
  })
})

it('walks and falls from the authored Mars deck when its support is removed', () => {
  const { world, body } = setup()
  world.placeStructure(MARS_PAD)
  const id = world.spawnCharacter(
    body,
    MARS_PAD.latitude,
    MARS_PAD.longitude,
  ).id
  world.setCharacterInput(id, { right: 1 })
  // Past the acceleration, the second second is a walk at exactly the walk.
  world.runTicks(32)
  const before = world.entities.require(id).state.position
  world.runTicks(64)
  expect(
    Vec.distance(world.entities.require(id).state.position, before),
  ).toBeCloseTo(CHARACTER.walkSpeed, 2)
  expect(world.isLanded(id)).toBe(true)
  world.removeStructure(MARS_PAD.id)
  world.runTicks(1)
  expect(world.entities.require(id).character?.grounded).toBe(false)
  world.runTicks(256)
  expect(world.isLanded(id)).toBe(true)
})

it('transports heading across the pole without a compass flip', () => {
  const { world, body } = setup()
  const id = world.spawnCharacter(body, Math.PI / 2 - 1e-7, 0, {
    heading: 0,
  }).id
  world.runTicks(1)
  const original = Q.basis(world.entities.require(id).state.orientation).forward
  world.setCharacterInput(id, { forward: 1 })
  world.runTicks(128)
  const entity = world.entities.require(id)
  expect(entity.state.position.x).toBeLessThan(0)
  expect(
    Vec.dot(Q.basis(entity.state.orientation).forward, original),
  ).toBeGreaterThan(0.999)
  expect(world.isLanded(id)).toBe(true)
})

it('normalizes diagonal input and applies crouch ahead of sprint (property)', () => {
  fc.assert(
    fc.property(
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.boolean(),
      fc.boolean(),
      (forward, right, sprint, crouch) => {
        const { world, body } = setup()
        world.placeStructure(MARS_PAD)
        const id = world.spawnCharacter(
          body,
          MARS_PAD.latitude,
          MARS_PAD.longitude,
        ).id
        world.setCharacterInput(id, { forward, right, sprint, crouch })
        world.runTicks(32)
        const before = world.entities.require(id).state.position
        world.runTicks(64)
        const entity = world.entities.require(id)
        const speed = crouch
          ? CHARACTER.crouchSpeed
          : sprint
            ? CHARACTER.sprintSpeed
            : CHARACTER.walkSpeed
        expect(Vec.distance(entity.state.position, before)).toBeCloseTo(
          Math.min(1, Math.hypot(forward, right)) * speed,
          2,
        )
        expect(entity.character?.crouched).toBe(crouch)
        expect(world.isLanded(id)).toBe(true)
      },
    ),
    { numRuns: 30 },
  )
})

it('steps the same input timeline identically when ticks are batched', () => {
  const a = setup(true)
  const b = setup(true)
  for (const input of [
    { forward: 1, right: 1, sprint: true },
    { jump: true },
    { forward: 0, right: 0, yaw: 1.2 },
    { jump: false, crouch: true },
  ]) {
    a.world.setCharacterInput(a.id, input)
    b.world.setCharacterInput(b.id, input)
    a.world.runTicks(96)
    for (let tick = 0; tick < 96; tick += 1) b.world.runTicks(1)
    expect(a.world.stateHash()).toBe(b.world.stateHash())
  }
})

it('lands descending flight, and rejects giants and nonfinite input', () => {
  const { world, id } = setup(true)
  world.setCharacterFlying(id, true)
  world.setCharacterInput(id, { ascend: true })
  world.runTicks(32)
  world.setCharacterInput(id, { ascend: false, descend: true })
  // A quarter second to turn the climb around, then the fall to the ground.
  world.runTicks(96)
  expect(world.entities.require(id).character?.flying).toBe(false)
  expect(world.isLanded(id)).toBe(true)
  expect(() => world.setCharacterInput(id, { yaw: NaN })).toThrow()
  const jupiter = world
    .loadedSystems()[0]!
    .planets.find((body) => body.name === 'Jupiter')!
  expect(() => world.spawnCharacter(jupiter, 0, 0)).toThrow(/solid/)
})

it('turns clockwise for positive heading, matching a character spawned at that heading', () => {
  const { world, body, id } = setup()
  const right = Q.basis(world.entities.require(id).state.orientation).right
  world.setCharacterInput(id, { yaw: Math.PI / 2 })
  world.runTicks(1)
  const turned = world.entities.require(id)
  expect(Vec.dot(Q.basis(turned.state.orientation).forward, right)).toBeCloseTo(
    1,
    8,
  )
  const other = world.spawnCharacter(body, 0, 0, { heading: Math.PI / 2 })
  expect(
    Q.approxEquals(turned.state.orientation, other.state.orientation),
  ).toBe(true)
})

it('revokes restored flight privileges and removes avatars without leftover bookkeeping', () => {
  const { world, id } = setup(true)
  world.setCharacterFlying(id, true)
  world.setCharacterInput(id, { ascend: true })
  world.runTicks(16)
  world.setCharacterFlightPermission(id, false)
  expect(world.entities.require(id).character?.flying).toBe(false)
  expect(world.setCharacterFlying(id, true)).toBe(false)
  world.runTicks(512)
  expect(world.isLanded(id)).toBe(true)
  expect(world.removeCharacter(id)).toBe(true)
  expect(world.removeCharacter(id)).toBe(false)
  expect(world.isLanded(id)).toBe(false)
  expect(world.previousState(id)).toBeUndefined()
  expect(world.altitudeOf(id)).toBeNull()
})

it('refuses a ship-frame teleport atomically', () => {
  const { world, body, id } = setup()
  const entity = world.entities.require(id)
  const before = world.stateHash()
  expect(() =>
    world.teleport(id, { ...entity.state, frame: bodyFrameId(body.address) }),
  ).toThrow(/body-fixed/)
  expect(world.stateHash()).toBe(before)
})

/*
 * The pad in its own meters: a character placed at (x, z) of the asset, and
 * read back the same way, so a test can say "26 m out on the deck" and
 * "the top of the ramp" rather than a latitude to nine places.
 */
function padRig() {
  const { world, body } = setup()
  world.placeStructure(MARS_PAD)
  const basis = placementBasis(MARS_PAD)
  const datum = surfaceRadius(body, basis.up) + MARS_PAD.height
  const place = (x: number, z: number, heading: number) => {
    const point = Vec.add(
      Vec.scale(basis.up, datum),
      Vec.add(Vec.scale(basis.east, x), Vec.scale(basis.south, z)),
    )
    const site = directionToGeodetic(Vec.normalize(point))
    const id = world.spawnCharacter(body, site.latitude, site.longitude, {
      heading,
    }).id
    world.runTicks(1)
    return id
  }
  const read = (id: string) => {
    const position = world.entities.require(id as EntityId).state.position
    const direction = Vec.normalize(position)
    const cosine = Vec.dot(basis.up, direction)
    const tangent = Vec.sub(direction, Vec.scale(basis.up, cosine))
    const scale = datum / cosine
    return {
      x: scale * Vec.dot(tangent, basis.east),
      z: scale * Vec.dot(tangent, basis.south),
      top: Vec.length(position) * cosine - datum,
      grounded: world.entities.require(id as EntityId).character!.grounded,
    }
  }
  // The asset's +X is east turned by the heading; +Z is south turned by it.
  const alongX = MARS_PAD.heading + Math.PI / 2
  const alongZ = MARS_PAD.heading + Math.PI
  return { world, body, place, read, alongX, alongZ }
}

describe('the pad is solid where it is drawn', () => {
  it('steps off the deck onto the aprons and falls only past the outer edge', () => {
    const { world, place, read, alongX } = padRig()
    const id = place(24, 0, alongX)
    world.setCharacterInput(id, { forward: 1 })
    let left = false
    for (let i = 0; i < 64; i += 1) {
      world.runTicks(8)
      const at = read(id)
      if (at.x < 44) {
        // Deck, joint, warning band, apron panels, outer apron: every drop
        // between them is a boot's step, so the walk never leaves the ground.
        expect(at.grounded, `x=${at.x.toFixed(2)}`).toBe(true)
        if (at.x > 30 && at.x < 37) expect(at.top).toBeCloseTo(-0.08, 3)
        if (at.x > 38 && at.x < 44) expect(at.top).toBeCloseTo(-0.18, 3)
      } else if (at.x > 45) left = true
    }
    expect(left).toBe(true)
    world.runTicks(256)
    const off = read(id)
    // The skirt is buried in ground that lies about two meters under the
    // datum at the anchor; the fall ends on terrain, not inside the pad.
    expect(off.grounded).toBe(true)
    expect(off.top).toBeLessThan(-1)
  })

  it('walks down the access ramp attached to it and back up again', () => {
    const { world, place, read, alongZ } = padRig()
    const id = place(0, 37, alongZ)
    world.setCharacterInput(id, { forward: 1 })
    let sampled = 0
    for (let i = 0; i < 40; i += 1) {
      world.runTicks(8)
      const at = read(id)
      if (at.z > 45 && at.z < 56) {
        sampled += 1
        expect(at.grounded, `z=${at.z.toFixed(2)}`).toBe(true)
        // The ramp is buried where the ground rises to meet it, about two
        // meters under the datum here, and the ground is what carries a
        // boot from there: the top is never below the slab.
        const slab = -0.18 - ((at.z - 44.7) / 12.3) * 3.32
        expect(at.top).toBeGreaterThan(slab - 0.005)
        if (at.z < 50) expect(at.top).toBeCloseTo(slab, 2)
      }
    }
    expect(sampled).toBeGreaterThan(6)
    // Turn around at the foot of the ramp and climb it.
    world.setCharacterInput(id, { forward: 0 })
    world.runTicks(8)
    const foot = read(id)
    expect(foot.z).toBeGreaterThan(50)
    world.setCharacterInput(id, { yaw: alongZ + Math.PI, forward: 1 })
    world.runTicks(64 * 8)
    const back = read(id)
    // Back across the aprons and onto the deck: the climb is a walk.
    expect(back.z).toBeLessThan(40)
    expect(back.grounded).toBe(true)
    expect(back.top).toBeGreaterThanOrEqual(-0.18)
    expect(back.top).toBeLessThanOrEqual(0.02)
  })

  it('is stopped by a service plinth as by any rise a step cannot take', () => {
    const { world, place, read, alongX } = padRig()
    const theta = Math.PI / 8
    const radial = (r: number) => [r * Math.cos(theta), -r * Math.sin(theta)]
    const [x, z] = radial(35)
    const id = place(x!, z!, alongX - theta)
    world.setCharacterInput(id, { forward: 1 })
    world.runTicks(64 * 3)
    const at = read(id)
    // The plinth's near face is 1.7 m inside its 38.5 m center.
    expect(Math.hypot(at.x, at.z)).toBeLessThan(36.85)
    expect(Math.hypot(at.x, at.z)).toBeGreaterThan(36.3)
    expect(at.top).toBeCloseTo(-0.08, 3)
    expect(at.grounded).toBe(true)
  })
})
