import { SLAB_REFERENCE } from '@inertialref/rendering'
import { describe, expect, it } from 'vitest'
import {
  MONTE_CARLO,
  monteCarloHolds,
  slabPopulation,
  traceView,
} from './slabTables.ts'

/*
 * One committed row of the Monte Carlo slab, walked again from its seed: a
 * slab of τ 20, a hundred thousand paths. It is here and not in the gate
 * because it is tens of seconds of one core; a row over sixty leaves this
 * suite too.
 */

describe('a committed row of τ = 20', () => {
  it('is the row its seed walks, within 3·SE + 0.5% of adding-doubling, in under a minute', () => {
    const depth = 20
    const view = MONTE_CARLO.views[0]
    const paths = MONTE_CARLO.paths[MONTE_CARLO.depths.indexOf(depth)]!
    const population = slabPopulation(MONTE_CARLO.radius)
    const start = process.hrtime.bigint()
    const traced = traceView(
      population,
      MONTE_CARLO.band,
      depth,
      MONTE_CARLO.suns,
      view,
      paths,
    )
    const seconds = Number(process.hrtime.bigint() - start) / 1e9
    console.log(
      `monteCarloSlab: τ ${depth}, ${paths} paths, ${seconds.toFixed(1)} s`,
    )
    expect(seconds).toBeLessThan(60)
    MONTE_CARLO.suns.forEach((sunMu, s) => {
      const kept = SLAB_REFERENCE.monteCarlo.find(
        (row) =>
          row.radius === MONTE_CARLO.radius &&
          row.depth === depth &&
          row.sunMu === sunMu &&
          row.viewMu === view[0] &&
          row.azimuth === view[1] &&
          row.side === view[2],
      )!
      // The mean is printed to five figures and the error to three.
      expect(Math.abs(traced.mean[s]! / kept.mean - 1)).toBeLessThan(1e-5)
      expect(Math.abs(traced.error[s]! / kept.error - 1)).toBeLessThan(1e-2)
      expect(kept.paths).toBe(paths)
      expect(
        monteCarloHolds({
          ...kept,
          mean: traced.mean[s]!,
          error: traced.error[s]!,
        }),
      ).toBe(true)
    })
  }, 120_000)
})
