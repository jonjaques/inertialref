import {
  CLOUD_OCTAVES,
  CLOUD_OCTAVE_BOUND,
  cloudOctavesPass,
} from '@inertialref/rendering'
import { describe, expect, it } from 'vitest'
import { firstOrder } from './addingDoubling.ts'
import { henyeyGreenstein } from './legendre.ts'
import {
  fitAll,
  octaveError,
  octaveRadiance,
  octaveRows,
  octavesText,
  type OctaveRow,
} from './octaveFit.ts'

const row: OctaveRow = {
  depth: 4,
  sunMu: 0.5,
  viewMu: 0.8,
  side: 'reflected',
  nu: -0.3,
  asymmetry: 0.75,
  first: 0.01,
  whole: 0.05,
}

describe('the octave series in a slab', () => {
  it('is nothing at one order, and each octave first order’s closed form with the sun’s depth scaled', () => {
    expect(octaveRadiance(1, 0.5, 0.5, 0.5, row)).toBe(0)
    const one =
      0.4 *
      henyeyGreenstein(-0.3, 0.6 * 0.75) *
      firstOrder(4, 0.5 / 0.5, 0.8, 'reflected')
    expect(octaveRadiance(2, 0.5, 0.4, 0.6, row)).toBeCloseTo(one, 14)
    const two =
      0.4 ** 2 *
      henyeyGreenstein(-0.3, 0.6 ** 2 * 0.75) *
      firstOrder(4, 0.5 / 0.25, 0.8, 'reflected')
    expect(octaveRadiance(3, 0.5, 0.4, 0.6, row)).toBeCloseTo(one + two, 14)
  })

  it('cannot return a thick slab’s light under b ≤ a, whatever the constants', () => {
    // An octave's share of a thick slab's reflected radiance is at most
    // aⁱ·p·μ₀/(μ₀ + aⁱ·μ), so the sum of three is bounded.
    const thick = { ...row, depth: 100, nu: 0 }
    let most = 0
    for (let a = 0.05; a <= 1; a += 0.05)
      for (let c = 0; c <= 1; c += 0.25)
        most = Math.max(most, octaveRadiance(4, a, a, c, thick))
    // Three isotropic octaves at a = 1 under this geometry: 3·(1/4π)·0.5/1.3.
    expect(most).toBeLessThanOrEqual((3 * 0.5) / (4 * Math.PI * 1.3) + 1e-12)
  })
})

describe('the committed fits', () => {
  const grid = octaveRows('grid')
  const held = octaveRows('held')

  it('are fitted on the grid’s slabs and judged on the held-out ones, inside the domain', () => {
    expect(grid.length).toBeGreaterThan(1500)
    expect(held.length).toBeGreaterThan(500)
    for (const item of [...grid, ...held]) {
      expect(item.first).toBeGreaterThan(0)
      expect(item.whole).toBeGreaterThan(item.first)
    }
  })

  it('are what the fit returns when it is run again, with their held-out error', () => {
    const fits = fitAll()
    expect(
      fits.map(({ count, a, b, c, heldOutError }) => ({
        count,
        a,
        b,
        c,
        heldOutError,
      })),
    ).toEqual([...CLOUD_OCTAVES])
    for (const fit of fits) {
      expect(fit.b).toBeLessThanOrEqual(fit.a)
      expect(fit.heldOutError).toBe(
        Number(
          octaveError(fit.count, fit.a, fit.b, fit.c, held).toPrecision(4),
        ),
      )
    }
    expect(octavesText(fits)).toContain(
      `heldOutError: ${fits[2]!.heldOutError}`,
    )
  })

  it('miss the bound at every count, so no octave branch is built', () => {
    // The arithmetic says so before the fit does: under b ≤ a three
    // octaves return 0.12 of the incident flux where a deck returns 0.3.
    for (const fit of CLOUD_OCTAVES)
      expect(fit.heldOutError).toBeGreaterThan(CLOUD_OCTAVE_BOUND)
    expect(cloudOctavesPass()).toBe(false)
  })
})
