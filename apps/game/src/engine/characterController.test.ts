import { describe, expect, it } from 'vitest'
import { MemorySaveStore } from '@inertialref/persistence'
import { GameEngine } from './GameEngine.ts'
import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'

const makeEngine = (canFly = true) =>
  new GameEngine({
    workers: null,
    store: new MemorySaveStore(),
    heightfieldStore: null,
    canFly,
    now: () => 0,
  })

describe('character activation', () => {
  it('keeps the crouching chase camera above the pad at its support edge', () => {
    const game = makeEngine()
    game.character.atMarsPad()
    game.character.lockChanged(true)
    game.character.input({ crouch: true })
    game.frame(1 / 30)
    const view = game.characterView!
    const camera = game.characterCamera!.camera
    expect(
      Vec.dot(
        Vec.sub(camera.position, view.position),
        Q.rotate(view.orientation, vec3(0, 1, 0)),
      ),
    ).toBeGreaterThanOrEqual(0.19)
    game.dispose()
  })

  it('stages a character beside the landed Rocinante and shares one camera eye', () => {
    const game = makeEngine()
    const ship = game.player()
    expect(game.character.atMarsPad()).toBe(true)
    game.frame(1 / 60)
    const id = game.player()!
    expect(game.world.isLanded(ship!)).toBe(true)
    expect(game.character.status().grounded).toBe(true)
    expect(game.parkedRocinante).not.toBeNull()
    expect(game.characterView?.visible).toBe(true)
    expect(game.scene()?.camera.position).toEqual(
      game.characterCamera?.camera.position,
    )
    const avatar = game.snapshot!.entities.find((entity) => entity.id === id)!
    const vessel = game.snapshot!.entities.find((entity) => entity.id === ship)!
    // The ship's surface frame rounds angles to 1e-6 rad; the avatar does not.
    expect(
      Math.abs(UV.distance(avatar.position, vessel.position) - 22),
    ).toBeLessThan(avatar.character!.body.radius * 1e-6)
    game.character.toggleView()
    game.frame(1 / 60)
    expect(game.characterView?.visible).toBe(false)
    game.character.leave()
    expect(game.player()).toBe(ship)
    expect(game.world.entities.has(id)).toBe(false)
    game.dispose()
  })

  it('reloads a character with controls released and a working return to ship', async () => {
    const game = makeEngine()
    game.character.atMarsPad()
    const ship = game.character.ship
    game.character.lockChanged(true)
    game.character.input({ forward: 1 })
    await game.save('on-foot')
    await game.load('on-foot')
    expect(game.character.active).toBe(true)
    expect(game.character.locked).toBe(false)
    expect(game.character.entity!.character!.input.forward).toBe(0)
    game.character.leave()
    expect(game.player()).toBe(ship)
    game.dispose()
  })
  it('keeps the planetarium passive and steps out beside a landed ship', () => {
    const game = makeEngine()
    const before = game.world.stateHash()
    expect(game.character.available()).toBe(false)
    expect(game.character.enter()).toBe(false)
    expect(game.world.stateHash()).toBe(before)
    // A stance over the ground is a picture, not a place to stand: nothing
    // in the planetarium can spawn a walker, however low the eye.
    game.harness.visit('g:milky-way/s:SOL/b:3', { height: 2 })
    expect(game.world.stateHash()).toBe(before)
    expect(game.character.available()).toBe(false)
    expect(game.character.enter()).toBe(false)
    expect(game.world.stateHash()).toBe(before)
    game.harness.observatory.clear()
    game.harness.land('g:milky-way/s:SOL/b:3', 0.35, -1.1)
    game.world.runTicks(1)
    expect(game.character.available()).toBe(true)
    expect(game.character.enter()).toBe(true)
    expect(game.world.entities.require(game.player()!).kind).toBe('character')
    game.dispose()
  })

  it('clears held movement on unlock and applies host flight permission', () => {
    const game = makeEngine(false)
    game.harness.land('g:milky-way/s:SOL/b:3', 0.35, -1.1)
    game.world.runTicks(1)
    game.character.enter()
    game.character.lockChanged(true)
    game.character.input({ forward: 1, sprint: true, jump: true })
    expect(game.character.toggleFlight()).toBe(false)
    game.character.lockChanged(false)
    const input = game.world.entities.require(game.player()!).character!.input
    expect(input.forward).toBe(0)
    expect(input.jump).toBe(false)
    expect(input.sprint).toBe(false)
    game.dispose()
  })
})
