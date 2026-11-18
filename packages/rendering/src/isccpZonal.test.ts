import { describe, expect, it } from 'vitest'
import { ISCCP_ZONAL } from './isccpZonal.generated.ts'
import { isccpZonal } from './isccpZonal.ts'

/*
 * The committed zonal table against the figures it was taken to match:
 * ISCCP-H's own 2007–2016 means as the rubric quotes them (mvp.md §6.3,
 * from isccp-h-research.md §6.1), and the shapes the research says a test
 * should pin. Each quoted figure has three decimals, so the table, written
 * to four, is held to half a unit of the third.
 */

// The global 0.6475 and the band 0.6675 sit on the half exactly, and their
// float64 difference from the quote rounds to 5.000000000000560e-4.
const QUOTED = 0.0005 + 1e-12

/** The rubric's ten-year means by 10° band, 90° S to 90° N. */
const BANDS = [
  0.441, 0.562, 0.801, 0.871, 0.833, 0.708, 0.575, 0.567, 0.583, 0.657, 0.537,
  0.505, 0.625, 0.719, 0.739, 0.676, 0.668, 0.629,
]

/** ISCCP's optical-depth classes: thin, medium and thick. */
const CLASSES = [0, 3.55, 22.63, 450]

const TYPES = [
  ['cumulus', 0],
  ['stratocumulus', 1],
  ['stratus', 2],
  ['altocumulus', 0],
  ['altostratus', 1],
  ['nimbostratus', 2],
  ['cirrus', 0],
  ['cirrostratus', 1],
  ['deep-convection', 2],
] as const

const zonal = isccpZonal()

describe('ISCCP-H’s zonal table', () => {
  it('holds every month of every band, for the total and each level', () => {
    expect(zonal.months).toBe(12)
    expect(zonal.bands).toBe(18)
    for (const series of [
      ISCCP_ZONAL.cover,
      ISCCP_ZONAL.low,
      ISCCP_ZONAL.middle,
      ISCCP_ZONAL.high,
    ]) {
      expect(series).toHaveLength(12 * 18)
      for (const value of series) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  it('gives the rubric’s global, land and ocean means, ocean over land by 10 to 17 points', () => {
    expect(Math.abs(zonal.global('total')! - 0.648)).toBeLessThanOrEqual(QUOTED)
    expect(Math.abs(zonal.global('land')! - 0.555)).toBeLessThanOrEqual(QUOTED)
    expect(Math.abs(zonal.global('ocean')! - 0.684)).toBeLessThanOrEqual(QUOTED)
    const contrast = zonal.global('ocean')! - zonal.global('land')!
    expect(contrast).toBeGreaterThanOrEqual(0.1)
    expect(contrast).toBeLessThanOrEqual(0.17)
  })

  it('gives the rubric’s eighteen band means', () => {
    BANDS.forEach((quoted, band) => {
      expect(
        Math.abs(zonal.zonal('total', band)! - quoted),
        `band ${band}`,
      ).toBeLessThanOrEqual(QUOTED)
    })
  })

  it('has the shapes the research pins: the Southern Ocean’s maximum, the ITCZ, the northern subtropics’ minimum', () => {
    const band = (k: number) => zonal.zonal('total', k)!
    // 50–60° S is the maximum, over 85%.
    expect(band(3)).toBeGreaterThanOrEqual(0.85)
    for (let k = 0; k < 18; k += 1) expect(band(k)).toBeLessThanOrEqual(band(3))
    // 0–10° N exceeds both neighbors.
    expect(band(9)).toBeGreaterThan(band(10))
    expect(band(9)).toBeGreaterThan(band(8))
    // 20–30° N is the northern minimum.
    for (let k = 9; k < 18; k += 1)
      expect(band(k)).toBeGreaterThanOrEqual(band(11))
  })

  it('splits each band’s total into its three levels, within the area neither split covers', () => {
    // A level is the total in the types' proportions, over the cells the
    // types or the infrared types split; 0.4% of the area holds a total
    // and neither, most of it in polar night and at 30–40° N, which moves
    // a band-month's sum by up to 0.0095.
    const unsplit = 0.01
    for (let month = 0; month < 12; month += 1)
      for (let band = 0; band < 18; band += 1) {
        const levels =
          zonal.cover('low', month, band)! +
          zonal.cover('middle', month, band)! +
          zonal.cover('high', month, band)!
        expect(
          Math.abs(levels - zonal.cover('total', month, band)!),
        ).toBeLessThan(unsplit)
      }
  })

  it('holds a land mean only where a band has land, and an ocean mean in every band', () => {
    for (let band = 0; band < 18; band += 1)
      expect(zonal.zonal('ocean', band)).not.toBeNull()
    // 50–60° S is ocean but for the tip of South America and the islands.
    expect(zonal.zonal('land', 3)).toBeNull()
    expect(zonal.zonal('land', 0)).not.toBeNull()
  })

  it('gives each of the nine types a mean depth inside its own class', () => {
    for (const [name, thickness] of TYPES) {
      const type = zonal.type(name)
      expect(type, name).not.toBeNull()
      for (const depth of [type!.depth, type!.linearDepth, type!.logDepth]) {
        expect(depth, name).toBeGreaterThan(CLASSES[thickness]!)
        expect(depth, name).toBeLessThanOrEqual(CLASSES[thickness + 1]!)
      }
    }
  })

  it('puts each level’s types at a cloud-top pressure inside the level', () => {
    const level = (pressure: number) =>
      pressure > 680 ? 0 : pressure > 440 ? 1 : 2
    TYPES.forEach(([name], k) => {
      expect(level(zonal.type(name)!.pressure), name).toBe(Math.floor(k / 3))
    })
  })

  it('has cirrus as the commonest type, and stratus and deep convection the two rarest', () => {
    const covers = TYPES.map(
      ([name]) => [name, zonal.type(name)!.cover] as const,
    )
    const sorted = [...covers].sort((a, b) => b[1] - a[1])
    expect(sorted[0]![0]).toBe('cirrus')
    expect(
      sorted
        .slice(-2)
        .map(([name]) => name)
        .sort(),
    ).toEqual(['deep-convection', 'stratus'])
    // The nine sum to about a point over the total (research §2.3, item 4).
    const sum = covers.reduce((n, [, cover]) => n + cover, 0)
    expect(sum - zonal.global('total')!).toBeGreaterThan(0)
    expect(sum - zonal.global('total')!).toBeLessThan(0.02)
  })

  it('reads through its reader as laid out, and answers null outside the table', () => {
    expect(zonal.cover('total', 6, 9)).toBe(ISCCP_ZONAL.cover[6 * 18 + 9])
    expect(zonal.cover('high', 0, 17)).toBe(ISCCP_ZONAL.high[17])
    expect(zonal.cover('total', 12, 0)).toBeNull()
    expect(zonal.zonal('total', 18)).toBeNull()
    expect(zonal.zonal('land', 1.5)).toBeNull()
    expect(zonal.type('fog')).toBeNull()
    expect(zonal.source).toContain('10.7289/V5QZ281S')
  })
})
