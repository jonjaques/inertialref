import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { atmosphereShellRatio } from '@inertialref/rendering'
import {
  MILKY_WAY,
  TEST_CATALOG,
  catalogStub,
  generateSystem,
  walkBodies,
} from '@inertialref/universe'
import { scatteringBakes, scatteringKey } from './preloadPlan.ts'

/*
 * What the plan composes, not what it computes.
 *
 * The arithmetic moved to `@inertialref/rendering`'s `datum.ts`, where a
 * property test covers it, and both `buildScene` and `scatteringBakes` call it
 * — so "do the two formulas agree" is no longer a question this file can ask.
 * It used to answer it by building a whole `GameEngine`, workers and save store
 * included, to compare two six-line formulas.
 *
 * What is left is the plan's own job: walk the loaded systems, cover every
 * atmosphere exactly once, and key each bake the way `atmosphereLuts.ts` will
 * look it up. A missing entry is a cache miss wearing a cache's clothes — the
 * boot cost is paid and the 50 ms bake happens on first sight anyway.
 */

const SOL = generateSystem(
  rootSeed('inertialref'),
  MILKY_WAY,
  catalogStub(TEST_CATALOG.stars[0]!),
)

describe('the scattering prebake plan', () => {
  it('covers every atmosphere in the loaded systems, under the key it will be asked for', () => {
    const planned = new Map(
      scatteringBakes([SOL]).map((bake) => [
        scatteringKey(bake.haze, bake.topRatio),
        bake,
      ]),
    )

    let asked = 0
    for (const body of walkBodies(SOL)) {
      const haze = body.appearance.haze
      if (haze === null) continue
      asked += 1
      // The key the scene will compute at draw time: `buildScene`'s
      // `atmosphereScale`, which is this same call.
      const topRatio = atmosphereShellRatio(
        body.radius,
        body.surface.maxElevation,
        haze.height,
      )
      expect(planned.has(scatteringKey(haze, topRatio))).toBe(true)
    }
    // Sol alone carries at least Venus, Earth, Mars and the four giants.
    expect(asked).toBeGreaterThanOrEqual(7)
  })

  it('dedupes bakes that share a key', () => {
    const bakes = scatteringBakes([SOL])
    const keys = bakes.map((bake) => scatteringKey(bake.haze, bake.topRatio))
    expect(new Set(keys).size).toBe(keys.length)
    expect(bakes.length).toBeGreaterThan(0)
  })

  it('plans nothing for a system with no atmospheres to plan for', () => {
    expect(scatteringBakes([])).toEqual([])
  })
})
