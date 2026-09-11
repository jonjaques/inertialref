import { describe, expect, it } from 'vitest'
import { expect as unwrap } from '@inertialref/shared'
import { World, type SurfacePlacement } from '@inertialref/simulation'
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
