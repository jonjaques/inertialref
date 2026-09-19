import { expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { galaxySeedOf } from '../galaxy.ts'
import { createGalaxyField } from './field.ts'
import { integrateGalaxyRay } from './integral.ts'
import {
  calibrateGalaxy,
  galaxyFaceOnLuminosity,
  galaxySkyDirections,
  SKY_REGION_REFERENCES,
} from './calibration.ts'
import { galaxyVMagnitude, GALAXY_PHOTOPIC_TO_V } from './photometry.ts'

it('calibrates the actual default session galaxy seed', () => {
  const field = createGalaxyField(galaxySeedOf(rootSeed('inertialref')))
  const report = calibrateGalaxy(field)
  expect(report.passed).toBe(true)
  expect(report.population.localPerCubicParsec).toBeCloseTo(0.1, 14)
  expect(report.population.totalStars / 1e9).toBeCloseTo(116.064, 2)
  for (const sky of report.sky) {
    expect(Math.abs(sky.residualMagnitude)).toBeLessThan(0.3)
    expect(Math.abs(sky.photopicResidualMagnitude)).toBeLessThan(0.3)
  }
}, 120000)

/*
 * Five minutes, the descent's budget, and for the same reason: it guards a
 * hang, not the cost. The test reads 23 s on one M5 core, and on a four-core
 * runner sharing the graph with the descent, the docs build and a type
 * project it crosses two minutes — on a runner a quarter to a half slower
 * on every other stage than one where the whole slow suite took 115 s.
 */
it('checks local sky, external luminosity and population normalization together', () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const report = calibrateGalaxy(field)
  expect(report.passed).toBe(true)
  expect(report.fieldVersions).toEqual({ 'galaxy-field': 5 })
  expect(report.luminosity.intrinsicSolarV).toBeGreaterThan(
    report.luminosity.faceOnSolarV,
  )
  const finer = galaxyFaceOnLuminosity(field, 96)
  expect(Math.abs(report.luminosity.faceOnSolarV / finer - 1)).toBeLessThan(
    0.01,
  )
  for (const region of SKY_REGION_REFERENCES) {
    const rays = galaxySkyDirections(region, 16, 48)
    const reference =
      rays.reduce(
        (sum, d) =>
          sum +
          integrateGalaxyRay(field, SUN_POSITION, d, {
            sampling: 'settled',
            maxStepParsecs: 10,
          }).radianceNanowatts,
        0,
      ) / rays.length
    const tested = report.sky.find((s) => s.name === region.name)!
    expect(Math.abs(reference / tested.vNanowatts - 1)).toBeLessThan(0.01)
    expect(
      Math.abs(
        galaxyVMagnitude(reference) - galaxyVMagnitude(region.vNanowatts),
      ),
    ).toBeLessThan(0.3)
    expect(
      Math.abs(
        -2.5 *
          Math.log10(
            (reference * GALAXY_PHOTOPIC_TO_V) / region.photopicNanowatts,
          ),
      ),
    ).toBeLessThan(0.3)
  }
}, 300_000)
