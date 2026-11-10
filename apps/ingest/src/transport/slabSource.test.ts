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
  depthCoordinate,
  higherOrders,
  lobe,
  nodeDepth,
  nodeSun,
  readSource,
  sourceTerms,
  type SourceGrid,
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
  it('is exact for terms that are linear along each axis', () => {
    const grid: SourceGrid = { ...AXES, nodes: 6 }
    const terms = new Float64Array(3 * 6 * 6 * 3)
    for (let sun = 0; sun < 3; sun += 1)
      for (let bottom = 0; bottom < 6; bottom += 1)
        for (let top = 0; top < 6; top += 1) {
          const cell = ((sun * 6 + bottom) * 6 + top) * 3
          terms[cell] = 1 + 2 * (top / 5) - bottom / 5 + 3 * nodeSun(grid, sun)
          terms[cell + 1] = top / 5
          terms[cell + 2] = (bottom / 5) * nodeSun(grid, sun)
        }
    const table: SourceTable = { ...grid, terms }
    const out = new Float64Array(3)
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 16, noNaN: true }),
        fc.double({ min: 0, max: 16, noNaN: true }),
        fc.double({ min: 0.2, max: 1, noNaN: true }),
        (top, bottom, sunMu) => {
          readSource(table, top, bottom, sunMu, out)
          const x = depthCoordinate(grid, top)
          const y = depthCoordinate(grid, bottom)
          expect(out[0]).toBeCloseTo(1 + 2 * x - y + 3 * sunMu, 10)
          expect(out[1]).toBeCloseTo(x, 10)
          expect(out[2]).toBeCloseTo(y * sunMu, 10)
        },
      ),
    )
    // Past either end the read holds the end's value, as a clamped texture does.
    readSource(table, 99, 0, 0.01, out)
    expect(out[0]).toBeCloseTo(1 + 2 + 3 * 0.2, 12)
  })
})

describe('the march’s integral through the table', () => {
  const flat = (j0: number, j1: number, jf: number): SourceTable => {
    const terms = new Float64Array(3 * 4 * 4 * 3)
    for (let cell = 0; cell < 3 * 4 * 4; cell += 1)
      terms.set([j0, j1, jf], cell * 3)
    return { ...AXES, nodes: 4, terms }
  }
  const view = { depth: 3, sunMu: 0.6, viewMu: 0.4, azimuth: 30 } as const

  it('is 1 − e^(−τ/μ) of a source that is the same everywhere, from either face', () => {
    const whole = 1 - Math.exp(-3 / 0.4)
    for (const side of ['reflected', 'transmitted'] as const) {
      expect(
        higherOrders(flat(2, 0, 0), { ...view, side }, 0.7, 0.5),
      ).toBeCloseTo(2 * whole, 10)
      // J₁ rides the cosine of light traveling to the eye about the lit
      // face's normal: toward it in reflection, away in transmission.
      expect(
        higherOrders(flat(0, 1, 0), { ...view, side }, 0.7, 0.5),
      ).toBeCloseTo((side === 'reflected' ? 0.4 : -0.4) * whole, 10)
      const nu = scatteringCosine(0.6, 0.4, Math.PI / 6, side)
      expect(
        higherOrders(flat(0, 0, 1), { ...view, side }, 0.7, 0.5),
      ).toBeCloseTo(lobe(nu, 0.5) * whole, 10)
    }
  })

  it('has a lobe of zero mean over the sphere, so J₀ alone is the source’s mean', () => {
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
    const terms = sourceTerms(
      { moments, convolved: moments, asymmetry: g, albedo },
      grid,
      g * g,
      streams,
      {
        columns: [grid.nodes - 1],
        inspect: (cell, source) => {
          for (const i of picks)
            for (const a of bearing) {
              const key = `${cell.sun} ${i} ${a}`
              const along = kept.get(key) ?? []
              // Upward directions follow the four downward ones.
              along[cell.top] = source[(streams / 2 + i) * 16 + a]!
              kept.set(key, along)
            }
        },
      },
    )
    expect(terms.delta).toBeCloseTo(g ** streams, 12)
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

  it('is three terms exactly where scattering is isotropic, so a slab rebuilds to the table’s read', () => {
    const grid: SourceGrid = { ...AXES, nodes: 24 }
    const terms = sourceTerms(
      {
        moments: Float64Array.of(1),
        convolved: Float64Array.of(1),
        asymmetry: 0,
      },
      grid,
      0.3,
      16,
    )
    // An isotropic source has no cosine and no lobe in it, by either measure.
    for (let cell = 0; cell < terms.absolute.length; cell += 3) {
      expect(Math.abs(terms.absolute[cell + 1]!)).toBeLessThan(1e-9)
      expect(Math.abs(terms.absolute[cell + 2]!)).toBeLessThan(1e-9)
      expect(terms.relative[cell]).toBeCloseTo(terms.absolute[cell]!, 9)
      expect(terms.absolutePlain[cell]).toBeCloseTo(terms.absolute[cell]!, 9)
    }
    const table: SourceTable = { ...grid, terms: terms.absolute }
    const depths = [0.5, 2, 5, 12]
    // The table's own suns, so the read is between depth nodes alone.
    const suns = [1, 0.6, 0.2]
    const views = [0.3, 0.7, 1]
    const oracle = solveSlab({
      medium: { moments: [1] },
      depths,
      suns,
      views,
      azimuths: [0],
      streams: 32,
    })
    let cell = 0
    for (const depth of depths)
      for (const sunMu of suns)
        for (const viewMu of views) {
          for (const side of ['reflected', 'transmitted'] as const) {
            const rebuilt =
              firstOrder(depth, sunMu, viewMu, side) / (4 * Math.PI) +
              higherOrders(
                table,
                { depth, sunMu, viewMu, azimuth: 0, side },
                0,
                0.3,
              )
            // What is left is the read between 24 nodes a depth axis:
            // measured, 0.55% at worst, through the deepest slab.
            expect(Math.abs(rebuilt / oracle[side][cell]! - 1)).toBeLessThan(
              0.01,
            )
          }
          cell += 1
        }
  })

  it('leaves the nodes it was not asked for at zero', () => {
    const grid: SourceGrid = { ...AXES, nodes: 6 }
    const medium = {
      moments: henyeyGreensteinMoments(0.5, 40),
      convolved: henyeyGreensteinMoments(0.5, 40),
      asymmetry: 0.5,
    }
    const part = sourceTerms(medium, grid, 0.25, 8, { rows: [2], columns: [4] })
    for (let sun = 0; sun < 3; sun += 1)
      for (let bottom = 0; bottom < 6; bottom += 1)
        for (let top = 0; top < 6; top += 1) {
          const value = part.absolute[((sun * 6 + bottom) * 6 + top) * 3]!
          if (top === 2 && bottom === 4) expect(value).toBeGreaterThan(0)
          else expect(value).toBe(0)
        }
  })
})
