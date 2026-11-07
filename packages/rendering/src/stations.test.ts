import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  createRenderOrigin,
  Quaternion as Q,
  toRenderSpace,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import { snapshot, World } from '@inertialref/simulation'
import {
  stationFixedFrameId,
  stationFrameId,
  systemFrameId,
  systemId,
} from '@inertialref/universe'
import { NEAR_LIMIT } from './placement.ts'
import { buildScene } from './scene.ts'

declare const structuredClone: <T>(value: T) => T

describe('stations in a frame', () => {
  const world = new World({ seed: 'inertialref' })
  const sol = world.loadSystem(systemId('SOL'))
  const iss = sol.stations[0]!
  const time = 4_321.5

  /** A frame from `distance` meters off the station's port side. */
  const frameFrom = (distance: number) => {
    const shot = snapshot(world, 0, time)
    const station = shot.stations[0]!
    const eye = {
      position: UV.translate(
        station.position,
        Q.rotate(station.orientation, vec3(-distance, 0, 0)),
      ),
      orientation: station.orientation,
    }
    const origin = createRenderOrigin(eye.position)
    return { shot, station, origin, scene: buildScene(shot, origin, null, eye) }
  }

  it('carries each station’s own axes at the presentation instant', () => {
    const shot = snapshot(world, 0.5)
    const station = shot.stations.find((one) => one.id === iss.id)
    expect(station).toBeDefined()
    // The snapshot's instant, not the tick's (Rule 38).
    const pose = world.frames.pose(stationFixedFrameId(iss.id), shot.renderTime)
    expect(UV.distance(station!.position, pose.position)).toBe(0)
    expect(station!.orientation).toEqual(pose.orientation)
    expect(station!.frame).toBe(stationFrameId(iss.id))
    expect(station!.parent).toBe('g:milky-way/s:SOL/b:2')
    expect(station!.address).toBe('g:milky-way/s:SOL/b:2/a:0')
    expect(() => structuredClone(shot)).not.toThrow()
  })

  it('places a station about the eye and draws it only near and above the point tier', () => {
    const near = frameFrom(400)
    const placed = near.scene.stations[0]!
    expect(placed.drawn).toBe(true)
    expect(placed.placement.compressed).toBe(false)
    expect(
      Vec.distance(
        placed.placement.position,
        toRenderSpace(near.origin, near.station.position),
      ),
    ).toBeLessThan(1e-6)
    expect(placed.placement.scale).toBe(iss.radius)

    // Inside the near field but under a third of a pixel: a point, not drawn.
    const far = frameFrom(1_000_000).scene.stations[0]!
    expect(far.placement.compressed).toBe(false)
    expect(far.placement.tier).toBe('point')
    expect(far.drawn).toBe(false)

    // Past the near field the model would be shrunk toward the eye.
    const beyond = frameFrom(NEAR_LIMIT * 2).scene.stations[0]!
    expect(beyond.placement.compressed).toBe(true)
    expect(beyond.drawn).toBe(false)
  })

  it('points the arrays’ sun at the star, in the station’s axes (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), (t) => {
        const shot = snapshot(world, 0, t)
        const station = shot.stations[0]!
        const eye = { position: station.position, orientation: Q.IDENTITY }
        const scene = buildScene(
          shot,
          createRenderOrigin(station.position),
          null,
          eye,
        )
        const sun = scene.stations[0]!.sun
        expect(sun).not.toBeNull()
        const star = world.frames.pose(systemFrameId(sol.id), t).position
        const toStar = Vec.normalize(UV.difference(star, station.position))
        expect(Vec.length(sun!)).toBeCloseTo(1, 12)
        expect(
          Vec.dot(Q.rotate(station.orientation, sun!), toStar),
        ).toBeCloseTo(1, 12)
      }),
      { numRuns: 40 },
    )
  })
})
