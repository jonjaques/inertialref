import { describe, expect, it } from 'vitest'
import {
  angleIndex,
  angleOf,
  convolveDisk,
  decodeMieTable,
  diffractionShare,
  type MieTable,
  type MieTableSource,
  mieDroplets,
  phaseIntegral,
  radiusIndex,
  radiusOf,
  samplePhase,
} from './mieTable.ts'
import { MIE_DROPLETS } from './mieDroplets.generated.ts'

/*
 * These read the committed table, never the generator: a table that drifts
 * from what its decoder and its consumers assume fails here, in the gate,
 * whatever the series in apps/ingest says.
 */

const table = mieDroplets()
const DEGREE = Math.PI / 180
const at = (row: number, angle: number, band: number) =>
  table.phase[(row * table.angles + angle) * 3 + band]!

/** The texel spacing at θ, degrees. */
function texelStep(t: MieTable, theta: number): number {
  const i = Math.min(Math.floor(angleIndex(t, theta)), t.angles - 2)
  return (angleOf(t, i + 1) - angleOf(t, i)) / DEGREE
}

describe('the droplet table', () => {
  it('is 1024 angles × 32 rows × 3 bands of finite, positive phase', () => {
    expect(table.angles).toBe(1024)
    expect(table.radii).toBe(32)
    expect(table.bands).toEqual([680, 550, 440])
    expect(table.phase).toHaveLength(1024 * 32 * 3)
    // 0.0011 to 8560 sr⁻¹ measured: normal halves, under 65504.
    for (const p of table.phase) {
      expect(Number.isFinite(p)).toBe(true)
      expect(p).toBeGreaterThan(0)
    }
  })

  it('puts the glory’s first red ring where the series does (the Done-when’s second half)', () => {
    // The first maximum of the red band's p(π − ψ) after its first minimum
    // past ψ = 0, read through samplePhase at each row's own radius at 0.005°,
    // within one texel of the series' ring: 0.03° at the largest row's 0.64°,
    // 0.12° at the smallest's 9.1°. That holds the angle warp, the half floats
    // and the bilinear read to the series, which apps/ingest holds to Laven.
    // Half a texel at worst, measured.
    const step = 0.005
    for (let row = 0; row < table.radii; row += 1) {
      const radius = radiusOf(table, row)
      const values: number[] = []
      let ring = -1
      for (let k = 0; ring < 0 && k * step < 60 / radius; k += 1) {
        values.push(samplePhase(table, -Math.cos(k * step * DEGREE), radius)[0])
        ring = firstRing(values)
      }
      expect(ring).toBeGreaterThan(0)
      const psi = ring * step
      expect(Math.abs(psi - table.gloryRed[row]!)).toBeLessThanOrEqual(
        texelStep(table, Math.PI - psi * DEGREE),
      )
    }
  })

  it('normalizes every row and band to ∫p dΩ = 1 on its own grid', () => {
    // 6 × 10⁻⁵ at worst, measured: the trapezoid resolves even the largest
    // row's forward peak, 1/x = 0.13° wide in blue, across seventeen texels.
    for (let row = 0; row < table.radii; row += 1)
      for (let band = 0; band < 3; band += 1)
        expect(Math.abs(phaseIntegral(table, row, band) - 1)).toBeLessThan(1e-4)
  })

  it('peaks straight ahead and falls from there across 0.5·(10/r_e) degrees', () => {
    // Non-increasing rather than falling: texels a ten-thousandth of a degree
    // apart near 0° round to one half float.
    for (let row = 0; row < table.radii; row += 1) {
      const reach = 0.5 * (10 / radiusOf(table, row)) * DEGREE
      for (let band = 0; band < 3; band += 1) {
        const peak = at(row, 0, band)
        for (let i = 1; i < table.angles; i += 1)
          expect(at(row, i, band)).toBeLessThanOrEqual(peak)
        for (let i = 0; angleOf(table, i + 1) <= reach; i += 1)
          expect(at(row, i + 1, band)).toBeLessThanOrEqual(at(row, i, band))
      }
    }
  })

  it('draws the cloudbow between 135° and 150° for drops of 10 µm and more', () => {
    // A maximum strictly inside the window is above both its ends; 139.7° to
    // 142.0° measured.
    const lo = Math.ceil(angleIndex(table, 135 * DEGREE))
    const hi = Math.floor(angleIndex(table, 150 * DEGREE))
    for (let row = 0; row < table.radii; row += 1) {
      if (radiusOf(table, row) < 10 - 1e-9) continue
      for (let band = 0; band < 3; band += 1) {
        let best = lo
        for (let i = lo; i <= hi; i += 1)
          if (at(row, i, band) > at(row, best, band)) best = i
        expect(at(row, best, band)).toBeGreaterThan(at(row, lo, band))
        expect(at(row, best, band)).toBeGreaterThan(at(row, hi, band))
      }
    }
  })

  it('carries bulk properties a cloud of droplets has', () => {
    // From the series: the edge term and the ripple put Q_ext at 2.27 for
    // 2 µm, falling to 2.04 at 32 µm, where droplets ≫ λ alone would say 2;
    // g from 0.82 to 0.88. Water does not absorb in the visible here, κ = 0.
    for (const { extinction, albedo, asymmetry } of table.bulk) {
      expect(extinction).toBeGreaterThanOrEqual(1.9)
      expect(extinction).toBeLessThanOrEqual(2.5)
      expect(asymmetry).toBeGreaterThanOrEqual(0.8)
      expect(asymmetry).toBeLessThanOrEqual(0.9)
      expect(albedo).toBe(1)
    }
    expect(table.bulk).toHaveLength(table.radii)
    expect(table.gloryRed).toHaveLength(table.radii)
  })
})

describe('the table’s reads', () => {
  it('inverts its own angle and row maps', () => {
    for (const i of [0, 1, 2, 100, 511, 512, 900, 1022, 1023])
      expect(angleIndex(table, angleOf(table, i))).toBeCloseTo(i, 9)
    for (let j = 0; j < table.radii; j += 1)
      expect(radiusIndex(table, radiusOf(table, j))).toBeCloseTo(j, 9)
    expect(angleOf(table, 0)).toBe(0)
    expect(angleOf(table, 1023)).toBeCloseTo(Math.PI, 15)
  })

  it('reads a texel center exactly and clamps past both axes’ ends', () => {
    for (const [row, angle] of [
      [0, 0],
      [7, 300],
      [31, 1023],
      [20, 1000],
    ] as const) {
      const sampled = samplePhase(
        table,
        Math.cos(angleOf(table, angle)),
        radiusOf(table, row),
      )
      for (let band = 0; band < 3; band += 1)
        expect(sampled[band]).toBeCloseTo(at(row, angle, band), 6)
    }
    // Past the radius axis the edge rows answer, as a clamped texture does.
    expect(samplePhase(table, -1, 1)).toEqual(samplePhase(table, -1, 2))
    expect(samplePhase(table, 0.2, 64)).toEqual(samplePhase(table, 0.2, 32))
  })

  it('refuses a source that is not a table', () => {
    const good: MieTableSource = MIE_DROPLETS
    expect(() => decodeMieTable({ ...good, version: 2 } as never)).toThrow(
      'version 1',
    )
    expect(() => decodeMieTable({ ...good, radii: 31 })).toThrow('half floats')
    expect(() =>
      decodeMieTable({ ...good, phase: '!' + good.phase.slice(1) }),
    ).toThrow('not base64')
    expect(() => decodeMieTable({ ...good, bulk: good.bulk.slice(1) })).toThrow(
      'one bulk entry a row',
    )
    expect(() =>
      decodeMieTable({ ...good, gloryRed: good.gloryRed.slice(1) }),
    ).toThrow('one glory angle a row')
  })
})

/** The sample index of the first maximum after the first minimum past index 0, or −1. */
function firstRing(values: readonly number[]): number {
  let minimum = -1
  for (let i = 1; i + 1 < values.length; i += 1) {
    if (minimum < 0) {
      if (values[i - 1]! > values[i]! && values[i + 1]! >= values[i]!)
        minimum = i
    } else if (values[i - 1]! < values[i]! && values[i + 1]! <= values[i]!)
      return i
  }
  return -1
}

describe('the diffraction’s share', () => {
  it('is 1/Q_ext at each row’s own radius', () => {
    for (let row = 0; row < table.radii; row += 1)
      expect(diffractionShare(table, radiusOf(table, row))).toBeCloseTo(
        1 / table.bulk[row]!.extinction,
        12,
      )
  })

  it('runs from 0.44 at 2 µm to 0.49 at 32 µm: near half of a large droplet’s extinction is diffraction', () => {
    const small = diffractionShare(table, table.radiusMin)
    const large = diffractionShare(table, table.radiusMax)
    expect(small).toBeGreaterThan(0.43)
    expect(small).toBeLessThan(0.45)
    expect(large).toBeGreaterThan(0.48)
    expect(large).toBeLessThan(0.5)
  })

  it('is linear in the row between two rows, and holds at the table’s ends past them', () => {
    const share = (row: number) => 1 / table.bulk[row]!.extinction
    for (const row of [0, 7, 30]) {
      const between = radiusOf(table, row + 0.25)
      expect(diffractionShare(table, between)).toBeCloseTo(
        share(row) + 0.25 * (share(row + 1) - share(row)),
        12,
      )
    }
    expect(diffractionShare(table, 0.5)).toBe(share(0))
    expect(diffractionShare(table, 200)).toBe(share(table.radii - 1))
  })
})

describe('the phase under a sun’s disk', () => {
  it('is the table’s own, texel for texel, under a point sun', () => {
    const convolved = convolveDisk(table, 0)
    expect(convolved).toHaveLength(table.phase.length)
    expect(convolved).toEqual(table.phase)
  })
})
