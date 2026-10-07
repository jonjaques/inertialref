import { describe, expect, it } from 'vitest'
import { DEBUG_LANDING_SITE } from '@inertialref/devtools'
import { MemorySaveStore } from '@inertialref/persistence'
import { deg } from '@inertialref/shared'
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
    const ship = game.session.player()
    game.character.atMarsPad()
    game.frame(1 / 60)
    const id = game.session.player()!
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
    expect(game.session.player()).toBe(ship)
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
    expect(game.session.player()).toBe(ship)
    game.dispose()
  })
  it('replaces the world without writing it, so a console load replays held keys', () => {
    // The derived-state hook drops presentation and nothing else. The game's
    // own load lets go of the keys (above); `ir.load` is a replay, and a
    // replay that rewrote the walker's intent would not be one.
    const game = makeEngine()
    game.character.atMarsPad()
    const id = game.session.player()!
    game.character.lockChanged(true)
    game.character.input({ forward: 1 })
    expect(game.harness.load(game.harness.save()).ok).toBe(true)
    expect(game.world.entities.require(id).character!.input.forward).toBe(1)
    expect(game.character.locked).toBe(false)
    game.dispose()
  })

  it('drops the flight keys on foot rather than flying the walker or boarding', () => {
    const game = makeEngine()
    game.character.atMarsPad()
    const walker = game.session.player()
    const before = game.world.stateHash()
    expect(game.setThrottle(1)).toBe(0)
    expect(game.nudgeThrottle(0.05)).toBe(0)
    expect(game.toggleFlightAssist()).toBe(false)
    game.killRotation()
    game.setControl([0, 0, 1], [0, 1, 0])
    expect(game.world.stateHash()).toBe(before)
    expect(game.session.player()).toBe(walker)
    game.dispose()
  })

  it('lets go of the pointer when a console verb boards the ship', () => {
    const game = makeEngine()
    game.character.atMarsPad()
    const ship = game.character.ship
    game.character.lockChanged(true)
    expect(game.character.locked).toBe(true)
    game.harness.onFoot.board()
    expect(game.session.player()).toBe(ship)
    expect(game.character.active).toBe(false)
    expect(game.character.locked).toBe(false)
    expect(game.character.padPreview).toBe(false)
    // The next walker out is not locked until the browser grants it again —
    // without a pointer lock to release, nothing else clears the old grant.
    expect(game.character.enter()).toBe(true)
    expect(game.character.locked).toBe(false)
    game.character.lockChanged(true)
    expect(game.character.locked).toBe(true)
    game.dispose()
  })

  it('aims the look at a walker the console stepped out, not the last one', () => {
    const game = makeEngine()
    game.character.atMarsPad()
    game.character.lockChanged(true)
    game.character.look(400, 0)
    game.character.leave()
    const walker = game.harness.onFoot.atMarsPad()
    const heading = walker.character!.input.yaw
    game.character.lockChanged(true)
    expect(game.character.padPreview).toBe(true)
    expect(game.character.pitch).toBe(0)
    game.character.look(1, 0)
    const yaw = game.world.entities.require(walker.id).character!.input.yaw
    const pixel = Math.abs(yaw - heading)
    // One pixel's angle, where the last walker's running yaw is 400 of them.
    expect(pixel).toBeGreaterThan(0)
    expect(pixel).toBeLessThan(0.01)
    game.dispose()
  })

  it('stops a scene before the console stages the pad, so its end restores nothing', () => {
    const game = makeEngine()
    game.harness.play('tng-intro')
    const walker = game.harness.onFoot.atMarsPad()
    expect(game.harness.cutscene.status()).toBeNull()
    game.frame(1 / 60)
    expect(game.session.player()).toBe(walker.id)
    expect(game.scene()?.camera.position).toEqual(
      game.characterCamera?.camera.position,
    )
    game.dispose()
  })

  it('steps nobody out while a scene plays, from the console or the dock', () => {
    const game = makeEngine()
    game.harness.land('g:milky-way/s:SOL/b:3', deg(20), deg(-63))
    game.frame(1 / 60)
    expect(game.harness.onFoot.available()).toBe(true)
    game.harness.play('tng-intro')
    const ship = game.session.player()
    expect(game.harness.onFoot.available()).toBe(false)
    expect(game.harness.onFoot.stepOut().ok).toBe(false)
    expect(game.character.enter()).toBe(false)
    expect(game.session.player()).toBe(ship)
    game.dispose()
  })

  it('abandons a scene whose captured walker boarded, rather than throwing', () => {
    const game = makeEngine()
    game.character.atMarsPad()
    game.harness.play('tng-intro')
    game.harness.onFoot.board()
    expect(() => game.harness.stopCutscene()).not.toThrow()
    expect(game.harness.cutscene.lastOutcome()?.ending).toBe('abandoned')
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
    game.harness.land(
      'g:milky-way/s:SOL/b:3',
      DEBUG_LANDING_SITE.latitude,
      DEBUG_LANDING_SITE.longitude,
    )
    game.world.runTicks(1)
    expect(game.character.available()).toBe(true)
    expect(game.character.enter()).toBe(true)
    expect(game.world.entities.require(game.session.player()!).kind).toBe(
      'character',
    )
    game.dispose()
  })

  it('clears held movement on unlock and applies host flight permission', () => {
    const game = makeEngine(false)
    game.harness.land(
      'g:milky-way/s:SOL/b:3',
      DEBUG_LANDING_SITE.latitude,
      DEBUG_LANDING_SITE.longitude,
    )
    game.world.runTicks(1)
    game.character.enter()
    game.character.lockChanged(true)
    game.character.input({ forward: 1, sprint: true, jump: true })
    expect(game.character.toggleFlight()).toBe(false)
    game.character.lockChanged(false)
    const input = game.world.entities.require(game.session.player()!).character!
      .input
    expect(input.forward).toBe(0)
    expect(input.jump).toBe(false)
    expect(input.sprint).toBe(false)
    game.dispose()
  })
})
