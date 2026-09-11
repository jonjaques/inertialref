import { describe, expect, it } from 'vitest'
import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import {
  bodyFixedFrameId,
  geodeticDirection,
  surfaceRadius,
  systemId,
} from '@inertialref/universe'
import { World } from './world.ts'
import { snapshot } from './snapshot.ts'
import {
  type SurfacePlacement,
  surfacePlacementPose,
} from './surfacePlacement.ts'

const placement: SurfacePlacement = {
  id: 'mars-pad',
  assetId: 'mars-pad',
  bodyAddress: 'g:milky-way/s:SOL/b:3',
  latitude: 0.6031917532451286,
  longitude: 1.4844702100937137,
  height: 2,
  heading: 0.4,
}
const create = () => new World({ seed: 'inertialref' })

describe('body-fixed structures', () => {
  it('owns immutable records in stable id order', () => {
    const a = create(),
      b = create()
    a.placeStructure({ ...placement, id: 'z' })
    a.placeStructure({ ...placement, id: 'a' })
    b.placeStructure({ ...placement, id: 'a' })
    b.placeStructure({ ...placement, id: 'z' })
    expect(a.structures.map((s) => s.id)).toEqual(['a', 'z'])
    expect(a.stateHash()).toBe(b.stateHash())
    expect(Object.isFrozen(a.structures)).toBe(true)
    expect(Object.isFrozen(a.structures[0])).toBe(true)
  })
  it('rejects invalid records and duplicate ids before changing the world', () => {
    const world = create()
    const hash = world.stateHash()
    for (const invalid of [
      { latitude: NaN },
      { latitude: 2 },
      { longitude: 4 },
      { height: Infinity },
      { height: -1 },
      { heading: Infinity },
      { id: '' },
      { assetId: 'missing' },
      { bodyAddress: 's:SOL/b:99' },
      { bodyAddress: 'g:milky-way/s:SOL/b:5' },
      { bodyAddress: 'g:elsewhere/s:SOL/b:3' },
    ]) {
      expect(() => world.placeStructure({ ...placement, ...invalid })).toThrow()
      expect(world.stateHash()).toBe(hash)
      expect(world.loadedSystems()).toHaveLength(0)
    }
    world.placeStructure(placement)
    expect(() => world.placeStructure(placement)).toThrow(/already/)
    expect(world.structures).toHaveLength(1)
  })
  it('hashes every authored field and removes through a verb', () => {
    const original = create()
    original.placeStructure(placement)
    for (const changed of [
      { id: 'other' },
      { latitude: 0.5 },
      { longitude: 1.5 },
      { height: 3 },
      { heading: 0.5 },
      { bodyAddress: 'g:milky-way/s:SOL/b:2' },
    ]) {
      const world = create()
      world.placeStructure({ ...placement, ...changed })
      expect(world.stateHash()).not.toBe(original.stateHash())
    }
    expect(original.removeStructure(placement.id)).toBe(true)
    expect(original.removeStructure(placement.id)).toBe(false)
    expect(original.stateHash()).toBe(create().stateHash())
  })
  it('resolves an authored pose at the snapshot presentation instant', () => {
    const world = create(),
      body = world.loadSystem(systemId('SOL')).planets[3]!
    world.placeStructure(placement)
    for (const time of [0, 1234, body.rotationPeriod / 4]) {
      const shot = snapshot(world, 0, time),
        structure = shot.structures[0]!
      const spin = world.frames.pose(bodyFixedFrameId(body.address), time)
      const pose = surfacePlacementPose(placement, body, spin)
      expect(UV.distance(structure.position, pose.position)).toBeLessThan(1e-5)
      expect(Q.approxEquals(structure.orientation, pose.orientation)).toBe(true)
      const up = Q.rotate(
        spin.orientation,
        geodeticDirection(placement.latitude, placement.longitude),
      )
      expect(
        Vec.distance(Q.rotate(pose.orientation, vec3(0, 1, 0)), up),
      ).toBeLessThan(1e-12)
      expect(UV.distance(pose.position, spin.position)).toBeCloseTo(
        surfaceRadius(
          body,
          geodeticDirection(placement.latitude, placement.longitude),
        ) + placement.height,
        3,
      )
    }
    const first = snapshot(world, 0, 0).structures[0]!
    const later = snapshot(world, 0, body.rotationPeriod / 4).structures[0]!
    expect(Q.approxEquals(first.orientation, later.orientation)).toBe(false)
  })
  it('retains unloaded placements without retaining their system frames', () => {
    const world = create()
    world.placeStructure(placement)
    expect(world.loadedSystems()).toHaveLength(0)
    expect(snapshot(world).structures).toEqual([])
    world.loadSystem(systemId('SOL'))
    expect(snapshot(world).structures).toHaveLength(1)
    world.unloadSystem(systemId('SOL'))
    expect(world.structures).toHaveLength(1)
    expect(snapshot(world).structures).toEqual([])
    world.loadSystem(systemId('SOL'))
    expect(snapshot(world).structures[0]?.id).toBe(placement.id)
  })
})
