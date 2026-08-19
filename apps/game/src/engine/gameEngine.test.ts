import { describe, expect, it } from 'vitest'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { MemorySaveStore } from '@inertialref/persistence'
import { GameEngine } from './GameEngine.ts'

/*
 * The client, under Node.
 *
 * This file could not exist before: `GameEngine`'s constructor built an
 * `IndexedDbSaveStore` and a browser `WorkerPool` directly, so the whole engine
 * — frame loop, origin rebasing, terrain reconciliation, save and load — was
 * unreachable outside a browser, and `apps/` had no tests at all.
 *
 * Every seam it needs already existed and already had a second adapter. The
 * engine simply reached past all three to the concrete one.
 */

function engine(): GameEngine {
  const registry = createTaskRegistry()
  let clock = 0
  return new GameEngine({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    store: new MemorySaveStore(),
    // A fake clock, so frame timings are exact rather than whatever the machine
    // happened to be doing.
    now: () => (clock += 16),
  })
}

describe('the game engine, headless', () => {
  it('advances the world by whole ticks and builds a scene', () => {
    const game = engine()
    expect(game.scene()).toBeNull()

    // 0.25 s at 64 Hz is 16 ticks, but DEFAULT_MAX_STEPS caps a single call at
    // 8 — the clock's own spiral guard, which is the only one there should be.
    const ticks = game.world.advance(0.25)
    expect(ticks).toBe(8)

    game.frame(1 / 60)
    expect(game.scene()).not.toBeNull()
    expect(game.origin).not.toBeNull()
    expect(game.frameStats().ticksLastFrame).toBeGreaterThan(0)
    game.dispose()
  })

  it('round-trips a save through the injected store', async () => {
    const game = engine()
    game.frame(1 / 60)
    game.world.runTicks(600)
    const before = game.world.stateHash()

    await game.save('slot-a')
    expect(await game.saves.list()).toEqual(['slot-a'])

    game.world.runTicks(600)
    expect(game.world.stateHash()).not.toBe(before)

    expect(await game.load('slot-a')).toBe(true)
    expect(game.world.stateHash()).toBe(before)
    game.dispose()
  })

  it('drops every piece of derived state when the world is replaced', async () => {
    const game = engine()
    game.frame(1 / 60)
    await game.save('slot-b')

    expect(game.origin).not.toBeNull()
    expect(game.scene()).not.toBeNull()

    await game.load('slot-b')

    // One hook invalidates all of it. This used to be spread over `replaceWorld`
    // and `load`, and the starfield was in neither — so loading a save taken in
    // another system kept the previous system's stars, because the re-survey is
    // gated on having moved and the cache thought it hadn't.
    expect(game.origin).toBeNull()
    expect(game.scene()).toBeNull()
    expect(game.snapshot).toBeNull()
    expect(game.starField.positions).toHaveLength(0)
    expect(game.terrainState().patches).toHaveLength(0)
    game.dispose()
  })

  it('reads the world through the session rather than a captured reference', async () => {
    const game = engine()
    game.frame(1 / 60)
    const discarded = game.world
    await game.save('slot-c')
    await game.load('slot-c')

    // A host that captured `world` at construction kept reporting on the world
    // that was thrown away while the frame loop ran the new one.
    expect(game.world).not.toBe(discarded)
    expect(game.harness.world).toBe(game.world)
    game.dispose()
  })
})
