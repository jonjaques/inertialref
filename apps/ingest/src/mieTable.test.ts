import { describe, expect, it } from 'vitest'
import {
  angleOf,
  decodeMieTable,
  MIE_DROPLETS,
  mieDroplets,
  radiusOf,
  type MieTableSource,
} from '@inertialref/rendering'
import {
  band,
  DROPLET_TABLE,
  encodePhase,
  gloryRing,
  halfBits,
  radiusGrid,
  rowRadius,
  rowWeights,
  sampleRows,
  tableAngle,
  waterIndex,
} from './mieTable.ts'

describe('the half-float encoder', () => {
  it('round-trips a known table through the rendering package’s decoder', () => {
    // Values half precision holds exactly: its largest, smallest normal and
    // smallest subnormal, the table's own largest (8560), and the half
    // nearest 1/3, among them. 24 values: 4 angles × 2 rows × 3 bands.
    const values = [
      1,
      0.5,
      2,
      65504,
      2 ** -14,
      2 ** -24,
      1 / 1024,
      1.5,
      3.25,
      1000,
      0.0625,
      8560,
      0.0009765625,
      7,
      11,
      13,
      0.333251953125,
      0,
      255,
      42,
      0.000244140625,
      9.5,
      16,
      0.75,
    ]
    const source: MieTableSource = {
      format: 'inertialref/mie',
      version: 1,
      angles: 4,
      radii: 2,
      radiusMin: 2,
      radiusMax: 32,
      variance: 0.01,
      bands: [680, 550, 440],
      wavelengthsPerBand: 9,
      bandHalfWidth: 40,
      index: 'a test',
      phase: encodePhase(values),
      bulk: [
        [2.1, 1, 0.85],
        [2.05, 1, 0.87],
      ],
      gloryRed: [9.125, 0.64],
    }
    const table = decodeMieTable(source)
    expect(Array.from(table.phase)).toEqual(values)
    expect(table.bulk[1]).toEqual({
      extinction: 2.05,
      albedo: 1,
      asymmetry: 0.87,
    })
    expect(table.gloryRed).toEqual([9.125, 0.64])
  })

  it('rounds to nearest, ties to even, and refuses what half precision cannot hold', () => {
    expect(halfBits(1)).toBe(0x3c00)
    expect(halfBits(-1)).toBe(0xbc00)
    expect(halfBits(-0)).toBe(0x8000)
    expect(halfBits(65504)).toBe(0x7bff)
    expect(halfBits(2 ** -24)).toBe(0x0001)
    // 1/(4π), an isotropic phase: 0.0795898 is 0x2d18.
    expect(halfBits(1 / (4 * Math.PI))).toBe(0x2d18)
    // Halfway between 1 and the next half rounds to the even mantissa.
    expect(halfBits(1 + 2 ** -11)).toBe(0x3c00)
    expect(halfBits(1 + 3 * 2 ** -11)).toBe(0x3c02)
    expect(halfBits(2049)).toBe(halfBits(2048))
    expect(halfBits(2051)).toBe(halfBits(2052))
    // The largest subnormal's tie rounds up into the smallest normal.
    expect(halfBits(2 ** -14 - 2 ** -25)).toBe(0x0400)
    expect(() => halfBits(65520)).toThrow('65504')
    expect(() => halfBits(Infinity)).toThrow('no half float')
    expect(() => halfBits(NaN)).toThrow('no half float')
  })

  it('holds every finite half, and rounds at every boundary between two: the tie to the even one, a float64 either side to the nearer', () => {
    // A half's value from its bits by arithmetic, so the encoder is not
    // checked against the platform's own float16.
    const halfOf = (bits: number): number => {
      const exponent = bits >> 10
      const mantissa = bits & 0x3ff
      return exponent === 0
        ? mantissa * 2 ** -24
        : (1 + mantissa / 1024) * 2 ** (exponent - 15)
    }
    const float = new Float64Array(1)
    const word = new BigUint64Array(float.buffer)
    /** The float64 `by` steps from a positive `x`. */
    const stepped = (x: number, by: bigint): number => {
      float[0] = x
      word[0] = word[0]! + by
      return float[0]
    }
    const wrong: string[] = []
    const hold = (value: number, bits: number): void => {
      if (halfBits(value) !== bits) wrong.push(`${value} → ${bits}`)
      if (halfBits(-value) !== (bits | 0x8000))
        wrong.push(`${-value} → ${bits | 0x8000}`)
    }
    // 0x7bff is 65504, the largest: 31,743 boundaries below it, subnormals
    // and the step into the normals among them.
    for (let bits = 0; bits < 0x7bff; bits += 1) {
      const here = halfOf(bits)
      // Exact: two neighbors are multiples of one step, and so is their mean.
      const tie = (here + halfOf(bits + 1)) / 2
      hold(here, bits)
      hold(stepped(tie, -1n), bits)
      hold(tie, bits % 2 === 0 ? bits : bits + 1)
      hold(stepped(tie, 1n), bits + 1)
    }
    hold(65504, 0x7bff)
    // The last boundary is the tie with 65536, which no half holds.
    hold(stepped(65520, -1n), 0x7bff)
    expect(() => halfBits(-65520)).toThrow('65504')
    expect(wrong).toEqual([])
  })
})

describe('the distribution, the bands and the index', () => {
  it('recovers each row’s effective radius and variance from its weights', () => {
    // Hansen and Travis's gamma has r_eff = r_e and v_eff = v exactly; what
    // the grid and the 10⁻⁸ cut leave is under 10⁻⁶ of either, measured.
    const radii = radiusGrid()
    expect(radii).toHaveLength(2080)
    for (let row = 0; row < DROPLET_TABLE.radii; row += 1) {
      const effective = rowRadius(row)
      const { first, weights } = rowWeights(
        radii,
        effective,
        DROPLET_TABLE.variance,
      )
      let area = 0
      let volume = 0
      weights.forEach((w, i) => {
        const r = radii[first + i]!
        area += w * r * r
        volume += w * r * r * r
      })
      const reff = volume / area
      let spread = 0
      weights.forEach((w, i) => {
        const r = radii[first + i]!
        spread += w * r * r * (r - reff) ** 2
      })
      const veff = spread / (reff * reff * area)
      expect(Math.abs(reff / effective - 1)).toBeLessThan(1e-5)
      expect(Math.abs(veff / DROPLET_TABLE.variance - 1)).toBeLessThan(1e-5)
    }
  })

  it('samples each band at nine wavelengths under a raised cosine, centered on the air’s', () => {
    for (const center of DROPLET_TABLE.bands) {
      const { wavelengths, weights } = band(center)
      expect(wavelengths).toHaveLength(9)
      expect(wavelengths[4]).toBe(center)
      expect(
        Math.max(...wavelengths.map((nm) => Math.abs(nm - center))),
      ).toBeCloseTo((40 * 8) / 9, 12)
      expect(weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 14)
      expect(weights[4]).toBe(Math.max(...weights))
    }
  })

  it('reads water’s index from Hale and Querry’s rows, linear between them', () => {
    expect(waterIndex(400)).toBe(1.339)
    expect(waterIndex(550)).toBe(1.333)
    expect(waterIndex(680)).toBeCloseTo(1.331, 12)
    expect(waterIndex(412.5)).toBeCloseTo(1.3385, 12)
    expect(() => waterIndex(300)).toThrow('Hale and Querry')
  })

  it('lays the generator’s angles and rows where the decoder reads them', () => {
    const table = mieDroplets()
    for (const i of [0, 1, 37, 511, 512, 1000, 1023])
      expect(tableAngle(i)).toBe(angleOf(table, i))
    for (const j of [0, 15, 31]) expect(rowRadius(j)).toBe(radiusOf(table, j))
  })
})

describe('the committed table', () => {
  // 3.6 s in the root suite on this Mac mini (Apple M6), four workers;
  // CI's hosted runner is 2.1 to 3.9 times slower, up to 14 s. Five times that.
  it('is the series’ own: three rows recomputed meet its phase, bulk and glory', () => {
    // The rendering package's tests read this file's gloryRed and bulk as
    // facts about the series; this is what makes them so. The rows are the
    // table's two ends and its middle, and the angles both ends and the
    // glory, the cloudbow and the side minimum between. 1.7 s, measured.
    const rows = [0, 15, 31]
    const angles = [0, 3, 30, 200, 450, 511, 512, 573, 823, 993, 1020, 1023]
    const table = decodeMieTable(MIE_DROPLETS)
    expect(table.angles).toBe(DROPLET_TABLE.angles)
    expect(table.radii).toBe(DROPLET_TABLE.radii)
    const samples = sampleRows(rows, angles)
    samples.forEach(({ row, phase, extinction, asymmetry, albedo }) => {
      angles.forEach((angle, a) => {
        for (let b = 0; b < 3; b += 1) {
          const stored = table.phase[(row * table.angles + angle) * 3 + b]!
          const series = phase[3 * a + b]!
          // Half float's rounding: under 2⁻¹¹ of the value.
          expect(Math.abs(stored - series)).toBeLessThanOrEqual(
            2 ** -11 * series,
          )
        }
      })
      const mean = (values: readonly number[]) =>
        values.reduce((sum, v) => sum + v, 0) / values.length
      expect(table.bulk[row]!.extinction).toBeCloseTo(mean(extinction), 4)
      expect(table.bulk[row]!.asymmetry).toBeCloseTo(mean(asymmetry), 4)
      expect(table.bulk[row]!.albedo).toBeCloseTo(mean(albedo), 4)
      expect(Math.abs(table.gloryRed[row]! - gloryRing(row))).toBeLessThan(0.01)
    })
  }, 80_000)
})
