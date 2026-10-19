import { describe, expect, it } from 'vitest'
import {
  Quaternion as Q,
  type Quat,
  reframe,
  restState,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  type Body,
  bodyFixedFrameId,
  bodyFrameId,
  compassBasis,
  dynamicEntityId,
  formatAddress,
  hasSolidSurface,
  installSurfaceFrame,
  parseSurfaceFrameId,
  systemId,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import { placementBasis } from './surfacePlacement.ts'
import { World } from './world.ts'

/*
 * One compass, read four ways: the surface frame, a placement, a ship put
 * down at `Q.IDENTITY` in the surface frame (what `ir.land` does), and a ship
 * that lands by flight. They agree about which way a heading points, on Mars
 * and on a generated world, so the agreement is not a fact about one body.
 */

const POINTS = [
  {
    system: 'SOL',
    body: 3,
    latitude: 0.6031917532451286,
    longitude: 1.4844702100937137,
  },
  { system: 'HIP71683', body: -1, latitude: 0.3, longitude: 0.5 },
] as const

const operatingPoint = (point: (typeof POINTS)[number]) => {
  const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
  const system = world.loadSystem(systemId(point.system))
  const body: Body =
    point.body >= 0
      ? system.planets[point.body]!
      : [...walkBodies(system)].find(
          (candidate) => hasSolidSurface(candidate) && candidate.radius > 1e6,
        )!
  const frame = installSurfaceFrame(
    world.frames,
    body,
    point.latitude,
    point.longitude,
  )
  // The frame's own quantized angles, which is what every reader is handed.
  const { latitude, longitude } = parseSurfaceFrameId(frame)!
  return { world, body, frame, latitude, longitude }
}

/** An orientation in the body-fixed frame, from one in `frame`. */
const bodyFixedOrientation = (
  world: World,
  body: Body,
  frame: Parameters<World['frames']['pose']>[0],
  orientation: Quat,
): Quat => {
  const time = world.clock.time
  const spin = world.frames.pose(bodyFixedFrameId(body.address), time)
  const local = world.frames.pose(frame, time)
  return Q.multiply(
    Q.conjugate(spin.orientation),
    Q.multiply(local.orientation, orientation),
  )
}

const forward = (orientation: Quat): Vec3 =>
  Q.rotate(orientation, vec3(0, 0, -1))

const headingOf = (
  latitude: number,
  longitude: number,
  direction: Vec3,
): number => {
  const { east, north } = compassBasis(latitude, longitude, 0)
  return Math.atan2(Vec.dot(direction, east), Vec.dot(direction, north))
}

describe('the surface compass', () => {
  it("is the surface frame's axes: +X east, +Y up, −Z north", () => {
    for (const point of POINTS) {
      const { world, body, frame, latitude, longitude } = operatingPoint(point)
      const axes = bodyFixedOrientation(world, body, frame, Q.IDENTITY)
      const basis = compassBasis(latitude, longitude, 0)
      const right = Q.rotate(axes, vec3(1, 0, 0))
      expect(Vec.length(Vec.sub(right, basis.east)), body.name).toBeLessThan(
        1e-12,
      )
      expect(
        Vec.length(Vec.sub(forward(axes), basis.north)),
        body.name,
      ).toBeLessThan(1e-12)
    }
  })

  it('puts a ship at identity in the surface frame facing the way a pad at heading 0 does', () => {
    for (const point of POINTS) {
      const { world, body, frame, latitude, longitude } = operatingPoint(point)
      const pad = placementBasis({
        id: 'pad',
        assetId: 'mars-pad',
        bodyAddress: formatAddress(body.address),
        latitude,
        longitude,
        height: 0,
        heading: 0,
      })
      const ship = world.spawnShip(
        'lander',
        bodyFrameId(body.address),
        Vec.ZERO,
      )
      world.teleport(ship.id, {
        ...restState(frame),
        orientation: Q.IDENTITY,
      })
      const landed = world.entities.require(ship.id).state
      const facing = forward(
        bodyFixedOrientation(world, body, landed.frame, landed.orientation),
      )
      expect(
        Vec.length(Vec.sub(facing, forward(pad.orientation))),
        body.name,
      ).toBeLessThan(1e-12)
    }
  })

  it("keeps a flown landing's heading, read in the frame it lands in", () => {
    const heading = 1.1
    for (const point of POINTS) {
      const { world, body, frame, latitude, longitude } = operatingPoint(point)
      const turned = Q.fromAxisAngle(vec3(0, 1, 0), -heading)
      const probe = world.spawn({
        id: dynamicEntityId(99),
        kind: 'probe',
        name: 'lander',
        state: reframe(
          world.frames,
          {
            ...restState(frame),
            position: vec3(0, 12, 0),
            velocity: vec3(0, -6, 0),
            orientation: turned,
          },
          bodyFrameId(body.address),
          world.clock.time,
        ),
      })
      const headingNow = (): number => {
        const state = world.entities.require(probe.id).state
        return headingOf(
          latitude,
          longitude,
          forward(
            bodyFixedOrientation(world, body, state.frame, state.orientation),
          ),
        )
      }
      let before = headingNow()
      for (let tick = 0; tick < 512 && !world.isLanded(probe.id); tick++) {
        before = headingNow()
        world.runTicks(1)
      }
      expect(world.isLanded(probe.id), body.name).toBe(true)
      expect(world.entities.require(probe.id).state.frame, body.name).toBe(
        frame,
      )
      /*
       * Touchdown reframes the probe into the surface frame and keeps its
       * pose, so the heading across the landing tick moves by that tick's
       * own turn. The fall turns it at 2.4e-5 rad/s on Mars, measured, which
       * is 4e-7 a tick; the defect this guards is a half turn.
       */
      expect(Math.abs(headingNow() - before), body.name).toBeLessThan(1e-6)
      // And over the whole fall: the drift above, never the 180° flip.
      expect(Math.abs(headingNow() - heading), body.name).toBeLessThan(1e-3)
    }
  })
})
