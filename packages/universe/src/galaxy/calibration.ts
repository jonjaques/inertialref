import { invariant, PARSEC } from '@inertialref/shared'
import { UV, vec3, type Vec3 } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import {
  GALAXY_POPULATIONS,
  POPULATION_NAMES,
  type GalaxyField,
} from './field.ts'
import {
  integrateGalaxyCount,
  integrateGalaxyRay,
  GALAXY_RADIANCE_FACTOR,
} from './integral.ts'
import {
  GALAXY_PHOTOPIC_TO_V,
  GALAXY_SOLAR_V_MAGNITUDE,
  galaxyVMagnitude,
} from './photometry.ts'
import { SKY_REGION_REFERENCES } from './skyCalibration.generated.ts'

export { SKY_REGION_REFERENCES }
/** Licquia et al. 2015 Table 3 gives M_V - 5 log h; their adopted h is 0.7. */
export const GALAXY_ABSOLUTE_V_TARGET = -20.74 + 5 * Math.log10(0.7)
export const GALAXY_PHOTOMETRIC_TOLERANCE = 0.3

export function galaxySkyDirections(
  region: (typeof SKY_REGION_REFERENCES)[number],
  latitudeSteps = 8,
  longitudeSteps = 24,
): readonly Vec3[] {
  for (const n of [latitudeSteps, longitudeSteps])
    invariant(
      Number.isInteger(n) && n > 0 && n <= 128,
      'Sky quadrature counts must be 1–128',
    )
  const result: Vec3[] = []
  const lo = Math.sin((region.absoluteLatitude[0] * Math.PI) / 180)
  const hi = Math.sin((region.absoluteLatitude[1] * Math.PI) / 180)
  for (let i = 0; i < latitudeSteps; i++)
    for (let j = 0; j < longitudeSteps; j++)
      for (const sign of [-1, 1]) {
        const l =
          ((region.longitude[0] +
            ((j + 0.5) / longitudeSteps) *
              (region.longitude[1] - region.longitude[0])) *
            Math.PI) /
          180
        const y = sign * (lo + ((i + 0.5) / latitudeSteps) * (hi - lo)),
          r = Math.sqrt(1 - y * y)
        result.push(vec3(r * Math.cos(l), y, -r * Math.sin(l)))
      }
  return result
}

/** Face-on isotropic-equivalent luminosity includes absorption, as an external photometric measurement does. */
export function galaxyFaceOnLuminosity(field: GalaxyField, steps = 48): number {
  invariant(
    Number.isInteger(steps) && steps >= 4 && steps <= 256,
    'Luminosity grid must be 4–256',
  )
  const dr = 30000 / steps,
    da = (2 * Math.PI) / steps
  let total = 0
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      const r = (i + 0.5) * dr,
        a = (j + 0.5) * da
      const p = UV.fromMeters(
        r * Math.cos(a) * PARSEC,
        10000 * PARSEC,
        r * Math.sin(a) * PARSEC,
      )
      total +=
        (integrateGalaxyRay(field, p, vec3(0, -1, 0), {
          distanceParsecs: 20000,
          sampling: 'settled',
          maxStepParsecs: 500,
        }).radianceNanowatts /
          GALAXY_RADIANCE_FACTOR) *
        r *
        dr *
        da
    }
  return total
}

/** Linear-light acceptance. No exposure or display response enters this calculation. */
export function calibrateGalaxy(field: GalaxyField) {
  const sky = SKY_REGION_REFERENCES.map((region) => {
    const rays = galaxySkyDirections(region)
    const vNanowatts =
      rays.reduce(
        (sum, d) =>
          sum +
          integrateGalaxyRay(field, SUN_POSITION, d, { sampling: 'settled' })
            .radianceNanowatts,
        0,
      ) / rays.length
    const vMagnitude = galaxyVMagnitude(vNanowatts)
    const residualMagnitude = vMagnitude - galaxyVMagnitude(region.vNanowatts)
    const photopicNanowatts = vNanowatts * GALAXY_PHOTOPIC_TO_V
    const photopicResidualMagnitude =
      -2.5 * Math.log10(photopicNanowatts / region.photopicNanowatts)
    return {
      name: region.name,
      samples: rays.length,
      vNanowatts,
      vMagnitude,
      targetVNanowatts: region.vNanowatts,
      residualMagnitude,
      photopicNanowatts,
      targetPhotopicNanowatts: region.photopicNanowatts,
      photopicResidualMagnitude,
      passed:
        Math.abs(residualMagnitude) < GALAXY_PHOTOMETRIC_TOLERANCE &&
        Math.abs(photopicResidualMagnitude) < GALAXY_PHOTOMETRIC_TOLERANCE,
    }
  })
  const count = integrateGalaxyCount(field, {
    radialSteps: 120,
    azimuthSteps: 96,
    verticalSteps: 48,
  })
  const intrinsicSolarV = POPULATION_NAMES.reduce(
    (sum, p) =>
      sum + count.populations[p] * GALAXY_POPULATIONS[p].meanSolarLuminosities,
    0,
  )
  const faceOnSolarV = galaxyFaceOnLuminosity(field)
  const absoluteV = GALAXY_SOLAR_V_MAGNITUDE - 2.5 * Math.log10(faceOnSolarV)
  const localDensity = field.sample(SUN_POSITION).totalPerCubicParsec
  return {
    fieldVersions: field.versions,
    units: 'Johnson V nW m^-2 sr^-1',
    modeledComponents: ['integrated starlight'],
    referenceComponents: [
      'integrated starlight',
      'diffuse Galactic light',
      'extragalactic background',
    ],
    photopicToV: GALAXY_PHOTOPIC_TO_V,
    toleranceMagnitude: GALAXY_PHOTOMETRIC_TOLERANCE,
    sky,
    luminosity: {
      intrinsicSolarV,
      faceOnSolarV,
      absoluteV,
      targetAbsoluteV: GALAXY_ABSOLUTE_V_TARGET,
      residualMagnitude: absoluteV - GALAXY_ABSOLUTE_V_TARGET,
    },
    population: {
      totalStars: count.totalStars,
      localPerCubicParsec: localDensity,
    },
    passed:
      sky.every((s) => s.passed) &&
      Math.abs(absoluteV - GALAXY_ABSOLUTE_V_TARGET) <
        GALAXY_PHOTOMETRIC_TOLERANCE &&
      count.totalStars > 1e11 &&
      count.totalStars < 4e11 &&
      Math.abs(localDensity - 0.1) < 1e-12,
  }
}
