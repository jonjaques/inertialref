import { describe, expect, it } from 'vitest'
import { expect as unwrap } from '@inertialref/shared'
import { vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import { bodyFrameId, systemId } from '@inertialref/universe'
import { SAVE_SCHEMA_VERSION } from '@inertialref/protocol'
import { captureSave, parseSave, restoreSave, serializeSave } from './save.ts'

describe('character persistence', () => {
  it.each(['jump', 'flight'] as const)(
    'continues a %s on the same canonical state after reload',
    (mode) => {
      const world = new World({ seed: 'inertialref' })
      const body = world
        .loadSystem(systemId('SOL'))
        .planets.find((body) => body.name === 'Mars')!
      const character = world.spawnCharacter(body, 0, 0, { canFly: true })
      world.runTicks(1)
      if (mode === 'flight') world.setCharacterFlying(character.id, true)
      world.setCharacterInput(character.id, {
        forward: 1,
        right: 1,
        sprint: true,
        jump: true,
        ascend: true,
        yaw: 0.4,
      })
      world.runTicks(16)
      const save = unwrap(
        parseSave(serializeSave(captureSave(world, character.id))),
        'decode',
      )
      const restored = unwrap(restoreSave(save), 'restore')
      expect(restored.world.stateHash()).toBe(world.stateHash())
      world.runTicks(192)
      restored.world.runTicks(192)
      expect(restored.world.stateHash()).toBe(world.stateHash())
    },
  )

  it('migrates a schema-three ship to a null character controller', () => {
    const world = new World({ seed: 'inertialref' })
    const save = captureSave(world, null)
    const restored = unwrap(
      parseSave(JSON.stringify({ ...save, schemaVersion: 3 })),
      'migration',
    )
    expect(restored.schemaVersion).toBe(SAVE_SCHEMA_VERSION)
    expect(unwrap(restoreSave(restored), 'restore').world.stateHash()).toBe(
      world.stateHash(),
    )
  })

  /** Two ships at Mars and a walker that belongs to the second. */
  const twoShips = () => {
    const world = new World({ seed: 'inertialref' })
    const mars = world
      .loadSystem(systemId('SOL'))
      .planets.find((body) => body.name === 'Mars')!
    const frame = bodyFrameId(mars.address)
    const first = world.spawnShip('First', frame, vec3(mars.radius * 3, 0, 0))
    const second = world.spawnShip('Second', frame, vec3(0, mars.radius * 3, 0))
    const walker = world.spawnCharacter(mars, 0, 0, { vessel: second.id })
    return { world, first, second, walker }
  }

  it('carries the ship a walker steps back into, not the first one', () => {
    const { world, second, walker } = twoShips()
    const save = unwrap(
      parseSave(serializeSave(captureSave(world, walker.id))),
      'decode',
    )
    const restored = unwrap(restoreSave(save), 'restore').world
    expect(restored.entities.require(walker.id).character?.vessel).toBe(
      second.id,
    )
    expect(restored.stateHash()).toBe(world.stateHash())
  })

  it('migrates a schema-four walker into the first ship in id order', () => {
    // The rule the game applied on every v4 load, applied once more.
    const { world, first, walker } = twoShips()
    const save = captureSave(world, walker.id)
    const v4 = {
      ...save,
      schemaVersion: 4,
      entities: save.entities.map((entity) => {
        if (entity.character === null) return entity
        const { vessel: _vessel, ...character } = entity.character
        return { ...entity, character }
      }),
    }
    const migrated = unwrap(parseSave(JSON.stringify(v4)), 'migration')
    const restored = unwrap(restoreSave(migrated), 'restore').world
    expect(restored.entities.require(walker.id).character?.vessel).toBe(
      first.id,
    )
  })

  it('refuses a walker whose vessel is not a ship in the save', () => {
    const { world, walker } = twoShips()
    const save = captureSave(world, walker.id)
    const pointing = (vessel: string) => ({
      ...save,
      entities: save.entities.map((entity) =>
        entity.character === null
          ? entity
          : { ...entity, character: { ...entity.character, vessel } },
      ),
    })
    expect(restoreSave(pointing('#99')).ok).toBe(false)
    expect(restoreSave(pointing(walker.id)).ok).toBe(false)
  })

  it('refuses a walker whose vessel is a marker rather than a ship', () => {
    const { world, second, walker } = twoShips()
    const save = captureSave(world, walker.id)
    const marked = {
      ...save,
      entities: save.entities.map((entity) =>
        entity.id === second.id
          ? { ...entity, kind: 'marker' as const }
          : entity,
      ),
    }
    expect(restoreSave(save).ok).toBe(true)
    expect(restoreSave(marked).ok).toBe(false)
  })

  it('refuses flight without its capability and character/flight frame mismatches', () => {
    const world = new World({ seed: 'inertialref' })
    const body = world
      .loadSystem(systemId('SOL'))
      .planets.find((body) => body.name === 'Mars')!
    const id = world.spawnCharacter(body, 0, 0).id
    const save = captureSave(world, id)
    const character = save.entities[0]!
    expect(
      parseSave(
        JSON.stringify({
          ...save,
          entities: [
            {
              ...character,
              character: { ...character.character, flying: true },
            },
          ],
        }),
      ).ok,
    ).toBe(false)
    expect(
      restoreSave({ ...save, entities: [{ ...character, kind: 'ship' }] }).ok,
    ).toBe(false)
  })
})
