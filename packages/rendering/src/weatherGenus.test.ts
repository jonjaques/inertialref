import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mieDroplets, radiusOf } from './mieTable.ts'
import type { LevelSpec } from './weatherClimate.ts'
import {
  adiabaticWater,
  effectiveRadius,
  GENUS_TABLE,
  genusDiffractionShare,
  genusExtinction,
  genusExtinctionShape,
  genusRadius,
  genusWater,
  levelProfile,
  PROFILE_HEIGHTS,
  PROFILE_ROWS,
  readLevelProfile,
  scaledExtinction,
  waterExtinction,
} from './weatherGenus.ts'
import { CLOUD_GENERA, type CloudGenus } from './weatherScenario.ts'

/*
 * The genus table and the law it follows: water grows adiabatically over a
 * base, droplets grow with it, and the extinction is the water's. Phase 1
 * design §5.2.
 */

const ADIABATIC: readonly CloudGenus[] = CLOUD_GENERA.filter(
  (genus) => GENUS_TABLE[genus].water === 'adiabatic',
)

const genus = fc.constantFrom(...CLOUD_GENERA)
const thickness = fc.double({ min: 100, max: 15_000, noNaN: true })
const h01 = fc.double({ min: 0, max: 1, noNaN: true })

/** The mean of f over [0, 1] by 4,096 midpoints: 10⁻⁷ of a smoothstep's integral. */
const meanOf = (f: (h: number) => number): number => {
  let sum = 0
  for (let i = 0; i < 4096; i += 1) sum += f((i + 0.5) / 4096)
  return sum / 4096
}

describe('the law’s size', () => {
  it('gives 0.5 g/m³, 12.6 µm and 59.4 km⁻¹ at 500 m over an adiabatic base, the measurement’s order', () => {
    // §5.2's check, by hand: s = 1, N = 74 cm⁻³, k = 0.80, z = 500 m. The
    // design quotes 59.5 km⁻¹; the law's own figure is 59.37.
    const water = adiabaticWater(500)
    expect(water).toBeCloseTo(0.5e-3, 15)
    expect(effectiveRadius(water)).toBeCloseTo(12.63, 2)
    expect(waterExtinction(water) * 1000).toBeCloseTo(59.37, 2)
  })

  it('makes σ go as the water’s two-thirds power and the radius as its cube root', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-6, max: 5e-3, noNaN: true }),
        fc.double({ min: 1.1, max: 8, noNaN: true }),
        (water, factor) => {
          const ratio = (f: (w: number) => number) =>
            f(water * factor) / f(water)
          expect(ratio(waterExtinction)).toBeCloseTo(factor ** (2 / 3), 10)
          expect(ratio(effectiveRadius)).toBeCloseTo(factor ** (1 / 3), 10)
        },
      ),
    )
  })
})

describe('the genus table', () => {
  it('holds every genus, each with an extinction, a radius, a cell and a thickness a layer can have', () => {
    expect(Object.keys(GENUS_TABLE).sort()).toEqual([...CLOUD_GENERA].sort())
    for (const one of CLOUD_GENERA) {
      const spec = GENUS_TABLE[one]
      expect(spec.sigma, one).toBeGreaterThan(0)
      expect(spec.radius, one).toBeGreaterThan(0)
      expect(spec.cell, one).toBeGreaterThan(0)
      expect(spec.erosion, one).toBeGreaterThanOrEqual(0)
      expect(spec.erosion, one).toBeLessThanOrEqual(1)
      expect(spec.thickness[0], one).toBeGreaterThan(0)
      expect(spec.thickness[1], one).toBeGreaterThanOrEqual(spec.thickness[0])
    }
  })

  it('holds the plan’s measured extinctions, the marine one where it gives two', () => {
    const km = (one: CloudGenus) => GENUS_TABLE[one].sigma * 1000
    expect(km('stratus')).toBe(40)
    expect(km('stratocumulus')).toBe(35)
    expect(km('cumulus')).toBe(52)
    expect(km('cumulonimbus')).toBe(93)
    expect(km('fog')).toBeCloseTo(8.1, 12)
    for (const one of ['altostratus', 'altocumulus'] as const) {
      expect(km(one)).toBeGreaterThanOrEqual(20)
      expect(km(one)).toBeLessThanOrEqual(40)
    }
    expect(km('cirrus')).toBeGreaterThanOrEqual(0.05)
    expect(km('cirrus')).toBeLessThanOrEqual(0.5)
  })

  it('gives a droplet genus the radius of the marine droplets whose water makes its σ', () => {
    for (const one of CLOUD_GENERA) {
      if (GENUS_TABLE[one].class === 'ice') continue
      const { sigma, radius } = GENUS_TABLE[one]
      // The water at that radius, and its extinction: the genus's own.
      const water = (4 / 3) * Math.PI * 1000 * 0.8 * 74e6 * (radius * 1e-6) ** 3
      expect(waterExtinction(water), one).toBeCloseTo(sigma, 12)
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
})

describe('the profile with height', () => {
  it('normalizes the water to a mean of one over any level', () => {
    fc.assert(
      fc.property(genus, thickness, (one, depth) => {
        expect(meanOf((h) => genusWater(one, h, depth))).toBeCloseTo(1, 5)
      }),
    )
  })

  it('is zero outside its level and continuous inside it', () => {
    fc.assert(
      fc.property(genus, thickness, h01, (one, depth, h) => {
        for (const outside of [-0.5, -1e-9, 0, 1, 1 + 1e-9, 1.5])
          expect(genusExtinctionShape(one, outside, depth)).toBe(0)
        // The steepest slope any genus has is fog's rise, a smoothstep over
        // 0.02 of the level, 1.5/0.02 = 75 per unit of h01, times the
        // water's two-thirds power, under 1.6: so a step of 10⁻⁷ moves the
        // shape by under 1.2 × 10⁻⁵.
        const step = 1e-7
        const a = genusExtinctionShape(one, h, depth)
        const b = genusExtinctionShape(one, Math.min(1, h + step), depth)
        expect(Math.abs(b - a)).toBeLessThan(1.2e-5)
      }),
    )
  })

  it('grows the radius with height in an adiabatic genus, and never shrinks it in a capped one', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ADIABATIC, 'stratus' as const),
        thickness,
        h01,
        h01,
        (one, depth, a, b) => {
          const [low, high] = a < b ? [a, b] : [b, a]
          expect(genusRadius(one, high, depth)).toBeGreaterThanOrEqual(
            genusRadius(one, low, depth),
          )
        },
      ),
    )
    // Adiabatic water is zero at the base and greatest at the top.
    expect(genusWater('cumulus', 0, 1400)).toBe(0)
    expect(genusWater('cumulus', 1, 1400)).toBeGreaterThan(1.3)
    // Capped water stops growing at its mean and holds it to the top.
    expect(genusWater('stratus', 0.9, 700)).toBe(genusWater('stratus', 1, 700))
  })

  it('has each genus’s σ as its mean over the level, at any thickness', () => {
    fc.assert(
      fc.property(genus, thickness, h01, (one, depth, h) => {
        const shape = meanOf((x) => genusExtinctionShape(one, x, depth))
        // σ(h) is the shape over its own mean, by 1,024 midpoints; against
        // 4,096 the two quadratures agree to 10⁻⁵ of it.
        const scale = genusExtinction(one, h, depth) / GENUS_TABLE[one].sigma
        const expected = genusExtinctionShape(one, h, depth) / shape
        expect(Math.abs(scale - expected)).toBeLessThanOrEqual(
          1e-5 * Math.max(expected, 1e-12),
        )
      }),
      { numRuns: 60 },
    )
  })
})

describe('the scaled extinction', () => {
  it('is the extinction less the diffraction’s share of it, which is 1/Q_ext', () => {
    expect(scaledExtinction(0.052, 0.5)).toBeCloseTo(0.026, 15)
    expect(scaledExtinction(0.052, 0)).toBe(0.052)
    expect(scaledExtinction(0, 0.47)).toBe(0)
    const table = mieDroplets()
    for (const row of [0, 7, table.radii - 1]) {
      const radius = radiusOf(table, row)
      const share = genusDiffractionShare('cumulus', radius)
      expect(share).toBeCloseTo(1 / table.bulk[row]!.extinction, 12)
      expect(scaledExtinction(0.052, share)).toBeCloseTo(
        (1 - 1 / table.bulk[row]!.extinction) * 0.052,
        15,
      )
    }
    expect(genusDiffractionShare('cirrus', 32)).toBe(0.5)
  })
})

describe('a level’s profile table', () => {
  const cumulus: LevelSpec = {
    base: 1000,
    top: 2400,
    stratiform: 'cumulus',
    cumuliform: 'cumulus',
  }
  const low: LevelSpec = {
    base: 850,
    top: 3175,
    stratiform: 'stratocumulus',
    cumuliform: 'cumulus',
  }
  const at = (
    texels: Uint8Array,
    row: number,
    height: number,
    channel: number,
  ): number => texels[(row * PROFILE_HEIGHTS + height) * 4 + channel]!

  it('reaches its own greatest extinction and radius, and holds nothing at either end', () => {
    for (const level of [cumulus, low]) {
      const { texels } = levelProfile(level)
      let greatest = 0
      let radius = 0
      for (let row = 0; row < PROFILE_ROWS; row += 1) {
        expect(at(texels, row, 0, 0)).toBe(0)
        expect(at(texels, row, PROFILE_HEIGHTS - 1, 0)).toBe(0)
        for (let i = 0; i < PROFILE_HEIGHTS; i += 1) {
          greatest = Math.max(greatest, at(texels, row, i, 0))
          radius = Math.max(radius, at(texels, row, i, 3))
        }
      }
      // The greatest is taken over a grid sixteen times finer than the
      // texels, so a texel holds it to within the shape's change over a
      // sixty-third of the level.
      expect(greatest).toBeGreaterThanOrEqual(250)
      expect(radius).toBe(255)
    }
  })

  it('holds the whole column above its base, none above its top, and less with height', () => {
    for (const level of [cumulus, low]) {
      const { texels } = levelProfile(level)
      for (let row = 0; row < PROFILE_ROWS; row += 1) {
        expect(at(texels, row, 0, 2)).toBe(255)
        expect(at(texels, row, PROFILE_HEIGHTS - 1, 2)).toBe(0)
        for (let i = 1; i < PROFILE_HEIGHTS; i += 1)
          expect(at(texels, row, i, 2)).toBeLessThanOrEqual(
            at(texels, row, i - 1, 2),
          )
      }
    }
  })

  it('gives a fully covered, unresolved level its genus’s σ: the table’s mean times its greatest', () => {
    // A regime's level is one genus, so every row is that genus.
    const profile = levelProfile(cumulus)
    const [, mean] = readLevelProfile(profile, 0.5, 0)
    // G is a byte: half a step of 255 is the bound.
    expect(
      Math.abs((profile.sigma * mean) / GENUS_TABLE.cumulus.sigma - 1),
    ).toBeLessThan(0.5 / 255 / mean)
    // A blended level's rows run from one genus's mean to the other's.
    const blended = levelProfile(low)
    const ends = [0, 1].map(
      (v) => blended.sigma * readLevelProfile(blended, 0.5, v)[1],
    )
    expect(ends[0]! / GENUS_TABLE.stratocumulus.sigma).toBeCloseTo(1, 2)
    expect(ends[1]! / GENUS_TABLE.cumulus.sigma).toBeCloseTo(1, 2)
  })

  it('reads a texel at its center and blends between texels as a sampler does', () => {
    const profile = levelProfile(low)
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: PROFILE_HEIGHTS - 1 }),
        fc.integer({ min: 0, max: PROFILE_ROWS - 1 }),
        (i, j) => {
          const read = readLevelProfile(
            profile,
            i / (PROFILE_HEIGHTS - 1),
            j / (PROFILE_ROWS - 1),
          )
          for (let c = 0; c < 4; c += 1)
            expect(read[c]).toBeCloseTo(at(profile.texels, j, i, c) / 255, 12)
        },
      ),
    )
    const between = readLevelProfile(profile, 10.5 / 63, 3 / 7)[0]
    expect(between).toBeCloseTo(
      (at(profile.texels, 3, 10, 0) + at(profile.texels, 3, 11, 0)) / 2 / 255,
      12,
    )
  })

  it('scales its greatest extinction at its greatest radius, and is built once for its members', () => {
    const profile = levelProfile(cumulus)
    expect(profile.scaled).toBeCloseTo(
      scaledExtinction(
        profile.sigma,
        genusDiffractionShare('cumulus', profile.radius),
      ),
      15,
    )
    expect(levelProfile({ ...cumulus })).toBe(profile)
    expect(profile.cell).toBe(GENUS_TABLE.cumulus.cell)
    expect(levelProfile(low).cell).toBe(GENUS_TABLE.cumulus.cell)
  })

  it('refuses a level whose two genera scatter as different classes', () => {
    expect(() =>
      levelProfile({
        base: 8000,
        top: 9000,
        stratiform: 'cirrus',
        cumuliform: 'altocumulus',
      }),
    ).toThrow(/different classes/)
  })
})
