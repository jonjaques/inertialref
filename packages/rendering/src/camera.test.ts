import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  createRenderOrigin,
  Quaternion as Q,
  UNIVERSE_ORIGIN,
  UV,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  chaseCameraPosition,
  chaseOffsetFor,
  clampOrbitDistance,
  DEFAULT_FLIGHT_CAMERA,
  type FlightCameraState,
  flightCameraPose,
  ORBIT_LENGTHS,
  orbitFrame,
  orbitOffset,
  orbitToward,
} from './camera.ts'
import { NO_LOOK } from './observer.ts'
import type { RenderScene } from './scene.ts'

/** A scene with a ship in it and nothing else: what the flight camera reads. */
function sceneWith(
  position: Vec3,
  orientation = Q.IDENTITY,
  up = vec3(0, 1, 0),
  altitude: number | null = null,
): RenderScene {
  return {
    origin: createRenderOrigin(UNIVERSE_ORIGIN),
    camera: {
      position,
      orientation,
      universePosition: UV.fromVec3(position),
      up,
      altitude,
    },
    bodies: [],
    stars: [],
    entities: [],
    terrainCandidates: [],
  }
}

const unit = fc.double({ min: -1, max: 1, noNaN: true })
const direction = fc
  .tuple(unit, unit, unit)
  .map(([x, y, z]) => vec3(x, y, z))
  .filter((v) => Vec.length(v) > 0.1)
  .map((v) => Vec.normalize(v))
const rotation = fc
  .tuple(direction, fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }))
  .map(([axis, angle]) => Q.fromAxisAngle(axis, angle))
const metres = fc.double({ min: -1e5, max: 1e5, noNaN: true })
const point = fc.tuple(metres, metres, metres).map(([x, y, z]) => vec3(x, y, z))
const orbit = fc.record({
  azimuth: fc.double({ min: -10, max: 10, noNaN: true }),
  elevation: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
  distance: fc.double({
    min: ORBIT_LENGTHS.min,
    max: ORBIT_LENGTHS.max,
    noNaN: true,
  }),
})
const hull = fc.double({ min: 6, max: 700, noNaN: true })

const forwardOf = (q: Parameters<typeof Q.rotate>[0]): Vec3 =>
  Q.rotate(q, vec3(0, 0, -1))

describe('the orbit frame', () => {
  it('is orthonormal about any up (property)', () => {
    fc.assert(
      fc.property(direction, (up) => {
        const frame = orbitFrame(up)
        expect(Vec.length(frame.east)).toBeCloseTo(1, 9)
        expect(Vec.length(frame.north)).toBeCloseTo(1, 9)
        expect(Vec.dot(frame.east, frame.up)).toBeCloseTo(0, 9)
        expect(Vec.dot(frame.north, frame.up)).toBeCloseTo(0, 9)
        expect(Vec.dot(frame.east, frame.north)).toBeCloseTo(0, 9)
      }),
    )
  })

  it('stands the camera where it was asked, and reads the same angles back (property)', () => {
    fc.assert(
      fc.property(direction, direction, hull, (up, toward, length) => {
        // Not along the pole: the azimuth is undefined there, by construction.
        fc.pre(Math.abs(Vec.dot(toward, Vec.normalize(up))) < 0.99)
        const state = orbitToward(up, toward, 2)
        const offset = orbitOffset(up, state, length)
        expect(Vec.length(offset)).toBeCloseTo(2 * length, 6)
        expect(Vec.dot(Vec.normalize(offset), toward)).toBeCloseTo(1, 6)
      }),
    )
  })

  it('clamps the tether at both ends', () => {
    expect(clampOrbitDistance(0)).toBe(ORBIT_LENGTHS.min)
    expect(clampOrbitDistance(1e9)).toBe(ORBIT_LENGTHS.max)
    expect(clampOrbitDistance(2)).toBe(2)
    expect(orbitToward(vec3(0, 1, 0), vec3(1, 0, 0), 100).distance).toBe(
      ORBIT_LENGTHS.max,
    )
  })
})

describe('the flight camera pose', () => {
  it('in the chase view with the head centred is the chase camera exactly (property)', () => {
    fc.assert(
      fc.property(point, rotation, hull, (position, orientation, length) => {
        const scene = sceneWith(position, orientation)
        const pose = flightCameraPose(scene, DEFAULT_FLIGHT_CAMERA, length)
        expect(pose.position).toEqual(
          chaseCameraPosition(scene, chaseOffsetFor(length)),
        )
        expect(pose.orientation).toBe(orientation)
      }),
    )
  })

  it('in the orbit view looks at the ship from the orbit distance, horizon level (property)', () => {
    fc.assert(
      fc.property(
        point,
        rotation,
        direction,
        orbit,
        hull,
        (position, orientation, up, state, length) => {
          const scene = sceneWith(position, orientation, up)
          const camera: FlightCameraState = {
            view: 'orbit',
            orbit: state,
            look: NO_LOOK,
          }
          const pose = flightCameraPose(scene, camera, length)
          const toShip = Vec.sub(position, pose.position)
          expect(Vec.length(toShip)).toBeCloseTo(state.distance * length, 3)
          expect(
            Vec.dot(forwardOf(pose.orientation), Vec.normalize(toShip)),
          ).toBeCloseTo(1, 6)
          // The right-hand axis lies in the horizon: no roll about the view.
          const right = Q.rotate(pose.orientation, vec3(1, 0, 0))
          expect(Vec.dot(right, Vec.normalize(up))).toBeCloseTo(0, 6)
          // The ship's own attitude never enters an orbit — the camera holds
          // still in the world while the hull turns.
          const turned = flightCameraPose(
            sceneWith(position, Q.IDENTITY, up),
            camera,
            length,
          )
          expect(turned.position).toEqual(pose.position)
          expect(turned.orientation).toEqual(pose.orientation)
        },
      ),
    )
  })

  it('keeps an orbit off the ground by the same floor the chase has', () => {
    // Nose-level ship two meters up, orbit straight below it: lifted to the
    // clearance rather than drawn from under the crust.
    const scene = sceneWith(vec3(0, 0, 0), Q.IDENTITY, vec3(0, 1, 0), 2)
    const pose = flightCameraPose(
      scene,
      {
        view: 'orbit',
        orbit: { azimuth: 0, elevation: -1.4, distance: 2 },
        look: NO_LOOK,
      },
      46,
      chaseOffsetFor(46),
    )
    expect(pose.position.y).toBeCloseTo(0, 9)
    expect(Vec.dot(forwardOf(pose.orientation), vec3(0, 1, 0))).toBeLessThan(
      0.2,
    )
  })

  it('turns the head from either view without moving the eye', () => {
    const scene = sceneWith(vec3(10, 20, 30), Q.IDENTITY)
    for (const view of ['chase', 'orbit'] as const) {
      const centred = flightCameraPose(
        scene,
        { ...DEFAULT_FLIGHT_CAMERA, view },
        46,
      )
      const turned = flightCameraPose(
        scene,
        { ...DEFAULT_FLIGHT_CAMERA, view, look: { yaw: 0.5, pitch: 0.2 } },
        46,
      )
      expect(turned.position).toEqual(centred.position)
      expect(
        Vec.dot(forwardOf(turned.orientation), forwardOf(centred.orientation)),
      ).toBeLessThan(0.99)
    }
  })
})
