import { describe, expect, it } from 'vitest'
import { expect as unwrap } from '@inertialref/shared'
import { World, type SurfacePlacement } from '@inertialref/simulation'
import { reframe, restState, vec3 } from '@inertialref/spatial'
import {
  bodyFrameId,
  dynamicEntityId,
  installSurfaceFrame,
  systemId,
} from '@inertialref/universe'
import { captureSave, parseSave, restoreSave, serializeSave } from './save.ts'

const placement: SurfacePlacement = {
  id: 'pad',
  assetId: 'mars-pad',
  bodyAddress: 'g:milky-way/s:SOL/b:3',
  latitude: 0.603,
  longitude: 1.48,
  height: 2,
  heading: 0.4,
}

describe('saved surface structures', () => {
  it('continues a raised-pad touchdown and removal identically after a save', () => {
    const world = new World({ seed: 'inertialref' })
    const body = world.loadSystem(systemId('SOL')).planets[3]!
    world.placeStructure({ ...placement, height: 30 })
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
        position: vec3(0, 35, 0),
        velocity: vec3(0, -20, 0),
      },
      bodyFrameId(body.address),
      world.clock.time,
    )
    const ship = world.spawn({
      id: dynamicEntityId(99),
      kind: 'probe',
      name: 'contact',
      state,
    })
    world.runTicks(5)
    const restored = unwrap(
      restoreSave(captureSave(world, ship.id)),
      'restore',
    ).world
    world.runTicks(64)
    restored.runTicks(64)
    expect(world.isLanded(ship.id)).toBe(true)
    expect(restored.stateHash()).toBe(world.stateHash())
    const landed = unwrap(
      restoreSave(captureSave(world, ship.id)),
      'restore',
    ).world
    world.removeStructure(placement.id)
    landed.removeStructure(placement.id)
    world.runTicks(400)
    landed.runTicks(400)
    expect(landed.stateHash()).toBe(world.stateHash())
  })
  it('round-trips every field and the canonical hash without loading the body', () => {
    const world = new World({ seed: 'inertialref' })
    world.placeStructure(placement)
    const saved = captureSave(world, null)
    expect(saved.structures).toEqual([placement])
    const decoded = unwrap(parseSave(serializeSave(saved)), 'parse')
    const restored = unwrap(restoreSave(decoded), 'restore').world
    expect(restored.structures).toEqual([placement])
    expect(restored.loadedSystems()).toHaveLength(0)
    expect(restored.stateHash()).toBe(world.stateHash())
    restored.runTicks(300)
    world.runTicks(300)
    expect(restored.stateHash()).toBe(world.stateHash())
  })
  it('migrates v1 to an empty placement collection without respawning authored scenery', () => {
    const saved = captureSave(new World({ seed: 'inertialref' }), null)
    const old = { ...saved, schemaVersion: 1, structures: undefined }
    const parsed = unwrap(parseSave(JSON.stringify(old)), 'parse')
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.structures).toEqual([])
  })
  it('rejects corrupt fields and duplicate placement ids', () => {
    const world = new World({ seed: 'inertialref' })
    world.placeStructure(placement)
    const saved = captureSave(world, null)
    for (const changes of [
      { latitude: 2 },
      { longitude: 4 },
      { height: -1 },
      { heading: 8 },
      { id: '' },
      { height: '2' },
    ]) {
      expect(
        parseSave(
          JSON.stringify({
            ...saved,
            structures: [{ ...placement, ...changes }],
          }),
        ).ok,
      ).toBe(false)
    }
    expect(
      parseSave(
        JSON.stringify({ ...saved, structures: [placement, placement] }),
      ).ok,
    ).toBe(false)
    for (const changes of [
      { assetId: 'missing' },
      { bodyAddress: 'g:milky-way/s:SOL/b:5' },
    ]) {
      const parsed = unwrap(
        parseSave(
          JSON.stringify({
            ...saved,
            structures: [{ ...placement, ...changes }],
          }),
        ),
        'parse',
      )
      expect(restoreSave(parsed).ok).toBe(false)
    }
  })
})
