import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { createGalaxyField } from './field.ts'
import { integrateGalaxyCount } from './integral.ts'

const field = createGalaxyField(rootSeed('inertialref'))

describe('the preview stellar field count', () => {
  // The two grids sample 9,953,280 positions: 8.4 s locally in isolation,
  // beyond the regular suite's 20 s under CI contention. Keep the full grids
  // in the slow suite with two minutes to distinguish a hang from CPU cost.
  it('integrates to the reference count and converges with a finer quadrature', () => {
    const coarse = integrateGalaxyCount(field, {
      radialSteps: 120,
      azimuthSteps: 96,
    })
    const fine = integrateGalaxyCount(field, {
      radialSteps: 240,
      azimuthSteps: 192,
      verticalSteps: 96,
    })
    expect(fine.totalStars).toBeGreaterThan(1e11)
    expect(fine.totalStars).toBeLessThan(4e11)
    expect(Math.abs(coarse.totalStars / fine.totalStars - 1)).toBeLessThan(0.01)
  }, 120_000)
})
