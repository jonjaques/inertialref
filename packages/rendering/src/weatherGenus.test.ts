import { describe, expect, it } from 'vitest'
import {
  GENUS_TABLE,
  genusExtinctionShape,
  genusRadiusShape,
  genusWater,
  scaledExtinction,
} from './weatherGenus.ts'
import { CLOUD_GENERA, genusProfile } from './weatherScenario.ts'

/* The genus table's shape, and the one law in it that is a law: the scaling. */

describe('the genus table', () => {
  it('holds every genus, each with an extinction, a radius, a cell and a thickness a layer can have', () => {
    expect(Object.keys(GENUS_TABLE).sort()).toEqual([...CLOUD_GENERA].sort())
    for (const genus of CLOUD_GENERA) {
      const spec = GENUS_TABLE[genus]
      expect(spec.sigma, genus).toBeGreaterThan(0)
      expect(spec.radius, genus).toBeGreaterThan(0)
      expect(spec.cell, genus).toBeGreaterThan(0)
      expect(spec.erosion, genus).toBeGreaterThanOrEqual(0)
      expect(spec.erosion, genus).toBeLessThanOrEqual(1)
      expect(spec.thickness[0], genus).toBeGreaterThan(0)
      expect(spec.thickness[1], genus).toBeGreaterThanOrEqual(spec.thickness[0])
    }
  })

  it('draws ice in cirrus alone, and convection in the two cumuliform genera', () => {
    expect(CLOUD_GENERA.filter((g) => GENUS_TABLE[g].class === 'ice')).toEqual([
      'cirrus',
    ])
    expect(CLOUD_GENERA.filter((g) => GENUS_TABLE[g].cumuliform)).toEqual([
      'cumulus',
      'cumulonimbus',
    ])
  })

  it('shapes the extinction by the genus’s edge times the water’s two-thirds power, and the radius by its cube root', () => {
    for (const genus of CLOUD_GENERA)
      for (const h of [-0.1, 0, 0.05, 0.3, 0.5, 0.9, 1, 1.2]) {
        const water = genusWater(genus, h)
        expect(water).toBeGreaterThan(0)
        expect(genusExtinctionShape(genus, h)).toBeCloseTo(
          genusProfile(genus, h) * water ** (2 / 3),
          12,
        )
        expect(genusRadiusShape(genus, h)).toBeCloseTo(water ** (1 / 3), 12)
      }
  })
})

describe('the scaled extinction', () => {
  it('is the extinction less the diffraction’s share of it', () => {
    // A large droplet's Q_ext is near 2, so near half of σ is diffraction.
    expect(scaledExtinction(0.052, 0.5)).toBeCloseTo(0.026, 15)
    expect(scaledExtinction(0.052, 0)).toBe(0.052)
    expect(scaledExtinction(0, 0.47)).toBe(0)
    expect(scaledExtinction(0.068, 1 / 2.04)).toBeCloseTo(
      0.068 * (1 - 1 / 2.04),
      15,
    )
  })
})
