import { expect, it } from 'vitest'
import {
  LUMINOSITY_BANDS,
  POPULATION_NAMES,
  populationLimitingLuminosity,
  unresolvedPopulationFraction,
} from '@inertialref/universe'
import { coveredLuminosityCeiling } from './galaxyPopulationPartition.ts'

it('bounds the exact CPU unresolved moments for every covered-band mask', () => {
  const limit = populationLimitingLuminosity(1, 8)
  for (let mask = 0; mask < 1 << LUMINOSITY_BANDS.length; mask++) {
    const maximum = coveredLuminosityCeiling(mask)
    for (const threshold of [maximum, maximum * (1 + 1e-8), maximum * 4, 1e9]) {
      const distance = Math.sqrt(threshold / limit)
      for (const population of POPULATION_NAMES)
        expect(
          unresolvedPopulationFraction(population, distance, 8, mask),
        ).toBeCloseTo(1, 12)
    }
  }
})
