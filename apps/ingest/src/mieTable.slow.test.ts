import { expect, it } from 'vitest'
import { angleOf, mieDroplets } from '@inertialref/rendering'
import {
  DROPLET_TABLE,
  gloryRing,
  RADIUS_GRID,
  sampleRows,
} from './mieTable.ts'

/*
 * The radius grid's convergence, on the row that tests it hardest: 32 µm,
 * whose drops reach x ≈ 850 in blue, where a sphere's light at a fixed angle
 * turns over every 0.001–0.002 in ln r. The committed row, summed at
 * Δln r = 0.002, against the same row summed at 0.001.
 */

const ROW = DROPLET_TABLE.radii - 1
const FINE = { ...RADIUS_GRID, step: RADIUS_GRID.step / 2 }

it(
  'converges on its radius grid: halving Δln r moves the largest row’s light by under 1%',
  { timeout: 300_000 }, // a hang guard: the finer sum is 10 s on the M6
  () => {
    const table = mieDroplets()
    const angles = Array.from({ length: table.angles }, (_, i) => i)
    const [fine] = sampleRows([ROW], angles, FINE)
    const stored = (angle: number, band: number) =>
      table.phase[(ROW * table.angles + angle) * 3 + band]!
    const halved = (angle: number, band: number) =>
      fine!.phase[3 * angle + band]!

    // The light the grid misplaces, ∫|p − p_fine| dΩ, per band: 0.025, 0.074
    // and 0.17% measured.
    for (let band = 0; band < 3; band += 1) {
      let misplaced = 0
      for (let i = 0; i + 1 < table.angles; i += 1) {
        const gap = (k: number) =>
          Math.abs(stored(k, band) - halved(k, band)) *
          Math.sin(angleOf(table, k))
        misplaced +=
          0.5 *
          (gap(i) + gap(i + 1)) *
          (angleOf(table, i + 1) - angleOf(table, i))
      }
      expect(2 * Math.PI * misplaced).toBeLessThan(0.01)
    }

    // Pointwise the grid is not converged, and no affordable grid is. Mie
    // resonances far narrower than any step — Q_sca spikes by 1.3% within one
    // unit of x near 400 — survive a 10%-wide distribution where p is
    // smallest, at the side minimum and in the glory's core, so the sum there
    // samples them. 4.53% here, measured; summed afresh, 2.96% between
    // Δln r 0.001 and 0.0005 and 1.53% between 0.0005 and 0.00025, and the
    // 0.002 grid against itself shifted half a step, 9.5%. The bound is that
    // limit, held so a coarser grid cannot pass unseen.
    let worst = 0
    for (let i = 0; i < table.angles; i += 1)
      for (let band = 0; band < 3; band += 1)
        worst = Math.max(worst, Math.abs(stored(i, band) / halved(i, band) - 1))
    expect(worst).toBeLessThan(0.05)

    // What a consumer reads off a row does converge: 3.6 × 10⁻⁵ in Q_ext and
    // 1.9 × 10⁻⁵ in g measured, and the same glory ring to the scan's step.
    const mean = (values: readonly number[]) =>
      values.reduce((sum, v) => sum + v, 0) / values.length
    expect(table.bulk[ROW]!.extinction).toBeCloseTo(mean(fine!.extinction), 4)
    expect(table.bulk[ROW]!.asymmetry).toBeCloseTo(mean(fine!.asymmetry), 4)
    expect(gloryRing(ROW, FINE)).toBe(table.gloryRed[ROW])
  },
)
