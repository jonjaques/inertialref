import fc from 'fast-check'
import { CHARACTER } from './character.ts'
import { describe, expect, it } from 'vitest'
import { Quaternion as Q, Vec } from '@inertialref/spatial'
import {
  systemId,
  surfaceRadius,
  bodyFixedDirection,
  bodyFrameId,
  MARS_PAD,
} from '@inertialref/universe'
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
    expect(Vec.distance(entity.state.position, before)).toBeGreaterThan(3)
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
  world.runTicks(1)
  const before = world.entities.require(id).state.position
  world.setCharacterInput(id, { right: 1 })
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
        world.runTicks(1)
        const before = world.entities.require(id).state.position
        world.setCharacterInput(id, { forward, right, sprint, crouch })
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
  world.runTicks(64)
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
