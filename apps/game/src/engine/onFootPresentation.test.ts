import { describe, expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import { MemorySaveStore } from '@inertialref/persistence'
import {
  type CharacterSnapshot,
  createCharacter,
  snapshot,
} from '@inertialref/simulation'
import { UV, vec3 } from '@inertialref/spatial'
import { TEST_CATALOG } from '@inertialref/universe'
import { GameEngine } from './GameEngine.ts'
import { gaitFor, presentOnFoot } from './onFootPresentation.ts'

describe('the gait a suit plays', () => {
  const suit = (
    character: Partial<CharacterSnapshot>,
    climbing = 0,
  ): Parameters<typeof gaitFor>[0] => ({
    character: {
      ...createCharacter(),
      grounded: true,
      speed: 0,
      ...character,
    } as CharacterSnapshot,
    localPosition: vec3(0, 1, 0),
    localVelocity: vec3(0, climbing, 0),
  })

  it.each([
    ['standing still', suit({}), 'idle'],
    ['walking', suit({ speed: 2.8 }), 'walk'],
    [
      'sprinting',
      suit({
        speed: 5.6,
        input: { ...createCharacter().input, sprint: true },
      }),
      'run',
    ],
    ['crouched', suit({ crouched: true }), 'crouch'],
    ['crouched and moving', suit({ crouched: true, speed: 1.5 }), 'crouchWalk'],
    ['leaving the ground', suit({ grounded: false }, 4), 'jump'],
    ['coming down', suit({ grounded: false }, -4), 'fall'],
    ['flying, whatever else', suit({ flying: true, speed: 9 }), 'fly'],
    // Sprint held at a standstill is still standing.
    [
      'sprint held, not moving',
      suit({ input: { ...createCharacter().input, sprint: true } }),
      'idle',
    ],
  ] as const)('%s', (_, entity, animation) => {
    expect(gaitFor(entity)).toBe(animation)
  })
})

describe("the walker camera's memory", () => {
  /** A walker standing beside the pad, crouching from the second frame. */
  function crouching() {
    const session = openSession({ seed: 'inertialref', catalog: TEST_CATALOG })
    const walker = session.harness.onFoot.atMarsPad()
    session.world.runTicks(64)
    const standing = snapshot(session.world)
    session.world.setCharacterInput(walker.id, { crouch: true })
    session.world.runTicks(8)
    return {
      session,
      player: walker.id,
      standing,
      crouched: snapshot(session.world),
    }
  }
  /**
   * To a millimeter: a distance between two universe positions at Mars's
   * radius carries their rounding, 25 µm measured.
   */
  const eyeOverFeet = (pose: {
    position: Parameters<typeof UV.distance>[0]
    feet: Parameters<typeof UV.distance>[0]
  }): number => UV.distance(pose.position, pose.feet)

  it('eases across a frame, and starts over across a cut', () => {
    const { session, player, standing, crouched } = crouching()
    const first = presentOnFoot({
      shot: standing,
      player,
      view: 'first',
      pitch: 0,
      delta: 0,
      epoch: 0,
      memory: null,
    })
    expect(eyeOverFeet(first.pose!)).toBeCloseTo(1.68, 3)
    const eased = presentOnFoot({
      shot: crouched,
      player,
      view: 'first',
      pitch: 0,
      delta: 1 / 60,
      epoch: 0,
      memory: first.memory,
    })
    expect(eyeOverFeet(eased.pose!)).toBeGreaterThan(1.5)
    // The same frame after a cut: the eye is where the crouch puts it.
    const cut = presentOnFoot({
      shot: crouched,
      player,
      view: 'first',
      pitch: 0,
      delta: 1 / 60,
      epoch: 1,
      memory: first.memory,
    })
    expect(eyeOverFeet(cut.pose!)).toBeCloseTo(1.15, 3)
    session.dispose()
  })

  it('keeps easing across the cut a view switch makes, and only that one', () => {
    const { session, player, standing } = crouching()
    const level = {
      shot: standing,
      player,
      pitch: 0,
      delta: 1 / 60,
    }
    const before = presentOnFoot({
      ...level,
      view: 'first',
      epoch: 4,
      memory: null,
    })
    const switched = presentOnFoot({
      ...level,
      view: 'third',
      epoch: 5,
      memory: before.memory,
    })
    // Out from the head over frames, not at full length at once.
    expect(switched.memory!.memory.boom).toBeLessThan(1)
    const withAnotherCut = presentOnFoot({
      ...level,
      view: 'third',
      epoch: 6,
      memory: before.memory,
    })
    expect(withAnotherCut.memory!.memory.boom).toBeGreaterThan(3)
    session.dispose()
  })

  it('drops it on a cut the harness makes, as on any other', () => {
    const game = new GameEngine({
      workers: null,
      store: new MemorySaveStore(),
      heightfieldStore: null,
      now: () => 0,
    })
    game.character.atMarsPad()
    game.character.toggleView()
    game.frame(1 / 60)
    // The eye over the drawn feet, both in render space.
    const height = (): number => {
      const eye = game.characterCamera!.camera.position
      const feet = game.characterView!.position
      return Math.hypot(eye.x - feet.x, eye.y - feet.y, eye.z - feet.z)
    }
    game.world.setCharacterInput(game.player()!, { crouch: true })
    game.world.runTicks(8)
    game.frame(1 / 60)
    expect(height()).toBeGreaterThan(1.5)
    // `ir.view` is the flight camera's, and still a cut of the picture.
    game.harness.view('orbit')
    game.frame(1 / 60)
    expect(height()).toBeCloseTo(1.15, 3)
    game.dispose()
  })
})
