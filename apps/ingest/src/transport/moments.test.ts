import {
  angleOf,
  diffractionShare,
  mieDroplets,
  radiusIndex,
  radiusOf,
} from '@inertialref/rendering'
import { beforeAll, describe, expect, it } from 'vitest'
import { capMoments, phaseOf } from './legendre.ts'
import {
  SOLAR_ANGULAR_RADIUS,
  dropletMoments,
  exactPhase,
  meanMoments,
  negativeShare,
  scaledMoments,
  type DropletMoments,
} from './moments.ts'

/*
 * The moments are held three ways that share no arithmetic with them: the
 * coefficients' own sum for g (Bohren and Huffman's 4.62, in `mie.ts`), the
 * committed droplet table's texels, and that table's bulk.
 */

const table = mieDroplets()
/** A row of the committed table, so its texels are this population's own: 5.85 µm. */
const ROW = 12
let row: DropletMoments
let ten: DropletMoments

beforeAll(() => {
  row = dropletMoments(radiusOf(table, ROW))
  ten = dropletMoments(10)
})

describe('a droplet population’s moments', () => {
  it('integrate to one, and their first is g from the coefficients’ own sum', () => {
    for (const population of [row, ten])
      for (const band of population.bands) {
        // A Gauss rule of 2N + 2 nodes on a polynomial of degree 4N is
        // exact, so what is left is rounding through a thousand terms.
        expect(Math.abs(band.phase[0]! - 1)).toBeLessThan(1e-10)
        expect(Math.abs(band.phase[1]! - band.asymmetry)).toBeLessThan(1e-10)
      }
  })

  it('give the committed table’s g at a radius between its rows, to 10⁻³', () => {
    const at = radiusIndex(table, 10)
    const low = Math.floor(at)
    const between =
      table.bulk[low]!.asymmetry +
      (table.bulk[low + 1]!.asymmetry - table.bulk[low]!.asymmetry) * (at - low)
    const mean = ten.bands.reduce((sum, b) => sum + b.phase[1]!, 0) / 3
    expect(Math.abs(mean - between)).toBeLessThan(1e-3)
  })

  it('sum to the committed table’s texels at a row’s own radius', () => {
    row.bands.forEach((band, b) => {
      for (let i = 0; i < table.angles; i += 37) {
        const texel = table.phase[(ROW * table.angles + i) * 3 + b]!
        const series = phaseOf(band.phase, Math.cos(angleOf(table, i)))
        // Half float's rounding is 2⁻¹¹ of a value.
        expect(Math.abs(series - texel)).toBeLessThan(texel * 2 ** -10)
      }
    })
  })

  it('share the table’s f_δ = 1/Q_ext at a row’s own radius', () => {
    // The table's bulk is printed to seven figures.
    expect(
      Math.abs(row.share - diffractionShare(table, row.radius)),
    ).toBeLessThan(1e-7)
  })

  it('stop where the largest drop’s series does', () => {
    for (const band of ten.bands) {
      const tail = band.phase.subarray(band.phase.length - 8)
      for (const value of tail) expect(Math.abs(value)).toBeLessThan(1e-6)
    }
  })
})

describe('the renderer’s medium', () => {
  it('is a phase function: χ′₀ = 1, with the Fraunhofer share taken out of every moment', () => {
    for (const band of ten.bands) {
      const scaled = scaledMoments(band, ten.share)
      expect(Math.abs(scaled[0]! - 1)).toBeLessThan(1e-10)
      for (const l of [1, 17, 64, 200])
        expect(scaled[l]!).toBeCloseTo(
          (band.phase[l]! - ten.share * band.diffraction[l]!) / (1 - ten.share),
          14,
        )
    }
  })

  it('has lost the forward peak, and the pattern’s wings reach well outside its cone', () => {
    const band = ten.bands[1]!
    const scaled = scaledMoments(band, ten.share)
    // The whole phase is 549 sr⁻¹ ahead and the scaled one a sixth of it.
    expect(phaseOf(scaled, 1)).toBeLessThan(0.2 * phaseOf(band.phase, 1))
    // The pattern falls as θ⁻³ past its cone, 1.9° here, and the phase
    // function falls faster. So the pattern's share of the whole phase,
    // which is what a first-order term on the whole phase carries over the
    // scaled medium's own, is not small where the cone ends: measured, 40%
    // at 6°, 14% at 10° and 1.7% at 30°; and 7.6% again at 90°, where the
    // phase function is at its floor.
    const share = (degrees: number): number => {
      const mu = Math.cos((degrees * Math.PI) / 180)
      return (
        1 - ((1 - ten.share) * phaseOf(scaled, mu)) / phaseOf(band.phase, mu)
      )
    }
    for (const [degrees, low, high] of [
      [6, 0.35, 0.45],
      [10, 0.11, 0.16],
      [30, 0.012, 0.022],
      [90, 0.05, 0.1],
      [150, 0, 0.01],
      [175, 0, 0.01],
    ] as const) {
      expect(share(degrees)).toBeGreaterThan(low)
      expect(share(degrees)).toBeLessThan(high)
    }
  })

  it('is under zero in less than 1% of itself, in the pattern’s dark rings', () => {
    for (const population of [row, ten])
      for (const band of population.bands) {
        const share = negativeShare(scaledMoments(band, population.share))
        expect(share).toBeGreaterThan(0)
        expect(share).toBeLessThan(0.01)
      }
  })

  it('has a smaller asymmetry than (g − f_δ)/(1 − f_δ) gives, by the pattern’s own wings', () => {
    // The pattern is not a delta: its θ⁻³ wings put its g near 1 − 2/(πx).
    const band = ten.bands[1]!
    const scaled = scaledMoments(band, ten.share)
    const delta = (band.asymmetry - ten.share) / (1 - ten.share)
    expect(scaled[1]!).toBeGreaterThan(delta)
    expect(scaled[1]! - delta).toBeLessThan(0.01)
  })
})

describe('a first-order phase', () => {
  it('is the series for a point sun, and the series through the cap for a disk', () => {
    const moments = ten.bands[0]!.phase
    const point = exactPhase(moments, 0)
    const disk = exactPhase(moments)
    const cap = capMoments(SOLAR_ANGULAR_RADIUS, moments.length)
    const convolved = moments.map((value, l) => value * cap[l]!)
    for (const mu of [1, 0.99, 0.3, -0.5, -1]) {
      expect(point(mu)).toBe(phaseOf(moments, mu))
      expect(disk(mu)).toBe(phaseOf(convolved, mu))
    }
    // A 0.27° disk takes the top off a peak a degree wide and leaves 90° alone.
    expect(disk(1)).toBeLessThan(point(1))
    expect(Math.abs(disk(0) - point(0))).toBeLessThan(1e-3 * point(0))
  })
})

describe('a mixture’s moments', () => {
  it('are the mean, on the longest set’s orders', () => {
    const mean = meanMoments([
      Float64Array.of(1, 0.5),
      Float64Array.of(1, 0.7, 0.3),
    ])
    expect([...mean]).toEqual([1, 0.6, 0.15])
  })
})
