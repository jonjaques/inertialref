import { describe, expect, it } from 'vitest'
import { halfRangeGauss } from './legendre.ts'
import type { SourceForm } from './slabForms.ts'
import {
  describeRow,
  judge,
  judgeFlux,
  judgeValues,
  percentile,
  reconstruct,
  worstOf,
  type JudgedFlux,
  type JudgedRow,
  type SlabScale,
} from './slabJudge.ts'
import type { SourceTable } from './slabSource.ts'

/*
 * A judgment held to a table whose answer is known: a source that is the
 * same everywhere adds c·(1 − e^(−τ′/μ)) to a slab from either face, so a
 * row's error is whatever its `scaled` is written to make it.
 */

const SOURCE = 0.25
const SCALE: SlabScale = { radius: 10, share: 0.5, asymmetry: 0.75 }

/** One slab of one texel's value everywhere, read by its first channel. */
const TABLE: SourceTable = {
  nodes: 2,
  suns: 2,
  sunMuMin: 0.05,
  depthScale: 0.02,
  depthMax: 16,
  slabs: 1,
  terms: Float64Array.from({ length: 2 * 2 * 2 * 4 }, (_, at) =>
    at % 4 === 0 ? SOURCE : 9,
  ),
}

const FLAT: SourceForm = {
  name: 'flat',
  slabs: 1,
  fit: () => new Float64Array(4),
  reads: () => [{ slab: 0, weights: [1, 0, 0, 0] }],
}

/** What the flat source adds to a slab of unscaled depth `depth`, seen at `viewMu`. */
const added = (depth: number, viewMu: number): number =>
  SOURCE * (1 - Math.exp((-depth * (1 - SCALE.share)) / viewMu))

/** A row whose rebuilt radiance is off by `error` in each band: red by it, green by half, blue by none. */
function row(
  depth: number,
  sunMu: number,
  error: number,
  more: Partial<JudgedRow> = {},
): JudgedRow {
  const first = 0.1
  const exact = first + added(depth, 0.4)
  return {
    radius: 10,
    depth,
    sunMu,
    viewMu: 0.4,
    azimuth: 45,
    side: 'reflected',
    set: 'grid',
    angle: 100,
    domain: true,
    first: [first, first, first],
    scaled: [exact / (1 + error), exact / (1 + error / 2), exact],
    ...more,
  }
}

describe('a row rebuilt through a table', () => {
  it('is the form’s reads of the table along the ray, at the row’s scaled depth', () => {
    for (const side of ['reflected', 'transmitted'] as const)
      expect(
        reconstruct(TABLE, FLAT, SCALE, {
          depth: 6,
          sunMu: 0.7,
          viewMu: 0.4,
          azimuth: 45,
          side,
        }),
      ).toBeCloseTo(added(6, 0.4), 10)
  })

  it('is judged in every band, with first order beside what the table adds', () => {
    const values = judgeValues(TABLE, FLAT, [SCALE], [row(5, 1, 0.08)])
    expect(values.map((value) => value.band)).toEqual([0, 1, 2])
    expect(values[0]!.error).toBeCloseTo(0.08, 9)
    expect(values[1]!.error).toBeCloseTo(0.04, 9)
    expect(values[2]!.error).toBeCloseTo(0, 9)
  })

  it('is left out where the domain does not hold its direction', () => {
    expect(
      judgeValues(
        TABLE,
        FLAT,
        [SCALE],
        [row(5, 1, 0.5, { domain: false }), row(5, 1, 0.01)],
      ),
    ).toHaveLength(3)
  })
})

describe('a table’s judgment', () => {
  const rows = [
    row(5, 1, 0.02),
    row(5, 0.5, -0.12),
    row(20, 1, 0.06),
    row(7, 0.7, 0.09, { set: 'held' }),
    // A thin depth is recorded, and is no part of the worst error.
    row(1, 1, 0.4, { set: 'thin' }),
    row(2, 1, -0.3, { set: 'thin' }),
  ]
  const judged = judge(TABLE, FLAT, [SCALE], rows, [], [1, 2, 0.5])

  it('is the worst error over the grid and the held-out slabs, and where it is', () => {
    expect(judged.error).toBeCloseTo(0.12, 9)
    expect(judged.grid).toBeCloseTo(0.12, 9)
    expect(judged.held).toBeCloseTo(0.09, 9)
    expect(judged.worst).toBe(
      "10 µm, 680 nm, τ 5, μ₀ 0.5, μ 0.4 at 45°, reflected, 100.0° from the sun's direction",
    )
    expect(judged.worst).toBe(describeRow(rows[1]!, 0))
  })

  it('records the thin depths apart, each by its own depth', () => {
    expect(judged.thin[0]).toBeCloseTo(0.4, 9)
    expect(judged.thin[1]).toBeCloseTo(0.3, 9)
    expect(judged.thin[2]).toBe(0)
  })

  it('says how the error is spread: root mean square, three percentiles, and the count over 5%', () => {
    // Twelve radiances: each row's error, half of it, and none.
    const errors = [0.02, -0.12, 0.06, 0.09].flatMap((e) => [e, e / 2, 0])
    expect(judged.count).toBe(12)
    expect(judged.rms).toBeCloseTo(
      Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / 12),
      9,
    )
    const sorted = errors.map(Math.abs).sort((a, b) => a - b)
    expect(judged.median).toBeCloseTo(sorted[6]!, 9)
    expect(judged.ninetyFifth).toBeCloseTo(sorted[11]!, 9)
    expect(judged.ninetyNinth).toBeCloseTo(sorted[11]!, 9)
    // 0.12, 0.06 (twice: a row's own and half of 0.12) and 0.09.
    expect(judged.over).toBe(4)
  })

  it('breaks the worst down by sun and by depth, descending', () => {
    expect(judged.bySun.map(([sun]) => sun)).toEqual([1, 0.7, 0.5])
    expect(judged.bySun[0]![1]).toBeCloseTo(0.06, 9)
    expect(judged.bySun[2]![1]).toBeCloseTo(0.12, 9)
    expect(judged.byDepth.map(([depth]) => depth)).toEqual([20, 7, 5])
    expect(judged.byDepth[2]![1]).toBeCloseTo(0.12, 9)
  })

  it('has percentiles of nothing at zero', () => {
    expect(percentile([], 0.5)).toBe(0)
    expect(worstOf([])).toBe(0)
    expect(judge(TABLE, FLAT, [SCALE], [], []).worst).toBe('')
  })
})

describe('a slab’s reflected flux through a table', () => {
  const rule = halfRangeGauss(8)
  /** ∫ c·(1 − e^(−τ′/μ))·μ dΩ over the hemisphere, by the rubric's eight Gauss points. */
  const higher = (depth: number): number =>
    2 *
    Math.PI *
    rule.nodes.reduce(
      (sum, mu, k) => sum + rule.weights[k]! * mu * added(depth, mu),
      0,
    )
  const flux = (
    depth: number,
    sunMu: number,
    error: number,
    set: JudgedFlux['set'] = 'grid',
  ): JudgedFlux => {
    const first = 0.05
    const exact = (first + higher(depth) / sunMu) / (1 + error)
    return {
      radius: 10,
      depth,
      sunMu,
      set,
      first: [first, first, first],
      scaled: [exact, exact, exact],
    }
  }

  it('is first order and the higher orders summed over the hemisphere, over the flux arriving', () => {
    expect(judgeFlux(TABLE, FLAT, [SCALE], [flux(5, 0.7, 0)])).toBeLessThan(
      1e-10,
    )
    expect(
      judgeFlux(
        TABLE,
        FLAT,
        [SCALE],
        [flux(5, 0.7, 0.01), flux(20, 0.5, -0.03), flux(1, 1, 0.5, 'thin')],
      ),
    ).toBeCloseTo(0.03, 9)
  })

  it('goes around the whole circle: a source with a bearing in it sums to its mean', () => {
    const leaning: SourceForm = {
      ...FLAT,
      // 1 + sin θ·cos φ: the second term is zero around the circle.
      reads: (ray) => [{ slab: 0, weights: [1 + ray.along, 0, 0, 0] }],
    }
    expect(judgeFlux(TABLE, leaning, [SCALE], [flux(5, 0.7, 0)])).toBeLessThan(
      1e-10,
    )
    const lopsided: SourceForm = {
      ...FLAT,
      reads: (ray) => [{ slab: 0, weights: [ray.along > 0 ? 2 : 0, 0, 0, 0] }],
    }
    expect(judgeFlux(TABLE, lopsided, [SCALE], [flux(5, 0.7, 0)])).toBeLessThan(
      1e-10,
    )
  })
})
