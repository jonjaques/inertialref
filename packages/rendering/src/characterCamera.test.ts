import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  Quaternion as Q,
  type UniverseVector,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  SOL_ONLY_CATALOG,
  systemId,
  bodyFixedFrameId,
  geodeticDirection,
  drawnSurfaceRadius,
  MARS_PAD,
  surfaceRadius,
} from '@inertialref/universe'
import { CHASE, characterCameraPose } from './characterCamera.ts'
import { localTriad } from './surfaceStance.ts'

const world = new World({ seed: 'inertialref', catalog: SOL_ONLY_CATALOG })
const body = world.loadSystem(systemId('SOL')).planets[3]!
const spin = world.frames.pose(bodyFixedFrameId(body.address), 0)

describe('the character eye', () => {
  it('stands above the drawn ground at any latitude, including the poles', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (latitude, longitude) => {
          const d = geodeticDirection(latitude, longitude)
          const triad = localTriad(d)
          const orientation = Q.multiply(
            spin.orientation,
            Q.fromBasis(triad.east, triad.up, Vec.scale(triad.north, -1)),
          )
          const position = UV.translate(
            spin.position,
            Q.rotate(spin.orientation, Vec.scale(d, surfaceRadius(body, d))),
          )
          const result = characterCameraPose({
            position,
            orientation,
            body,
            spin,
            structures: [],
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
              drawnSurfaceRadius(body, d),
          ).toBeCloseTo(1.68, 3)
          expect(UV.distance(result.position, result.feet)).toBeCloseTo(1.68, 3)
          expect(
            Vec.dot(
              Q.rotate(result.orientation, vec3(0, 0, -1)),
              Q.rotate(spin.orientation, d),
            ),
          ).toBeCloseTo(0, 8)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('shortens the third-person boom when looking down would put it underground', () => {
    const d = geodeticDirection(0, 0)
    const triad = localTriad(d)
    const orientation = Q.multiply(
      spin.orientation,
      Q.fromBasis(triad.east, triad.up, Vec.scale(triad.north, -1)),
    )
    const position = UV.translate(
      spin.position,
      Q.rotate(spin.orientation, Vec.scale(d, surfaceRadius(body, d))),
    )
    const input = {
      position,
      orientation,
      body,
      spin,
      structures: [],
      eyeHeight: 1.04,
      pitch: 1.4,
      view: 'third' as const,
      grounded: true,
      verticalSpeed: 0,
      delta: 0,
      memory: null,
    }
    const result = characterCameraPose(input)
    expect(UV.distance(result.position, result.feet)).toBeLessThan(2.2)
    expect(
      UV.distance(result.position, spin.position) - drawnSurfaceRadius(body, d),
    ).toBeGreaterThan(0.15)
  })
})

describe('the character camera between frames', () => {
  const d = geodeticDirection(0.3, 0.2)
  const triad = localTriad(d)
  const orientation = Q.multiply(
    spin.orientation,
    Q.fromBasis(triad.east, triad.up, Vec.scale(triad.north, -1)),
  )
  const standing = (lift = 0) =>
    UV.translate(
      spin.position,
      Q.rotate(spin.orientation, Vec.scale(d, surfaceRadius(body, d) + lift)),
    )
  const base = {
    orientation,
    body,
    spin,
    structures: [],
    pitch: 0,
    grounded: true,
    verticalSpeed: 0,
  }
  const height = (pose: { position: UniverseVector }) =>
    UV.distance(pose.position, spin.position) - drawnSurfaceRadius(body, d)

  it('eases the crouch and the stand instead of cutting the eye height', () => {
    let pose = characterCameraPose({
      ...base,
      position: standing(),
      eyeHeight: 1.68,
      view: 'first',
      delta: 0,
      memory: null,
    })
    expect(height(pose)).toBeCloseTo(1.68, 3)
    pose = characterCameraPose({
      ...base,
      position: standing(),
      eyeHeight: 1.15,
      view: 'first',
      delta: 1 / 60,
      memory: pose.memory,
    })
    const first = height(pose)
    expect(first).toBeLessThan(1.68)
    expect(first).toBeGreaterThan(1.15 + 0.53 * 0.7)
    for (let i = 0; i < 60; i += 1)
      pose = characterCameraPose({
        ...base,
        position: standing(),
        eyeHeight: 1.15,
        view: 'first',
        delta: 1 / 60,
        memory: pose.memory,
      })
    expect(height(pose)).toBeCloseTo(1.15, 3)
  })

  it('absorbs a step up over a few frames and a landing in the knees', () => {
    let pose = characterCameraPose({
      ...base,
      position: standing(),
      eyeHeight: 1.68,
      view: 'first',
      delta: 0,
      memory: null,
    })
    // The feet teleport 0.3 m up between two grounded frames: the picture
    // holds and catches up, most of the way within a quarter second.
    pose = characterCameraPose({
      ...base,
      position: standing(0.3),
      eyeHeight: 1.68,
      view: 'first',
      delta: 1 / 60,
      memory: pose.memory,
    })
    expect(height(pose) - 1.68).toBeLessThan(0.08)
    for (let i = 0; i < 15; i += 1)
      pose = characterCameraPose({
        ...base,
        position: standing(0.3),
        eyeHeight: 1.68,
        view: 'first',
        delta: 1 / 60,
        memory: pose.memory,
      })
    expect(height(pose) - 1.68).toBeGreaterThan(0.25)
    // A landing at 6 m/s dips the eye and recovers.
    const landed = characterCameraPose({
      ...base,
      position: standing(0.3),
      eyeHeight: 1.68,
      view: 'first',
      delta: 1 / 60,
      grounded: true,
      verticalSpeed: -6,
      memory: { ...pose.memory, grounded: false, lift: 0 },
    })
    expect(height(landed) - 1.68 - 0.3).toBeLessThan(-0.1)
    expect(height(landed) - 1.68 - 0.3).toBeGreaterThan(-0.17)
  })

  it('snaps the chase boom in against a ridge and eases it back out', () => {
    // On the pad's deck, where the ground behind the suit is level: a level
    // boom on open terrain is whatever the slope behind allows.
    const deck = geodeticDirection(MARS_PAD.latitude, MARS_PAD.longitude)
    const deckTriad = localTriad(deck)
    const onDeck = {
      ...base,
      structures: [MARS_PAD],
      orientation: Q.multiply(
        spin.orientation,
        Q.fromBasis(
          deckTriad.east,
          deckTriad.up,
          Vec.scale(deckTriad.north, -1),
        ),
      ),
      position: UV.translate(
        spin.position,
        Q.rotate(
          spin.orientation,
          Vec.scale(deck, surfaceRadius(body, deck) + MARS_PAD.height),
        ),
      ),
    }
    let pose = characterCameraPose({
      ...onDeck,
      eyeHeight: 1.68,
      view: 'third',
      delta: 0,
      memory: null,
    })
    const full = pose.memory.boom
    expect(full).toBeCloseTo(CHASE.boom, 6)
    // Looking straight down would put the boom in the ground: it shortens now.
    pose = characterCameraPose({
      ...onDeck,
      eyeHeight: 1.68,
      view: 'third',
      pitch: 1.4,
      delta: 1 / 60,
      memory: pose.memory,
    })
    const short = pose.memory.boom
    expect(short).toBeLessThan(full - 1)
    // Level again: the boom takes its time coming back.
    pose = characterCameraPose({
      ...onDeck,
      eyeHeight: 1.68,
      view: 'third',
      delta: 1 / 60,
      memory: pose.memory,
    })
    expect(pose.memory.boom).toBeGreaterThan(short)
    expect(pose.memory.boom).toBeLessThan(full - 0.5)
    for (let i = 0; i < 120; i += 1)
      pose = characterCameraPose({
        ...onDeck,
        eyeHeight: 1.68,
        view: 'third',
        delta: 1 / 60,
        memory: pose.memory,
      })
    expect(pose.memory.boom).toBeCloseTo(full, 2)
  })
})
