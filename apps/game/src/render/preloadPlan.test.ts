import { describe, expect, it } from 'vitest'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { MemorySaveStore } from '@inertialref/persistence'
import { GameEngine } from '../engine/GameEngine.ts'
import { scatteringBakes, scatteringKey } from './preloadPlan.ts'

/*
 * The one claim the preload plan makes: every atmosphere the scene can ask
 * `scatteringFor` to bake at draw time is already in the plan, under the same
 * cache key. The plan recomputes `buildScene`'s sunk sphere radius rather than
 * importing it, so this test is what holds the two formulas together — a
 * one-rounding-step drift turns the whole prebake into a set of cache misses,
 * which costs the boot time *and* keeps the first-sight stutter it exists to
 * remove.
 */

function engine(): GameEngine {
  const registry = createTaskRegistry()
  let clock = 0
  return new GameEngine({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    store: new MemorySaveStore(),
    now: () => (clock += 16),
  })
}

describe('the scattering prebake plan', () => {
  it('covers every atmosphere the built scene asks for, by exact key', () => {
    const game = engine()
    game.frame(1 / 60)
    const scene = game.scene()
    expect(scene).not.toBeNull()

    const planned = new Set(
      scatteringBakes(game.world.loadedSystems()).map((bake) =>
        scatteringKey(bake.haze, bake.topRatio),
      ),
    )

    // Sol alone carries at least Venus, Earth, Mars and the four giants.
    expect(planned.size).toBeGreaterThanOrEqual(7)

    let asked = 0
    for (const body of scene!.bodies) {
      const haze = body.appearance.haze
      if (haze === null) continue
      asked += 1
      expect(planned.has(scatteringKey(haze, body.atmosphereScale))).toBe(true)
    }
    // If the scene carried no atmospheres at all, the loop proved nothing.
    expect(asked).toBeGreaterThan(0)
    game.dispose()
  })

  it('dedupes bakes that share a key', () => {
    const game = engine()
    const bakes = scatteringBakes(game.world.loadedSystems())
    const keys = bakes.map((bake) => scatteringKey(bake.haze, bake.topRatio))
    expect(new Set(keys).size).toBe(keys.length)
    game.dispose()
  })
})
