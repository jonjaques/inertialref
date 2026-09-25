import { describe, expect, it } from 'vitest'
import { expect as unwrap } from '@inertialref/shared'
import { World } from '@inertialref/simulation'
import { systemId } from '@inertialref/universe'
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
    expect(restored.schemaVersion).toBe(4)
    expect(unwrap(restoreSave(restored), 'restore').world.stateHash()).toBe(
      world.stateHash(),
    )
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
