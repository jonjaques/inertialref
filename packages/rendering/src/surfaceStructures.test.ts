import { describe, expect, it } from 'vitest'
import {
  Quaternion as Q,
  createRenderOrigin,
  toRenderSpace,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import { snapshot, surfacePlacementPose, World } from '@inertialref/simulation'
import {
  bodyFixedFrameId,
  bodyFrameId,
  drawnSurfaceRadius,
  geodeticDirection,
  systemId,
} from '@inertialref/universe'
import { buildScene, STRUCTURE_VISIBILITY_METRES } from './scene.ts'

describe('surface structures in a frame', () => {
  const prepare = () => {
    const world = new World({ seed: 'inertialref' })
    const mars = world.loadSystem(systemId('SOL')).planets[3]!
    const ship = world.spawnShip(
      'camera',
      bodyFrameId(mars.address),
      vec3(mars.radius * 2, 0, 0),
    )
    const placement = world.placeStructure({
      id: 'pad',
      assetId: 'mars-pad',
      bodyAddress: 'g:milky-way/s:SOL/b:3',
      latitude: 0.6031917532451286,
      longitude: 1.4844702100937137,
      height: 2,
      heading: 0.4,
    })
    return { world, mars, ship, placement }
  }
  it('places the metric asset on drawn ground through the shared resolver', () => {
    const { world, mars, ship, placement } = prepare(),
      time = 1234
    const shot = snapshot(world, 0, time),
      spin = world.frames.pose(bodyFixedFrameId(mars.address), time)
    const pose = surfacePlacementPose(
      placement,
      mars,
      spin,
      drawnSurfaceRadius(
        mars,
        geodeticDirection(placement.latitude, placement.longitude),
      ),
    )
    const eye = {
      position: UV.translate(
        pose.position,
        Q.rotate(pose.orientation, vec3(0, 10, 100)),
      ),
      orientation: pose.orientation,
    }
    const origin = createRenderOrigin(eye.position),
      scene = buildScene(shot, origin, ship.id, eye)
    expect(scene.structures).toHaveLength(1)
    expect(
      Vec.distance(
        scene.structures[0]!.position,
        toRenderSpace(origin, pose.position),
      ),
    ).toBeLessThan(1e-8)
    expect(scene.structures[0]!.id).toBe('pad')
    expect(scene.structures[0]!.assetId).toBe('mars-pad')
  })
  it('culls distant metric geometry instead of detaching it from a compressed planet', () => {
    const { world, mars, ship } = prepare(),
      shot = snapshot(world, 0, 0),
      structure = shot.structures[0]!
    for (const distance of [
      STRUCTURE_VISIBILITY_METRES + 1,
      mars.radius * 100,
    ]) {
      const eye = {
        position: UV.translate(
          structure.position,
          Q.rotate(structure.orientation, vec3(0, distance, 0)),
        ),
        orientation: structure.orientation,
      }
      const scene = buildScene(
        shot,
        createRenderOrigin(eye.position),
        ship.id,
        eye,
      )
      expect(scene.structures).toEqual([])
    }
  })
})
