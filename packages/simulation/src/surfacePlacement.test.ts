import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import {
  type BodyFixedDirection,
  bodyFixedFrameId,
  geodeticDirection,
  surfaceAsset,
  surfaceRadius,
  systemId,
} from '@inertialref/universe'
import { World } from './world.ts'
import { snapshot } from './snapshot.ts'
import {
  type SurfacePlacement,
  surfacePlacementPose,
  surfaceSupportRadius,
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

  it('moves atomically and preserves the original when validation rejects a move', () => {
    const world = create()
    world.placeStructure(placement)
    const before = world.stateHash()
    expect(() => world.moveStructure({ ...placement, latitude: NaN })).toThrow()
    expect(world.stateHash()).toBe(before)
    expect(world.structures).toEqual([placement])
    expect(() => world.moveStructure({ ...placement, id: 'missing' })).toThrow()
    world.moveStructure({ ...placement, height: 3 })
    expect(world.structures[0]?.height).toBe(3)
    expect(world.stateHash()).not.toBe(before)
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
  it('decides a miss on the body radius exactly where the terrain sample would', () => {
    const world = create(),
      body = world.loadSystem(systemId('SOL')).planets[3]!
    const support = surfaceAsset(placement.assetId)!.supportRadius!
    const up = geodeticDirection(placement.latitude, placement.longitude)
    const east = Vec.normalize(Vec.cross(vec3(0, 1, 0), up))
    const north = Vec.cross(up, east)
    // The definition, with the terrain sampled before the disk is tested.
    const sampled = (direction: BodyFixedDirection): number | null => {
      const cosine = Vec.dot(up, direction)
      if (cosine <= 0) return null
      const radius = (surfaceRadius(body, up) + placement.height) / cosine
      const tangent = Vec.sub(direction, Vec.scale(up, cosine))
      return Vec.lengthSquared(tangent) * radius * radius > support * support
        ? null
        : radius
    }
    // Offsets in units of the disk's angular radius, so the edge is at unit
    // distance and both sides of it are sampled densely.
    const angle = support / body.radius
    fc.assert(
      fc.property(
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        (a, b) => {
          const direction = Vec.normalize(
            Vec.add(
              up,
              Vec.add(Vec.scale(east, a * angle), Vec.scale(north, b * angle)),
            ),
          ) as BodyFixedDirection
          expect(surfaceSupportRadius(placement, body, direction)).toBe(
            sampled(direction),
          )
        },
      ),
      { numRuns: 400 },
    )
    expect(
      surfaceSupportRadius(placement, body, up as BodyFixedDirection),
    ).not.toBeNull()
  })
  it('indexes placements by body and keeps the tallest deck current', () => {
    const world = create(),
      body = world.loadSystem(systemId('SOL')).planets[3]!
    expect(world.structuresOn(placement.bodyAddress)).toEqual([])
    expect(world.contactHeight(body)).toBe(0)
    world.placeStructure(placement)
    expect(world.structuresOn(placement.bodyAddress)).toEqual([placement])
    expect(world.structuresOn('g:milky-way/s:SOL/b:2')).toEqual([])
    const deck =
      surfaceRadius(
        body,
        geodeticDirection(placement.latitude, placement.longitude),
      ) -
      body.radius +
      placement.height
    // The basin is below the datum sphere, so the seeded deck is inside the
    // ground band and the band above it is zero; a tower clears the datum.
    expect(world.contactHeight(body)).toBeCloseTo(Math.max(0, deck), 6)
    world.moveStructure({ ...placement, height: 6000 })
    expect(world.contactHeight(body)).toBeCloseTo(
      Math.max(0, deck + 6000 - placement.height),
      6,
    )
    expect(world.contactHeight(body)).toBeGreaterThan(0)
    world.removeStructure(placement.id)
    expect(world.contactHeight(body)).toBe(0)
    expect(world.structuresOn(placement.bodyAddress)).toEqual([])
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
