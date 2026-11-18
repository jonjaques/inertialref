import {
  SLAB_REFERENCE,
  diffractionShare,
  mieDroplets,
  samplePhase,
} from '@inertialref/rendering'
import { describe, expect, it } from 'vitest'
import { firstOrder, scatteringCosine } from './addingDoubling.ts'
import {
  FLUX_AXES,
  MONTE_CARLO,
  SLAB_DOMAIN,
  SOURCE_RADIUS,
  inDomain,
  monteCarloHolds,
  scatteringAngle,
  slabPairs,
  worstDifference,
} from './slabTables.ts'

/*
 * The committed reference, held to itself: every figure its header states
 * is recomputed here from the table it describes. What it costs minutes to
 * recompute from the Mie series is the slow suite's, and the source tables
 * are `slabSourceTable.test.ts`'s.
 */

const rows = SLAB_REFERENCE.rows
const judged = rows.filter((row) => row.set !== 'thin')

describe('the reference’s rows', () => {
  it('are the domain: three radii, twenty-five slabs, both faces, five views at five azimuths', () => {
    const pairs = slabPairs()
    expect(pairs).toHaveLength(12 + 4 + 9)
    expect(rows).toHaveLength(SLAB_DOMAIN.radii.length * pairs.length * 50)
    const count = (set: string): number =>
      rows.filter((row) => row.set === set).length
    expect([count('grid'), count('held'), count('thin')]).toEqual([
      3 * 12 * 50,
      3 * 4 * 50,
      3 * 9 * 50,
    ])
    // A held-out slab shares neither its depth nor its sun with the grid.
    for (const row of rows.filter((item) => item.set === 'held')) {
      expect(SLAB_DOMAIN.depths.held).toContain(row.depth)
      expect(SLAB_DOMAIN.suns.held).toContain(row.sunMu)
    }
  })

  it('list the scattering angle beside every point, and leave the rings and the cone to their own tests', () => {
    for (const row of rows) {
      const angle = scatteringAngle(
        row.sunMu,
        row.viewMu,
        row.azimuth,
        row.side,
      )
      expect(Math.abs(row.angle - angle)).toBeLessThanOrEqual(0.05)
      expect(row.domain).toBe(inDomain(row.side, angle))
    }
    // The three points the rubric names: the glory's center twice, and the
    // row a degree from the cloudbow.
    const at = (sunMu: number, viewMu: number, azimuth: number) =>
      rows.find(
        (row) =>
          row.side === 'reflected' &&
          row.sunMu === sunMu &&
          row.viewMu === viewMu &&
          row.azimuth === azimuth,
      )!
    expect(at(1, 1, 0).domain).toBe(false)
    expect(at(0.2, 0.2, 180).domain).toBe(false)
    expect(at(1, 0.8, 0).angle).toBeCloseTo(143.1, 1)
    expect(at(1, 0.8, 0).domain).toBe(false)
    expect(inDomain('transmitted', 6.4)).toBe(true)
    expect(inDomain('transmitted', 5.9)).toBe(false)
    expect(inDomain('reflected', 172)).toBe(false)
  })

  it('hold first order as the march reads it: the committed droplet table’s phase, at the row’s gain', () => {
    const table = mieDroplets()
    const worst = new Map<number, number>()
    for (const row of rows) {
      if (!row.domain) continue
      const media = SLAB_REFERENCE.media.find(
        (item) => item.radius === row.radius,
      )!
      const nu = scatteringCosine(
        row.sunMu,
        row.viewMu,
        (row.azimuth * Math.PI) / 180,
        row.side,
      )
      const phase = samplePhase(table, nu, row.radius)
      const reach = firstOrder(
        row.depth * (1 - media.share),
        row.sunMu,
        row.viewMu,
        row.side,
      )
      row.first.forEach((value, band) => {
        worst.set(
          row.radius,
          Math.max(
            worst.get(row.radius) ?? 0,
            Math.abs(((phase[band]! / (1 - media.share)) * reach) / value - 1),
          ),
        )
        expect(value).toBeLessThan(row.scaled[band]!)
      })
    }
    // The table is half floats, and knows no sun's disk; the reference is
    // the series at the radius itself, through one. At 10 µm, which is a
    // row of the table to 0.05%, they differ by 0.24% at worst. At 6 and
    // 16 µm the table reads between two rows 9.4% apart in radius, and its
    // blend of them is 2.5% and 1.2% from the population at the radius.
    expect(worst.get(SOURCE_RADIUS)).toBeLessThan(0.005)
    expect(worst.get(6)).toBeLessThan(0.03)
    expect(worst.get(16)).toBeLessThan(0.02)
  })

  it('carry each radius’s f_δ as the droplet table gives it, and its g′', () => {
    const table = mieDroplets()
    expect(SLAB_REFERENCE.media.map((item) => item.radius)).toEqual([
      ...SLAB_DOMAIN.radii,
    ])
    for (const media of SLAB_REFERENCE.media) {
      // A population at the radius itself against the table between two
      // rows: 1/Q_ext is not quite linear in the row. Measured, 5 × 10⁻⁶.
      expect(
        Math.abs(media.share - diffractionShare(table, media.radius)),
      ).toBeLessThan(1e-5)
      expect(media.asymmetry).toBeGreaterThan(0.68)
      expect(media.asymmetry).toBeLessThan(0.77)
    }
  })
})

describe('the scaling’s bill', () => {
  /** The rubric's row 3: the scaled medium within 3% of the true one. */
  const ROW_3 = 0.03

  it('is the figure the table carries, recomputed from its rows', () => {
    const bill = worstDifference(
      judged,
      (row) => row.scaled,
      (row) => row.truth,
    )
    // The rows are printed to five figures.
    expect(Math.abs(bill.error - SLAB_REFERENCE.scalingError)).toBeLessThan(
      2e-4,
    )
    expect(bill.row).not.toBeNull()
  })

  it('is over the rubric’s 3%: row 3 is a declared miss, and this is its size', () => {
    // When this turns, the scaled medium meets the row and the line goes.
    expect(SLAB_REFERENCE.scalingError).toBeGreaterThan(ROW_3)
    // The miss is the thin end's and the forward side's. It falls with
    // depth, 8.9% at τ 5 to 5.6% from 10 and 3.2% from 20, and light
    // leaving the lit face is inside 4% at every depth.
    const from = (depth: number): number =>
      worstDifference(
        judged,
        (row) => row.scaled,
        (row) => row.truth,
        (row) => row.depth >= depth,
      ).error
    expect(from(10)).toBeLessThan(from(5))
    expect(from(20)).toBeLessThan(from(10))
    expect(from(20)).toBeLessThan(0.035)
    const reflected = worstDifference(
      judged,
      (row) => row.scaled,
      (row) => row.truth,
      (row) => row.side === 'reflected',
    )
    expect(reflected.error).toBeLessThan(0.04)
  })

  it('is smaller in the reflected flux than in any radiance', () => {
    expect(SLAB_REFERENCE.reflected).toHaveLength(
      SLAB_DOMAIN.radii.length * slabPairs().length,
    )
    let worst = 0
    for (const flux of SLAB_REFERENCE.reflected) {
      if (flux.set === 'thin') continue
      flux.scaled.forEach((value, band) => {
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThan(1)
        worst = Math.max(worst, Math.abs(value / flux.truth[band]! - 1))
      })
    }
    expect(worst).toBeLessThan(SLAB_REFERENCE.scalingError)
  })
})

describe('the black-surface flux', () => {
  it('rises with depth and with a lower sun, between nothing and everything', () => {
    expect(SLAB_REFERENCE.sunMus).toEqual(FLUX_AXES.sunMus)
    expect(SLAB_REFERENCE.depths).toEqual(FLUX_AXES.depths)
    expect(SLAB_REFERENCE.depths[0]).toBe(0.1)
    expect(SLAB_REFERENCE.depths.at(-1)).toBe(100)
    const count = SLAB_REFERENCE.depths.length
    expect(SLAB_REFERENCE.flux).toHaveLength(2 * count)
    for (let d = 0; d < count; d += 1) {
      const high = SLAB_REFERENCE.flux[d]!
      const low = SLAB_REFERENCE.flux[count + d]!
      expect(high).toBeGreaterThan(0)
      expect(low).toBeLessThan(1)
      // A sun at μ₀ 0.4 crosses 1.75 times the cloud a sun at 0.7 does.
      expect(low).toBeGreaterThan(high)
      if (d > 0) {
        expect(high).toBeGreaterThan(SLAB_REFERENCE.flux[d - 1]!)
        expect(low).toBeGreaterThan(SLAB_REFERENCE.flux[count + d - 1]!)
      }
    }
  })

  it('crosses ISCCP’s detection at a depth a thin cloud has, and its class boundaries in order', () => {
    // The calibration inverts R(τ, 0.7): 0.03 near τ 0.5, and 3.55 and
    // 22.63 at reflectances a third and three quarters of the way up.
    const at = (depth: number): number => {
      const { depths, flux } = SLAB_REFERENCE
      const i = depths.findIndex((value) => value >= depth)
      const t = (depth - depths[i - 1]!) / (depths[i]! - depths[i - 1]!)
      return flux[i - 1]! + (flux[i]! - flux[i - 1]!) * t
    }
    expect(at(0.3)).toBeLessThan(0.03)
    expect(at(0.6)).toBeGreaterThan(0.03)
    expect(at(3.55)).toBeGreaterThan(0.2)
    expect(at(3.55)).toBeLessThan(0.35)
    expect(at(22.63)).toBeGreaterThan(0.65)
    expect(at(22.63)).toBeLessThan(0.8)
  })
})

describe('the committed Monte Carlo rows', () => {
  const traced = SLAB_REFERENCE.monteCarlo

  it('are every depth’s twelve views under three suns, and the bill’s slab', () => {
    for (const depth of MONTE_CARLO.depths)
      expect(
        traced.filter(
          (row) => row.radius === MONTE_CARLO.radius && row.depth === depth,
        ),
      ).toHaveLength(MONTE_CARLO.views.length * MONTE_CARLO.suns.length)
    expect(
      traced.filter((row) => row.radius === MONTE_CARLO.bill.radius),
    ).toHaveLength(MONTE_CARLO.bill.views.length * MONTE_CARLO.bill.suns.length)
  })

  it('are each within 3·SE + 0.5% of adding-doubling on the true medium, at every depth, over the domain', () => {
    const held = traced.filter((row) => row.domain)
    expect(held.length).toBeGreaterThan(140)
    for (const row of held) expect(monteCarloHolds(row)).toBe(true)
    // And the bound is not slack: a row's own error is under 1% at τ 5,
    // and under 5% at 50, where a row walks a twentieth of the paths.
    for (const row of held)
      expect(row.error / row.mean).toBeLessThan(row.depth === 5 ? 0.01 : 0.05)
  })
})
