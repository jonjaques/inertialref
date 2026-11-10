import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  firstOrder,
  scatteringCosine,
  slabNodes,
  solveSlab,
} from './addingDoubling.ts'
import { gaussLegendre, henyeyGreensteinMoments, phaseOf } from './legendre.ts'
import {
  MIDPOINT_BEARINGS,
  depthCoordinate,
  higherOrders,
  lobe,
  nodeDepth,
  nodeSun,
  readSource,
  slabRay,
  sourceSamples,
  type SourceGrid,
  type SourceRead,
  type SourceTable,
} from './slabSource.ts'

const AXES = { suns: 3, sunMuMin: 0.2, depthScale: 0.02, depthMax: 16 } as const

describe('the table’s axes', () => {
  const grid: SourceGrid = { ...AXES, nodes: 24 }

  it('put a transport depth where its node is, and clamp past the last', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 16, noNaN: true }), (depth) => {
        const u = depthCoordinate(grid, depth)
        // The depth back from its own coordinate, through a fractional node.
        const back =
          grid.depthScale *
          Math.expm1(u * Math.log1p(grid.depthMax / grid.depthScale))
        expect(Math.abs(back - depth)).toBeLessThan(1e-12 * (1 + depth))
      }),
    )
    expect(nodeDepth(grid, 0)).toBe(0)
    expect(nodeDepth(grid, 23)).toBeCloseTo(16, 12)
    for (let i = 0; i < 24; i += 1)
      expect(depthCoordinate(grid, nodeDepth(grid, i)) * 23).toBeCloseTo(i, 10)
    expect(depthCoordinate(grid, 40)).toBe(1)
    expect([nodeSun(grid, 0), nodeSun(grid, 2)]).toEqual([0.2, 1])
  })

  it('give the first node past a face a tenth of a scaled depth, where a source turns', () => {
    // 0.02·(801^(1/23) − 1) of transport depth is 0.027 of scaled depth at g′ = 0.75.
    expect(nodeDepth(grid, 1) / 0.25).toBeLessThan(0.03)
  })
})

describe('the table’s read', () => {
  const grid: SourceGrid = { ...AXES, nodes: 6 }
  /** Two slabs: the second is the first plus a hundred, so a read that strays is seen. */
  const terms = new Float64Array(2 * 3 * 6 * 6 * 4)
  for (let slab = 0; slab < 2; slab += 1)
    for (let sun = 0; sun < 3; sun += 1)
      for (let bottom = 0; bottom < 6; bottom += 1)
        for (let top = 0; top < 6; top += 1) {
          const cell = (((slab * 3 + sun) * 6 + bottom) * 6 + top) * 4
          terms[cell] =
            100 * slab + 1 + 2 * (top / 5) - bottom / 5 + 3 * nodeSun(grid, sun)
          terms[cell + 1] = top / 5
          terms[cell + 2] = (bottom / 5) * nodeSun(grid, sun)
          terms[cell + 3] = 7
        }
  const table: SourceTable = { ...grid, slabs: 2, terms }

  it('is exact for texels that are linear along each axis, in the slab it is asked for', () => {
    const out = new Float64Array(4)
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1 }),
        fc.double({ min: 0, max: 16, noNaN: true }),
        fc.double({ min: 0, max: 16, noNaN: true }),
        fc.double({ min: 0.2, max: 1, noNaN: true }),
        (slab, top, bottom, sunMu) => {
          readSource(table, slab, top, bottom, sunMu, out)
          const x = depthCoordinate(grid, top)
          const y = depthCoordinate(grid, bottom)
          expect(out[0]).toBeCloseTo(100 * slab + 1 + 2 * x - y + 3 * sunMu, 9)
          expect(out[1]).toBeCloseTo(x, 10)
          expect(out[2]).toBeCloseTo(y * sunMu, 10)
          expect(out[3]).toBeCloseTo(7, 10)
        },
      ),
    )
  })

  it('holds the end’s value past either end, and never blends two slabs', () => {
    const out = new Float64Array(4)
    // Under the first sun and over the last: a clamped texture's read, and
    // the first slab's last slice is not blended with the second's first.
    readSource(table, 0, 99, 0, 0.01, out)
    expect(out[0]).toBeCloseTo(1 + 2 + 3 * 0.2, 12)
    readSource(table, 0, 0, 0, 1.5, out)
    expect(out[0]).toBeCloseTo(1 + 3, 12)
    readSource(table, 1, 0, 0, 0.01, out)
    expect(out[0]).toBeCloseTo(100 + 1 + 3 * 0.2, 12)
  })
})

describe('the march’s integral through the table', () => {
  const flat = (texel: readonly number[]): SourceTable => {
    const terms = new Float64Array(3 * 4 * 4 * 4)
    for (let cell = 0; cell < 3 * 4 * 4; cell += 1) terms.set(texel, cell * 4)
    return { ...AXES, nodes: 4, slabs: 1, terms }
  }
  const view = { depth: 3, sunMu: 0.6, viewMu: 0.4, azimuth: 30 } as const
  const read = (weights: SourceRead['weights']): SourceRead[] => [
    { slab: 0, weights },
  ]

  it('is 1 − e^(−τ/μ) of a source that is the same everywhere, from either face', () => {
    const whole = 1 - Math.exp(-3 / 0.4)
    for (const side of ['reflected', 'transmitted'] as const) {
      expect(
        higherOrders(
          flat([2, 5, 0, 0]),
          read([1, 0, 0, 0]),
          { ...view, side },
          0.7,
        ),
      ).toBeCloseTo(2 * whole, 10)
      // Every channel is summed by its own weight, and every read is.
      expect(
        higherOrders(
          flat([2, 5, 1, 3]),
          [...read([1, 0.5, 0, -1]), ...read([0, 0, 2, 0])],
          { ...view, side },
          0.7,
        ),
      ).toBeCloseTo((2 + 2.5 - 3 + 2) * whole, 10)
    }
  })

  it('hands a form the ray’s own cosine, bearing and scattering cosine', () => {
    for (const side of ['reflected', 'transmitted'] as const) {
      const ray = slabRay({ ...view, side })
      // The cosine of light traveling to the eye about the lit face's
      // normal: toward it in reflection, away in transmission.
      expect(ray.muV).toBe(side === 'reflected' ? 0.4 : -0.4)
      expect(ray.along).toBeCloseTo(
        Math.sqrt(1 - 0.16) * Math.cos(Math.PI / 6),
        12,
      )
      expect(ray.nu).toBeCloseTo(
        scatteringCosine(0.6, 0.4, Math.PI / 6, side),
        12,
      )
      expect(ray.sunMu).toBe(0.6)
    }
  })

  it('has a lobe of zero mean over the sphere, so a constant beside it is the source’s mean', () => {
    const rule = gaussLegendre(64)
    let mean = 0
    for (let k = 0; k < 64; k += 1)
      mean += rule.weights[k]! * lobe(rule.nodes[k]!, 0.55)
    expect(Math.abs(mean)).toBeLessThan(1e-12)
    expect(lobe(1, 0.55)).toBeGreaterThan(0)
    expect(lobe(-1, 0.55)).toBeLessThan(0)
  })
})

describe('the source the oracle is cut into', () => {
  it('integrates along a ray to the oracle’s own radiance, before any fit', () => {
    // An absorbing slab, so a layer sixteen transport depths under the
    // plane is all there is below it: the cells with the last bottom node
    // are one deep slab at every depth from its lit face. Eight streams
    // against two hundred moments, so delta-M takes a tenth of every
    // scattering out and the source has to put it back; the oracle it is
    // held to is the same eight streams, whose radiance it rebuilds.
    const albedo = 0.9
    const g = 0.75
    const streams = 8
    const moments = henyeyGreensteinMoments(g, 200)
    const grid: SourceGrid = { ...AXES, nodes: 32 }
    const quadrature = slabNodes(streams)
    const picks = [0, 2, 3]
    const bearing = [0, 7, 15]
    const kept = new Map<string, number[]>()
    const run = sourceSamples(
      { moments, convolved: moments, asymmetry: g, albedo },
      grid,
      streams,
      { columns: [grid.nodes - 1] },
      (cell, source, directions) => {
        expect(cell.bottom).toBe(grid.nodes - 1)
        expect(directions.azimuths).toHaveLength(MIDPOINT_BEARINGS.count)
        for (const i of picks)
          for (const a of bearing) {
            const key = `${cell.sun} ${i} ${a}`
            const along = kept.get(key) ?? []
            // Upward directions follow the four downward ones.
            along[cell.top] = source[(streams / 2 + i) * 16 + a]!
            kept.set(key, along)
          }
      },
    )
    expect(run.delta).toBeCloseTo(g ** streams, 12)
    const depths = Array.from(
      { length: grid.nodes },
      (_, k) => nodeDepth(grid, k) / (1 - g),
    )
    const suns = [0, 1, 2].map((k) => nodeSun(grid, k))
    const views = picks.map((i) => quadrature.mu[i]!)
    const azimuths = bearing.map((a) => (180 * (a + 0.5)) / 16)
    const oracle = solveSlab({
      medium: { moments, albedo },
      depths: [128],
      suns,
      views,
      azimuths,
      streams,
    })
    suns.forEach((sun, s) =>
      views.forEach((mu, v) =>
        bearing.forEach((a, at) => {
          const source = kept.get(`${s} ${picks[v]} ${a}`)!
          // ∫S·e^(−τ/μ) dτ/μ with S linear between the table's nodes.
          let sum = 0
          for (let k = 0; k + 1 < depths.length; k += 1) {
            const x0 = depths[k]! / mu
            const x1 = depths[k + 1]! / mu
            const e0 = Math.exp(-x0)
            const e1 = Math.exp(-x1)
            const slope = (source[k + 1]! - source[k]!) / (x1 - x0)
            sum += source[k]! * (e0 - e1) + slope * (e0 - e1 - (x1 - x0) * e1)
          }
          const nu = scatteringCosine(
            sun,
            mu,
            (azimuths[at]! * Math.PI) / 180,
            'reflected',
          )
          const rebuilt =
            albedo *
              phaseOf(moments, nu) *
              firstOrder(128, sun, mu, 'reflected') +
            sum
          // The bound is the chord between thirty-two nodes: measured,
          // 0.17% at worst. With a term left out the worst case is 6.8%
          // (the delta's share of the light going the eye's way), 1.8%
          // (first order of the beam the delta feeds) and 0.7% (first
          // order's correction). The eye here is above the slab, so it is
          // the upward half of each that is held.
          expect(
            Math.abs(rebuilt / oracle.reflected[(s * 3 + v) * 3 + at]! - 1),
          ).toBeLessThan(0.003)
        }),
      ),
    )
  })

  it('samples each direction’s cosines, bearing and measure, at midpoints or between the two ends', () => {
    const medium = {
      moments: Float64Array.of(1),
      convolved: Float64Array.of(1),
      asymmetry: 0,
    }
    const grid: SourceGrid = { ...AXES, suns: 2, nodes: 2 }
    for (const bearings of [MIDPOINT_BEARINGS, { count: 5, ends: true }]) {
      let cells = 0
      sourceSamples(medium, grid, 8, { bearings }, (cell, samples, at) => {
        cells += 1
        expect(samples).toHaveLength(8 * bearings.count)
        expect(at.sunMu).toBe(nodeSun(grid, cell.sun))
        // Downward directions first, each cosine at every bearing.
        expect(at.muV[0]).toBe(-at.cosines[0]!)
        expect(at.muV[4 * bearings.count]).toBe(at.cosines[0]!)
        expect(at.azimuths[0]).toBeCloseTo(bearings.ends ? 0 : Math.PI / 32, 12)
        expect(at.azimuths.at(-1)).toBeCloseTo(
          bearings.ends ? Math.PI : Math.PI - Math.PI / 32,
          12,
        )
        // The measures sum to the sphere's 4π.
        expect(at.solid.reduce((sum, value) => sum + value, 0)).toBeCloseTo(
          4 * Math.PI,
          10,
        )
        for (let k = 0; k < samples.length; k += 1) {
          const mu = Math.abs(at.muV[k]!)
          const azimuth = at.azimuths[k % bearings.count]!
          expect(at.along[k]).toBeCloseTo(
            Math.sqrt(1 - mu * mu) * Math.cos(azimuth),
            12,
          )
          expect(at.nu[k]).toBeCloseTo(
            scatteringCosine(
              at.sunMu,
              mu,
              azimuth,
              at.muV[k]! < 0 ? 'transmitted' : 'reflected',
            ),
            12,
          )
          // An isotropic source has no bearing in it.
          expect(samples[k]).toBeCloseTo(samples[k - (k % bearings.count)]!, 12)
        }
      })
      expect(cells).toBe(2 * 2 * 2)
    }
  })
})
