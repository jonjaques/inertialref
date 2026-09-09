import { expect, it } from 'vitest'
import { rootSeed, Rng } from '@inertialref/procedural'
import { PARSEC } from '@inertialref/shared'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { UV } from '@inertialref/spatial'
import { createGalaxyField } from './field.ts'
import {
  createPopulationGenerator,
  populationCellOf,
  populationApparentMagnitude,
} from './population.ts'

it('holds completeness, uniqueness and order independence across ten thousand cells', () => {
  const seed = rootSeed('ten-thousand-population-cells')
  const generator = createPopulationGenerator(createGalaxyField(seed))
  const centre = populationCellOf(SUN_POSITION, 0)
  const random = new Rng(seed)
  const coverage = {
    radiusParsecs: 150 / 3.261563777167433,
    innerMagnitude: 7.3,
    outerMagnitude: 6.5,
    completeRadiusParsecs: 25 / 3.261563777167433,
  }
  const seen = new Set<string>()
  const cells = Array.from({ length: 10000 }, (_, index) => ({
    x: centre.x + (index % 100) - 50,
    y: centre.y + (Math.floor(index / 100) % 10) - 5,
    z: centre.z + Math.floor(index / 1000) - 5,
  }))
  for (const cell of cells) {
    const stars = generator.cell(0, cell, coverage)
    for (const star of stars) {
      expect(seen.has(star.id)).toBe(false)
      seen.add(star.id)
      const distance = UV.distance(star.position, SUN_POSITION) / PARSEC
      expect(distance).toBeGreaterThanOrEqual(coverage.completeRadiusParsecs)
      expect(
        populationApparentMagnitude(star.visualLuminosities!, distance),
      ).toBeGreaterThan(
        distance < coverage.radiusParsecs
          ? coverage.innerMagnitude
          : coverage.outerMagnitude,
      )
    }
    if (random.next() < 0.02) {
      generator.cell(
        0,
        { x: cell.x + 8, y: cell.y - 2, z: cell.z + 1 },
        coverage,
      )
      expect(generator.cell(0, cell, coverage)).toEqual(stars)
    }
  }
  expect(seen.size).toBeGreaterThan(10000)
}, 120000)
