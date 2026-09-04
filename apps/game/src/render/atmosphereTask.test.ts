import { describe, expect, it } from 'vitest'
import {
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
} from '@inertialref/rendering'
import {
  createInlineWorker,
  createTaskRegistry,
  runInline,
  WorkerPool,
} from '@inertialref/workers'
import { bakeAtmosphereTask } from './atmosphereTask.ts'
import { createGameTaskRegistry } from '../workers/registry.ts'

/*
 * The bake on the pool is the bake on the main thread.
 *
 * The consumer trusts a worker's tables exactly as it trusts its own, so the
 * two have to be the same arrays — and the wire is the part that can differ:
 * a `Float32Array` that survives structured cloning is not the same claim as
 * one that survives a transfer list, and a registry that lacks the task fails
 * at dispatch, not at import.
 */

// Earth's authored haze, and the shell ratio `buildScene` gives it.
const haze = {
  colour: { r: 0.3, g: 0.55, b: 1 },
  limb: { r: 1, g: 0.6, b: 0.3 },
  thickness: 1,
}
const topRatio = 1.0157

describe('render.bakeAtmosphere', () => {
  it('bakes what the main thread bakes', async () => {
    const recipe = atmosphereRecipe(haze, topRatio)
    const transmittance = bakeTransmittance(recipe)
    const multiScatter = bakeMultipleScattering(recipe, transmittance)

    const response = await runInline(bakeAtmosphereTask, { haze, topRatio })
    expect(response.recipe).toEqual(recipe)
    expect(response.transmittance).toEqual(transmittance)
    expect(response.multiScatter).toEqual(multiScatter)
  })

  it('crosses the worker boundary intact, through the game registry', async () => {
    const pool = new WorkerPool({
      factory: () => createInlineWorker(createGameTaskRegistry()),
      size: 1,
    })
    try {
      const expected = await runInline(bakeAtmosphereTask, { haze, topRatio })
      const crossed = await pool.submit(bakeAtmosphereTask, { haze, topRatio })
        .result
      expect(crossed.transmittance.width).toBe(expected.transmittance.width)
      expect(crossed.transmittance.height).toBe(expected.transmittance.height)
      expect([...crossed.transmittance.data]).toEqual([
        ...expected.transmittance.data,
      ])
      expect([...crossed.multiScatter.data]).toEqual([
        ...expected.multiScatter.data,
      ])
      expect(crossed.recipe).toEqual(expected.recipe)
    } finally {
      pool.terminate()
    }
  })

  it('is the shared registry plus this one task, and nothing shared is lost', () => {
    const shared = createTaskRegistry().names()
    const game = createGameTaskRegistry().names()
    expect(game).toEqual([...shared, 'render.bakeAtmosphere'].sort())
    // The shared registry does not know it: the layer graph forbids the import
    // and the headless runner would never ask.
    expect(shared).not.toContain('render.bakeAtmosphere')
  })
})
