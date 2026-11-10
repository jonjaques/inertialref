import { describe, expect, it } from 'vitest'
import { ICE_AGGREGATE } from './iceAggregate.generated.ts'
import {
  decodeIceTable,
  iceAggregate,
  type IceTable,
  type IceTableSource,
} from './iceTable.ts'
import { angleIndex, angleOf, convolveDisk } from './mieTable.ts'

/*
 * These read the committed table, never the generator: a table that drifts
 * from what its decoder and the phase atlas assume fails here, in the gate,
 * whatever Baum's files in `.data/` say. The row recomputed from those
 * files is the generator's test, which skips where they are absent.
 */

const table = iceAggregate()
const DEGREE = Math.PI / 180
const at = (row: number, angle: number, band: number) =>
  table.phase[(row * table.angles + angle) * 3 + band]!

/** ∫p dΩ and ∫p cos θ dΩ of a row and band, by the trapezoid in θ on the table's own angles. */
function moments(t: IceTable, row: number, band: number): [number, number] {
  let norm = 0
  let first = 0
  for (let i = 0; i + 1 < t.angles; i += 1) {
    const t0 = angleOf(t, i)
    const t1 = angleOf(t, i + 1)
    const p0 = t.phase[(row * t.angles + i) * 3 + band]! * Math.sin(t0)
    const p1 = t.phase[(row * t.angles + i + 1) * 3 + band]! * Math.sin(t1)
    norm += 0.5 * (p0 + p1) * (t1 - t0)
    first += 0.5 * (p0 * Math.cos(t0) + p1 * Math.cos(t1)) * (t1 - t0)
  }
  return [2 * Math.PI * norm, 2 * Math.PI * first]
}

/** The row's phase at θ, radians, linear between texels: what the atlas's sampler reads. */
function read(row: number, theta: number, band: number): number {
  const a = angleIndex(table, theta)
  const a0 = Math.min(Math.floor(a), table.angles - 2)
  return (
    at(row, a0, band) + (at(row, a0 + 1, band) - at(row, a0, band)) * (a - a0)
  )
}

describe('the committed ice table', () => {
  it('is Baum’s 23 diameters, 10 to 120 µm, on the droplets’ 1024 angles and bands', () => {
    expect([table.angles, table.diameters]).toEqual([1024, 23])
    expect([table.diameterMin, table.diameterStep]).toEqual([10, 5])
    expect(table.bands).toEqual([680, 550, 440])
    expect(table.phase).toHaveLength(23 * 1024 * 3)
    expect(table.phase.every((p) => Number.isFinite(p) && p > 0)).toBe(true)
  })

  it('keeps each row’s integral within 10⁻³ of one, in every band', () => {
    for (let row = 0; row < table.diameters; row += 1)
      for (let band = 0; band < 3; band += 1)
        expect(Math.abs(moments(table, row, band)[0] - 1)).toBeLessThan(1e-3)
  })

  it('holds each row’s asymmetry within 2% of its bulk’s', () => {
    for (let row = 0; row < table.diameters; row += 1) {
      const g =
        [0, 1, 2].reduce((sum, band) => sum + moments(table, row, band)[1], 0) /
        3
      expect(Math.abs(g / table.bulk[row]!.asymmetry - 1)).toBeLessThan(0.02)
    }
  })

  it('has no halo: no local maximum within 4° of 22° or of 46°, which roughening removes', () => {
    for (let row = 0; row < table.diameters; row += 1)
      for (let band = 0; band < 3; band += 1)
        for (const halo of [22, 46]) {
          // At 0.1°, coarser than the texels there (0.088°), so a texel's
          // half-float rounding is not counted as a maximum.
          const values = Array.from({ length: 81 }, (_, k) =>
            read(row, (halo - 4 + k * 0.1) * DEGREE, band),
          )
          const peaks = values.filter(
            (v, k) =>
              k > 0 &&
              k < values.length - 1 &&
              v > values[k - 1]! * (1 + 2 ** -10) &&
              v > values[k + 1]! * (1 + 2 ** -10),
          )
          expect(peaks).toEqual([])
        }
  })

  it('holds a forward peak past half float, which only the row’s scale lets the file carry', () => {
    // The 120 µm row in blue: 188,469 sr⁻¹ at 0°, stored quartered.
    expect(ICE_AGGREGATE.scales.at(-1)).toBe(4)
    expect(at(22, 0, 2)).toBeGreaterThan(65504)
    // Convolved with Earth's sun, 0.265°, the atlas's peak is back inside
    // RGBA16F's range by a factor of ten.
    const convolved = convolveDisk(table, 0.265 * DEGREE)
    expect(Math.max(...convolved)).toBeLessThan(65504 / 8)
  })

  it('names its source, says no license is stated, quotes the README’s date and lists the files it was made from', () => {
    expect(ICE_AGGREGATE.habit).toBe(
      'aggregate of solid columns, severely roughened',
    )
    expect(ICE_AGGREGATE.citation).toContain(
      'Journal of Quantitative Spectroscopy and Radiative Transfer, 146, 123–139. doi:10.1016/j.jqsrt.2014.02.029',
    )
    expect(ICE_AGGREGATE.license).toBe('no license or terms of use are stated')
    expect(ICE_AGGREGATE.sourceDate).toBe('Last Updated: 25 July 2013')
    expect(ICE_AGGREGATE.files.map((f) => f.name)).toEqual([
      'AggregateSolidColumns_SeverelyRough_AllWavelengths_FullPhaseMatrix.nc.gz',
      'AggregateSolidColumns_SeverelyRough_AllWavelengths_NoPhaseMatrix.nc',
      'README.txt',
    ])
    for (const file of ICE_AGGREGATE.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.bytes).toBeGreaterThan(0)
    }
  })
})

describe('the ice decoder', () => {
  const tiny: IceTableSource = {
    ...ICE_AGGREGATE,
    angles: 2,
    diameters: 2,
    // Six texels of 1.0 and 2.0 as half floats, 0x3c00 and 0x4000
    // little-endian, in base64: the core has no `btoa` to encode them.
    phase: 'ADwAQAA8AEAAPABAADwAQAA8AEAAPABA',
    scales: [1, 4],
    bulk: [
      [2, 1, 0.75],
      [2, 1, 0.75],
    ],
  }

  it('multiplies each row back by its scale, exactly', () => {
    const decoded = decodeIceTable(tiny)
    expect([...decoded.phase.subarray(0, 6)]).toEqual([1, 2, 1, 2, 1, 2])
    expect([...decoded.phase.subarray(6)]).toEqual([4, 8, 4, 8, 4, 8])
  })

  it('refuses a scale a row that is missing or is not a power of two', () => {
    expect(() => decodeIceTable({ ...tiny, scales: [1] })).toThrow(
      'power of two',
    )
    expect(() => decodeIceTable({ ...tiny, scales: [1, 3] })).toThrow(
      'power of two',
    )
    expect(() => decodeIceTable({ ...tiny, scales: [1, 0] })).toThrow(
      'power of two',
    )
  })
})
