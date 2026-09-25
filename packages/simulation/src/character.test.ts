import { describe, expect, it } from 'vitest'
import { Vec } from '@inertialref/spatial'
import {
  systemId,
  surfaceRadius,
  bodyFixedDirection,
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
