import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { SOL_ONLY_CATALOG } from '../catalog/starCatalog.ts'
import { resolveSystem, systemsWithin, cellContext } from '../galaxy.ts'
import {
  createGalaxyField,
  GALAXY_POPULATIONS,
  POPULATION_NAMES,
} from './field.ts'
import {
  LUMINOSITY_BANDS,
  POPULATION_LUMINOSITY_WEIGHTS,
  createPopulationGenerator,
  populationCellOf,
  parsePopulationSystemId,
  populationApparentMagnitude,
  selectPopulationSky,
  unresolvedPopulationFraction,
  partitionGalaxyEmission,
  populationCoverage,
} from './population.ts'
import { integrateGalaxyRay } from './integral.ts'

const seed = rootSeed('population-contract')
const field = createGalaxyField(seed)
const generator = createPopulationGenerator(field)

it('shares immutable catalog coverage across cell and address queries', () => {
  const catalog = Object.create(SOL_ONLY_CATALOG) as typeof SOL_ONLY_CATALOG
  Object.defineProperty(catalog, 'inCell', {
    value: SOL_ONLY_CATALOG.inCell.bind(SOL_ONLY_CATALOG),
  })
  const stars = vi.fn(() => SOL_ONLY_CATALOG.stars)
  Object.defineProperty(catalog, 'stars', { get: stars })
  const first = populationCoverage(catalog)
  const cell = populationCellOf(SUN_POSITION, 0)
  expect(cellContext(catalog, cell).magnitudeCoverage).toBe(first)
  expect(populationCoverage(catalog)).toBe(first)
  expect(stars).toHaveBeenCalledOnce()
  expect(populationCoverage(SOL_ONLY_CATALOG)).not.toBe(first)
})

describe('the magnitude population', () => {
  it('conserves transported RGB moments and keeps total calibration independent of a draw ceiling', () => {
    const selection = {
      origin: SUN_POSITION,
      apparentMagnitudeLimit: 8,
      levelMask: 0b101101011,
    }
    const resolvedField = {
      ...field,
      sample(position: Parameters<typeof field.sample>[0], footprint?: number) {
        const sample = field.sample(position, footprint)
        const light = partitionGalaxyEmission(
          sample,
          position,
          selection,
        ).resolved
        return { ...sample, emissionRgb: light }
      },
    }
    for (const direction of [
      vec3(1, 0, 0),
      vec3(0.7, 0.1, 0.3),
      vec3(0, 1, 0),
    ]) {
      const options = { distanceParsecs: 500, maxStepParsecs: 2 }
      const total = integrateGalaxyRay(field, SUN_POSITION, direction, options)
      const diffuse = integrateGalaxyRay(field, SUN_POSITION, direction, {
        ...options,
        resolved: selection,
      })
      const resolved = integrateGalaxyRay(
        resolvedField,
        SUN_POSITION,
        direction,
        options,
      )
      for (let channel = 0; channel < 3; channel++)
        expect(
          diffuse.rgbNanowatts[channel]! + resolved.rgbNanowatts[channel]!,
        ).toBeCloseTo(total.rgbNanowatts[channel]!, 9)
      expect(diffuse.transmittanceRgb).toEqual(total.transmittanceRgb)
      expect(diffuse.starsPerSquareParsec).toBe(total.starsPerSquareParsec)
      expect(
        integrateGalaxyRay(field, SUN_POSITION, direction, options),
      ).toEqual(total)
    }
  })

  it('reads a local box without enumerating the rest of a coarse population cell', () => {
    const level = 3,
      cell = populationCellOf(SUN_POSITION, level)
    const all = generator.cell(level, cell)
    const star = all[0]!
    const radius = 0.01 * PARSEC
    const box = {
      min: UV.translate(star.position, vec3(-radius, -radius, -radius)),
      max: UV.translate(star.position, vec3(radius, radius, radius)),
    }
    const narrow = generator.cell(level, cell, undefined, box)
    expect(narrow).toContainEqual(star)
    expect(narrow.length).toBeLessThan(all.length / 2)
  })
  it('owns every luminosity band once and preserves calibrated number and light', () => {
    expect(new Set(LUMINOSITY_BANDS.map((band) => band.level)).size).toBe(
      LUMINOSITY_BANDS.length,
    )
    for (let i = 1; i < LUMINOSITY_BANDS.length; i++)
      expect(LUMINOSITY_BANDS[i]!.minSolarV).toBe(
        LUMINOSITY_BANDS[i - 1]!.maxSolarV,
      )
    for (const population of POPULATION_NAMES) {
      const weights = POPULATION_LUMINOSITY_WEIGHTS[population]
      expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 14)
      const mean = weights.reduce(
        (sum, weight, i) => sum + weight * LUMINOSITY_BANDS[i]!.meanSolarV,
        0,
      )
      expect(mean).toBeCloseTo(
        GALAXY_POPULATIONS[population].meanSolarLuminosities,
        12,
      )
    }
  })

  it('returns omitted and unresolved bands to the diffuse ensemble', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 10000, noNaN: true }),
        fc.double({ min: -5, max: 14, noNaN: true }),
        (distance, magnitude) => {
          for (const population of POPULATION_NAMES) {
            const fraction = unresolvedPopulationFraction(
              population,
              distance,
              magnitude,
              (1 << LUMINOSITY_BANDS.length) - 1,
            )
            expect(fraction).toBeGreaterThanOrEqual(0)
            expect(fraction).toBeLessThanOrEqual(1)
            expect(
              unresolvedPopulationFraction(population, distance, magnitude, 0),
            ).toBe(1)
            expect(fraction + (1 - fraction)).toBe(1)
          }
        },
      ),
    )
  })

  it('regenerates a coarse source by address and finds it through a local travel query', () => {
    const level = 4
    const cell = populationCellOf(SUN_POSITION, level)
    const stars = generator.cell(level, cell)
    expect(stars.length).toBeGreaterThan(0)
    const star = stars[0]!
    expect(parsePopulationSystemId(star.id)).toMatchObject({ level, cell })
    expect(resolveSystem(seed, SOL_ONLY_CATALOG, star.id)).toEqual(star)
    const nearby = systemsWithin(
      seed,
      SOL_ONLY_CATALOG,
      star.position,
      0.001 * PARSEC,
    )
    expect(nearby.find((one) => one.id === star.id)).toEqual(star)
  })

  it('keeps the admitted bands complete when the sprite ceiling binds', () => {
    const selection = selectPopulationSky(field, SUN_POSITION, {
      spriteCeiling: 128,
      candidateCeiling: 30000,
      cellCeiling: 2000,
      apparentMagnitudeLimit: 8,
    })
    expect(selection.stars.length).toBeLessThanOrEqual(128)
    expect(selection.candidateCount).toBeLessThanOrEqual(30000)
    expect(selection.cellsVisited).toBeLessThanOrEqual(2000)
    expect(selection.levelMask).toBeGreaterThan(0)
    for (const star of selection.stars)
      expect(
        populationApparentMagnitude(
          star.visualLuminosities!,
          UV.distance(star.position, SUN_POSITION) / PARSEC,
        ),
      ).toBeLessThanOrEqual(selection.apparentMagnitudeLimit)
    const repeated = selectPopulationSky(field, SUN_POSITION, {
      spriteCeiling: 128,
      candidateCeiling: 30000,
      cellCeiling: 2000,
      apparentMagnitudeLimit: 8,
    })
    expect(repeated).toEqual(selection)
    const moved = UV.translate(SUN_POSITION, vec3(1200 * PARSEC, 0, 0))
    const regional = selectPopulationSky(field, moved, {
      spriteCeiling: 128,
      candidateCeiling: 30000,
      cellCeiling: 2000,
      apparentMagnitudeLimit: 8,
    })
    expect(regional.candidateCount).toBeLessThanOrEqual(30000)
    expect(regional.cellsVisited).toBeLessThanOrEqual(2000)
  })
})
