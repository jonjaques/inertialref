import { describe, expect, it } from 'vitest'
import { SUN_FACTOR } from '@inertialref/rendering'
import {
  cutCloud,
  FACTOR_CLOUDS,
  FACTOR_SUNS,
  type FactorViews,
  fitPair,
  keptRays,
  tracePart,
} from './sunFactor.ts'

/*
 * The committed pair, fitted again from nothing but its generator: two of
 * the field's clouds found and cut, traced under the nine suns on their own
 * seeded streams, marched through the committed table, and fitted. It is
 * here and not in the gate because two clouds at the module's count are five
 * minutes of tracing; a picture of 30 rays and a twelfth of the samples
 * bring them to 39 s, of which cutting the two clouds out of the field is
 * about half. At this count 56 rays are known to a tenth and kept.
 *
 * The two are one cloud of each regime. A pair of the module's ten fits
 * anywhere from 0.57 to 0.82 in `l` and 0.16 to 0.41 in `a`, since `l` and
 * `a` trade against each other over five elevations, so two clouds of one
 * regime can fall outside a tenth. These two fit 0.722 and 0.251 at the
 * module's count and 0.751 and 0.254 at this one, against the ten's 0.700
 * and 0.263.
 */

/** A level picture of 4 by 3 and two of 3 by 3, at a twelfth of the module's samples. */
const VIEWS: FactorViews = { columns: 4, rows: 3, plan: 3, pitch: 30 }
const SAMPLES = 128
const CLOUDS = ['fc-40~-160~3', 'bh-200~60~1']

describe('the factor of the sun', () => {
  it('is fitted again from two of the field’s clouds within a tenth of the committed pair', () => {
    const rays = CLOUDS.flatMap((id) => {
      const spec = FACTOR_CLOUDS.find((cloud) => cloud.id === id)!
      const field = cutCloud(spec)
      return FACTOR_SUNS.flatMap((sun) =>
        keptRays(tracePart(spec, field, sun, SAMPLES, VIEWS)),
      )
    })
    const { pair } = fitPair(rays)
    const committed = SUN_FACTOR.pairs.cumulus
    expect(Math.abs(pair.l - committed.l)).toBeLessThan(0.1)
    expect(Math.abs(pair.a - committed.a)).toBeLessThan(0.1)
  }, /*
   * 39.0 s on the Mac mini (Mac18,5, Apple M6) under a load of 5.7 from
   * other work, 26 s of it outside vitest; thirty times that for the hosted
   * runner's slow stage, which runs over 5.4 times this Mac's.
   */ 1_170_000)
})
