import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { genusHash } from './cumulusFixture.ts'
import { SUN_FACTOR } from './sunFactor.generated.ts'
import { SUN_FACTOR_NONE, sunFactor, sunFactorPair } from './sunFactorRead.ts'
import { CLOUD_GENERA } from './weatherScenario.ts'

describe('the factor of the sun', () => {
  it('was fitted on the genus table the field has now', () => {
    // A moved genus table moves every cloud the pair was fitted on: regenerate with `sunFactor.ts`.
    expect(SUN_FACTOR.genusHash).toBe(genusHash())
  })

  it('is one and zero for every genus with no committed pair', () => {
    const committed = Object.keys(SUN_FACTOR.pairs)
    expect(committed).toEqual(['cumulus'])
    for (const genus of CLOUD_GENERA)
      if (!committed.includes(genus)) {
        expect(sunFactorPair(genus)).toBe(SUN_FACTOR_NONE)
        expect(sunFactorPair(genus)).toEqual({ l: 1, a: 0 })
      }
    expect(sunFactorPair('cumulus')).toEqual(SUN_FACTOR.pairs.cumulus)
  })

  it('is exactly one at a convective share of zero, at every sun', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 3, noNaN: true }),
        fc.double({ min: 0, max: 3, noNaN: true }),
        (sunMu, l, a) => {
          expect(sunFactor({ l, a }, 0, sunMu)).toBe(1)
          expect(sunFactor(SUN_FACTOR_NONE, 1, sunMu)).toBe(1)
        },
      ),
    )
  })

  it('reads the pooled table within 3% at each of its five elevations', () => {
    // The critic's bar for two numbers standing for the table: they read it within 3% at every sun.
    const pair = sunFactorPair('cumulus')
    SUN_FACTOR.fit.elevations.forEach((elevation, i) => {
      const read = sunFactor(pair, 1, Math.sin((elevation * Math.PI) / 180))
      expect(Math.abs(read / SUN_FACTOR.fit.pooled[i]! - 1)).toBeLessThan(0.03)
    })
  })

  it('holds the sun at the table’s floor, so a sun at or under the horizon reads the floor’s factor', () => {
    const pair = { l: 0.71, a: 0.25 }
    const floor = sunFactor(pair, 1, 0.05)
    expect(sunFactor(pair, 1, 0)).toBe(floor)
    expect(sunFactor(pair, 1, -0.03)).toBe(floor)
    expect(sunFactor(pair, 1, -0.5)).toBe(sunFactor(pair, 1, 0.5))
    expect(Number.isFinite(floor)).toBe(true)
  })
})
