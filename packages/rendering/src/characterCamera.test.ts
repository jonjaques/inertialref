import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type FramePose,
  Quaternion as Q,
  type Quat,
  type UniverseVector,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  type BodyFixedDirection,
  SOL_ONLY_CATALOG,
  systemId,
  bodyFixedFrameId,
  geodeticDirection,
  drawnSurfaceRadius,
  MARS_PAD,
  surfaceRadius,
} from '@inertialref/universe'
import {
  CHASE,
  type CharacterCameraInput,
  characterCameraPose,
  characterFeet,
} from './characterCamera.ts'
import { bodyGround, type Ground } from './ground.ts'
import { localTriad } from './surfaceStance.ts'

/*
 * The camera is geometry about a ground, so most of it is tested on grounds
 * built for the purpose: a sphere a thousand kilometers across, at rest at
 * the origin, with the walker standing at its north pole facing −Z. A wall
 * behind it is a ground that rises for every ray with `z` past a line.
 */
const R = 1_000_000
const SPIN: FramePose = {
  position: UV.UNIVERSE_ORIGIN,
  orientation: Q.IDENTITY,
  velocity: Vec.ZERO,
  angularVelocity: Vec.ZERO,
}

/** A ground `height(direction)` above `R`, drawn `tail` above its support. */
const synthetic = (
  height: (direction: BodyFixedDirection) => number,
  tail = 0,
): Ground => ({
  at: (direction) => {
    const support = R + height(direction)
    return { support, drawn: support + tail }
  },
})
const PLANE = synthetic(() => 0)

/** Standing at the pole, `lift` over the plane, displaced `east` meters along +X. */
const at = (lift = 0, east = 0): UniverseVector =>
  UV.translate(
    SPIN.position,
    Vec.scale(Vec.normalize(vec3(east, R, 0)), R + lift),
  )

const standing = (
  ground: Ground,
  overrides: Partial<CharacterCameraInput> = {},
): CharacterCameraInput => ({
  position: at(),
  orientation: Q.IDENTITY,
  spin: SPIN,
  ground,
  eyeHeight: 1.68,
  pitch: 0,
  view: 'first',
  grounded: true,
  verticalSpeed: 0,
  delta: 0,
  memory: null,
  ...overrides,
})

/** Eye height over the plane's support. */
const height = (pose: { position: UniverseVector }): number =>
  UV.distance(pose.position, SPIN.position) - R

describe('the character eye', () => {
  const world = new World({ seed: 'inertialref', catalog: SOL_ONLY_CATALOG })
  const mars = world.loadSystem(systemId('SOL')).planets[3]!
  world.placeStructure(MARS_PAD)
  const spin = world.frames.pose(bodyFixedFrameId(mars.address), 0)
  const surface = (latitude: number, longitude: number) => {
    const d = geodeticDirection(latitude, longitude)
    const triad = localTriad(d)
    return {
      direction: d,
      orientation: Q.multiply(
        spin.orientation,
        Q.fromBasis(triad.east, triad.up, Vec.scale(triad.north, -1)),
      ) as Quat,
      position: UV.translate(
        spin.position,
        Q.rotate(spin.orientation, Vec.scale(d, surfaceRadius(mars, d))),
      ),
    }
  }

  it('stands above the drawn ground at any latitude, including the poles', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (latitude, longitude) => {
          const { direction, orientation, position } = surface(
            latitude,
            longitude,
          )
          const result = characterCameraPose({
            position,
            orientation,
            spin,
            ground: bodyGround(mars, []),
            eyeHeight: 1.68,
            pitch: 0,
            view: 'first',
            grounded: true,
            verticalSpeed: 0,
            delta: 0,
            memory: null,
          })
          expect(
            UV.distance(result.position, spin.position) -
              drawnSurfaceRadius(mars, direction),
          ).toBeCloseTo(1.68, 3)
          expect(UV.distance(result.position, result.feet)).toBeCloseTo(1.68, 3)
          expect(
            Vec.dot(
              Q.rotate(result.orientation, vec3(0, 0, -1)),
              Q.rotate(spin.orientation, direction),
            ),
          ).toBeCloseTo(0, 8)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('stands the camera, the feet and the world on one support over the pad', () => {
    // The pad's deck, its apron and the ground past its skirt: wherever a
    // ray falls, the port and the contact test answer the same radius.
    const ground = bodyGround(mars, world.structures)
    const anchor = geodeticDirection(MARS_PAD.latitude, MARS_PAD.longitude)
    // On the deck the relief wins, two meters over the terrain it stands on.
    expect(ground.at(anchor).support).toBeGreaterThan(
      surfaceRadius(mars, anchor) + 1.9,
    )
    for (const meters of [0, 10, 30, 42, 60, 90]) {
      const offset = meters / mars.radius
      const direction = geodeticDirection(
        MARS_PAD.latitude + offset,
        MARS_PAD.longitude,
      )
      expect(ground.at(direction).support).toBe(
        world.contactRadius(mars, direction),
      )
    }
    // A walker on the deck wears the drawn ground, and nothing more.
    const deck = UV.translate(
      spin.position,
      Q.rotate(
        spin.orientation,
        Vec.scale(anchor, world.contactRadius(mars, anchor)),
      ),
    )
    const feet = characterFeet({ position: deck, spin, ground })
    const drawn = ground.at(anchor)
    // To the rounding of a universe position at Mars's radius carried through
    // the relief's datum plane: 33 µm measured, where a millimeter would show.
    expect(
      Math.abs(UV.distance(feet, spin.position) - drawn.drawn),
    ).toBeLessThan(1e-4)
  })
})

describe('the character camera on a ground built for it', () => {
  it('wears the drawn ground standing and lets go of it airborne', () => {
    const tailed = synthetic(() => 0, 0.8)
    const feet = (lift: number) =>
      UV.distance(
        characterFeet({ position: at(lift), spin: SPIN, ground: tailed }),
        SPIN.position,
      ) - R
    expect(feet(0)).toBeCloseTo(0.8, 9)
    expect(feet(2)).toBeCloseTo(2.8, 9)
    // Halfway up the fade, half the tail.
    expect(feet(3.5)).toBeCloseTo(3.5 + 0.4, 9)
    expect(feet(5)).toBeCloseTo(5, 9)
  })

  it('eases the crouch and the stand instead of cutting the eye height', () => {
    let pose = characterCameraPose(standing(PLANE))
    expect(height(pose)).toBeCloseTo(1.68, 3)
    pose = characterCameraPose(
      standing(PLANE, { eyeHeight: 1.15, delta: 1 / 60, memory: pose.memory }),
    )
    const first = height(pose)
    expect(first).toBeLessThan(1.68)
    expect(first).toBeGreaterThan(1.15 + 0.53 * 0.7)
    for (let i = 0; i < 60; i += 1)
      pose = characterCameraPose(
        standing(PLANE, {
          eyeHeight: 1.15,
          delta: 1 / 60,
          memory: pose.memory,
        }),
      )
    expect(height(pose)).toBeCloseTo(1.15, 3)
  })

  it('absorbs a step up over a few frames and a landing in the knees', () => {
    // A 0.3 m step east of the pole: the walker crosses it between two
    // grounded frames, and its feet rise with the ground in one tick.
    const STEP = synthetic((direction) => (direction.x > 0 ? 0.3 : 0))
    const before = at(0, -0.5)
    const after = at(0.3, 0.5)
    let pose = characterCameraPose(standing(STEP, { position: before }))
    const over = (pose: { position: UniverseVector }) =>
      Vec.dot(
        UV.difference(pose.position, before),
        Vec.normalize(UV.difference(before, SPIN.position)),
      )
    // The picture holds and catches up, most of the way within a quarter
    // second.
    pose = characterCameraPose(
      standing(STEP, { position: after, delta: 1 / 60, memory: pose.memory }),
    )
    expect(over(pose) - 1.68).toBeLessThan(0.08)
    for (let i = 0; i < 15; i += 1)
      pose = characterCameraPose(
        standing(STEP, { position: after, delta: 1 / 60, memory: pose.memory }),
      )
    expect(over(pose) - 1.68).toBeGreaterThan(0.25)
    // A landing at 6 m/s dips the eye and recovers.
    const landed = characterCameraPose(
      standing(STEP, {
        position: after,
        delta: 1 / 60,
        verticalSpeed: -6,
        memory: { ...pose.memory, grounded: false, lift: 0 },
      }),
    )
    expect(over(landed) - 1.68 - 0.3).toBeLessThan(-0.1)
    expect(over(landed) - 1.68 - 0.3).toBeGreaterThan(-0.17)
  })

  it('snaps the chase boom in against a ridge and eases it back out', () => {
    // A wall three meters tall, 2.6 m behind the shoulder, across every ray
    // past that line: the 3.6 m boom cannot reach past it. Off the march's
    // quarter-meter grid, so the bisection has something to close on.
    const WALL = 2.6
    const RIDGE = synthetic((direction) => (direction.z * R > WALL ? 3 : 0))
    const chase = { view: 'third' as const }
    let pose = characterCameraPose(standing(PLANE, chase))
    const full = pose.memory.boom
    expect(full).toBeCloseTo(CHASE.boom, 6)

    pose = characterCameraPose(
      standing(RIDGE, { ...chase, delta: 1 / 60, memory: pose.memory }),
    )
    const short = pose.memory.boom
    // In at once, and within the bisection's last interval of the wall —
    // a quarter meter over five halvings, 7.8 mm — rather than a whole step.
    expect(short).toBeLessThan(WALL)
    expect(short).toBeGreaterThan(WALL - 0.25 / 2 ** 5)

    // The ridge gone: the boom takes its time coming back.
    pose = characterCameraPose(
      standing(PLANE, { ...chase, delta: 1 / 60, memory: pose.memory }),
    )
    expect(pose.memory.boom).toBeGreaterThan(short)
    expect(pose.memory.boom).toBeLessThan(full - 0.5)
    for (let i = 0; i < 120; i += 1)
      pose = characterCameraPose(
        standing(PLANE, { ...chase, delta: 1 / 60, memory: pose.memory }),
      )
    expect(pose.memory.boom).toBeCloseTo(full, 2)
  })

  it('shortens the boom when looking down would put it underground', () => {
    const pose = characterCameraPose(
      standing(PLANE, { view: 'third', eyeHeight: 1.04, pitch: 1.4 }),
    )
    expect(UV.distance(pose.position, pose.feet)).toBeLessThan(2.2)
    expect(height(pose)).toBeGreaterThan(CHASE.clearance - 0.01)
  })
})
