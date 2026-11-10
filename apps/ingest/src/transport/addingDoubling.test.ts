import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DISORT_MIE, IAD_HENYEY_GREENSTEIN } from './addingDoubling.fixtures.ts'
import {
  addLayers,
  firstOrder,
  layersAt,
  modePhase,
  scatteringCosine,
  slabNodes,
  solveInPlace,
  solveSlab,
  truncate,
} from './addingDoubling.ts'
import {
  halfRangeGauss,
  henyeyGreenstein,
  henyeyGreensteinMoments,
  phaseOf,
} from './legendre.ts'

/*
 * The oracle is held to what it did not compute: its own invariants (flux,
 * reciprocity, the adding identity), two closed forms (first order, and
 * Chandrasekhar's H-functions for a deep isotropic slab), and two other
 * people's solvers (`addingDoubling.fixtures.ts`).
 */

const hg = (g: number): Float64Array => henyeyGreensteinMoments(g, 80)

describe('a slab’s flux', () => {
  it('is conserved at albedo one: what leaves the two faces is what arrived, to 10⁻⁶', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.92, noNaN: true }),
        fc.double({ min: 0.05, max: 64, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (g, depth, sun) => {
          // Sixteen streams against eighty moments: delta-M is in the property.
          const slab = solveSlab({
            medium: { moments: hg(g) },
            depths: [depth],
            suns: [sun],
            views: [],
            azimuths: [],
            streams: 16,
          })
          expect(
            Math.abs(slab.albedo[0]! + slab.transmittance[0]! - 1),
          ).toBeLessThan(1e-6)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('is lost by exactly the absorbed share where the albedo is under one', () => {
    const slab = solveSlab({
      medium: { moments: hg(0.75), albedo: 0.9 },
      depths: [0.5, 8],
      suns: [1, 0.3],
      views: [],
      azimuths: [],
      streams: 32,
    })
    for (let i = 0; i < 4; i += 1) {
      const kept = slab.albedo[i]! + slab.transmittance[i]!
      expect(kept).toBeLessThan(1)
      expect(kept).toBeGreaterThan(0)
    }
    // A deeper slab absorbs more of the same beam.
    expect(slab.albedo[2]! + slab.transmittance[2]!).toBeLessThan(
      slab.albedo[0]! + slab.transmittance[0]!,
    )
  })

  it('equals iadpython’s for a Henyey–Greenstein slab at g = 0.75 and 0.875, within 0.5%', () => {
    const diffuse = halfRangeGauss(8)
    for (const row of IAD_HENYEY_GREENSTEIN.rows) {
      const slab = solveSlab({
        medium: { moments: hg(row.g), albedo: row.albedo },
        depths: [row.depth],
        suns: [1, ...diffuse.nodes],
        views: [],
        azimuths: [],
        streams: 32,
      })
      expect(slab.albedo[0]! / row.ur1 - 1).toBeCloseTo(0, 2)
      expect(Math.abs(slab.albedo[0]! / row.ur1 - 1)).toBeLessThan(0.005)
      expect(Math.abs(slab.transmittance[0]! / row.ut1 - 1)).toBeLessThan(0.005)
      // Diffuse light is every cosine weighted by 2·μ.
      let uru = 0
      let utu = 0
      diffuse.nodes.forEach((mu, k) => {
        uru += 2 * mu * diffuse.weights[k]! * slab.albedo[k + 1]!
        utu += 2 * mu * diffuse.weights[k]! * slab.transmittance[k + 1]!
      })
      expect(Math.abs(uru / row.uru - 1)).toBeLessThan(0.005)
      expect(Math.abs(utu / row.utu - 1)).toBeLessThan(0.005)
    }
  })
})

describe('a slab’s radiance', () => {
  it('is reciprocal: I(μ ← μ₀)/μ₀ = I(μ₀ ← μ)/μ on both faces', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.85, noNaN: true }),
        fc.double({ min: 0.1, max: 16, noNaN: true }),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 180, noNaN: true }),
        (g, depth, a, b, azimuth) => {
          fc.pre(Math.abs(a - b) > 1e-3)
          const slab = solveSlab({
            medium: { moments: hg(g) },
            depths: [depth],
            suns: [a, b],
            views: [a, b],
            azimuths: [azimuth],
            streams: 16,
          })
          // [sun][view]: (a ← b) is sun b, view a.
          for (const field of [slab.reflected, slab.transmitted]) {
            const ab = field[2]! / b
            const ba = field[1]! / a
            expect(Math.abs(ab - ba)).toBeLessThan(1e-9 * Math.abs(ab) + 1e-12)
          }
        },
      ),
      { numRuns: 25 },
    )
  })

  it('is first order alone in a thin slab: ω·p(Θ)·τ/μ', () => {
    const depth = 1e-5
    const slab = solveSlab({
      medium: { moments: hg(0.6), albedo: 0.8 },
      depths: [depth],
      suns: [0.7],
      views: [0.4],
      azimuths: [0, 120],
      streams: 16,
    })
    ;[0, 120].forEach((azimuth, a) => {
      for (const side of ['reflected', 'transmitted'] as const) {
        const cosine = scatteringCosine(
          0.7,
          0.4,
          (azimuth * Math.PI) / 180,
          side,
        )
        const thin = (0.8 * henyeyGreenstein(cosine, 0.6) * depth) / 0.4
        // What is left out is of the next order in τ/μ, 10⁻⁴ of the term.
        expect(Math.abs(slab[side][a]! / thin - 1)).toBeLessThan(1e-4)
      }
    })
  })

  it('is Chandrasekhar’s H-functions for a deep isotropic slab: (ω/4π)·μ₀·H(μ)·H(μ₀)/(μ + μ₀)', () => {
    const albedo = 0.8
    // H(μ) = 1/(√(1 − ω) + (ω/2)·∫μ′·H(μ′)/(μ + μ′) dμ′), iterated on its own rule.
    const rule = halfRangeGauss(64)
    const h = new Float64Array(64).fill(1)
    const at = (mu: number): number => {
      let sum = 0
      for (let j = 0; j < 64; j += 1)
        sum +=
          (rule.weights[j]! * rule.nodes[j]! * h[j]!) / (mu + rule.nodes[j]!)
      return 1 / (Math.sqrt(1 - albedo) + (albedo / 2) * sum)
    }
    for (let pass = 0; pass < 400; pass += 1) h.set(rule.nodes.map(at))
    const cosines = [1, 0.6, 0.25]
    // e^(−2kτ) with k = 0.71 at this albedo is 10⁻²⁵ at a depth of 40.
    const slab = solveSlab({
      medium: { moments: [1], albedo },
      depths: [40],
      suns: cosines,
      views: cosines,
      azimuths: [0],
      streams: 32,
    })
    cosines.forEach((sun, s) =>
      cosines.forEach((view, v) => {
        const exact =
          ((albedo / (4 * Math.PI)) * sun * at(view) * at(sun)) / (view + sun)
        expect(Math.abs(slab.reflected[s * 3 + v]! / exact - 1)).toBeLessThan(
          1e-6,
        )
      }),
    )
  })

  it('equals PythonicDISORT’s for the Mie droplets at its own cosines, within 0.5% over the domain', () => {
    const moments = Float64Array.from(DISORT_MIE.moments)
    const depths = [5, 10, 20]
    const suns = [1, 0.5, 0.2]
    const views = [...new Set<number>(DISORT_MIE.rows.map((row) => row.viewMu))]
    const slab = solveSlab({
      medium: { moments },
      depths,
      suns,
      views,
      azimuths: DISORT_MIE.azimuths,
      streams: DISORT_MIE.streams,
    })
    let checked = 0
    for (const row of DISORT_MIE.rows) {
      const at =
        (depths.indexOf(row.depth) * 3 + suns.indexOf(row.sunMu)) *
          views.length +
        views.indexOf(row.viewMu)
      DISORT_MIE.azimuths.forEach((azimuth, a) => {
        for (const side of ['reflected', 'transmitted'] as const) {
          const angle =
            (Math.acos(
              Math.max(
                -1,
                scatteringCosine(
                  row.sunMu,
                  row.viewMu,
                  (azimuth * Math.PI) / 180,
                  side,
                ),
              ),
            ) *
              180) /
            Math.PI
          // The fixture's second correction is the forward cone's; the
          // rubric's domain leaves the cone out, and so does this.
          if (side === 'transmitted' && angle <= 6) continue
          const mine = slab[side][at * 3 + a]!
          expect(Math.abs(mine / row[side][a]! - 1)).toBeLessThan(0.005)
          checked += 1
        }
      })
    }
    expect(checked).toBeGreaterThan(200)
    for (const row of DISORT_MIE.albedo)
      expect(
        Math.abs(
          slab.albedo[
            depths.indexOf(row.depth) * 3 + suns.indexOf(row.sunMu)
          ]! - row.albedo,
        ),
      ).toBeLessThan(1e-6)
  })

  it('converges with its streams at g = 0.875: within 2.5% at sixteen, 0.2% at thirty-two', () => {
    const query = {
      medium: { moments: henyeyGreensteinMoments(0.875, 300) },
      depths: [2, 16],
      suns: [0.6],
      views: [0.3, 0.9],
      azimuths: [90, 180],
    }
    const fine = solveSlab({ ...query, streams: 64 })
    // 0.875¹⁶ = 0.12 of the phase is a delta at sixteen streams and 0.014
    // at thirty-two. First order is exact at any count, so what moves is
    // the light scattered twice or more through the truncated phase:
    // measured, 1.9% at worst at sixteen (the thin slab's transmitted light
    // 79° from the sun) and 0.10% at thirty-two.
    for (const [streams, bound] of [
      [16, 0.025],
      [32, 0.002],
    ] as const) {
      const coarse = solveSlab({ ...query, streams })
      expect(coarse.delta).toBeCloseTo(0.875 ** streams, 12)
      for (let i = 0; i < coarse.reflected.length; i += 1) {
        expect(
          Math.abs(coarse.reflected[i]! / fine.reflected[i]! - 1),
        ).toBeLessThan(bound)
        expect(
          Math.abs(coarse.transmitted[i]! / fine.transmitted[i]! - 1),
        ).toBeLessThan(bound)
      }
    }
  })
})

describe('the pieces', () => {
  it('rebuild a phase function from its modes: Σ_m (2 − δ_m0)·P^m·cos mφ = 4π·p(cos Θ)', () => {
    const moments = hg(0.7).subarray(0, 24)
    const nodes = slabNodes(16, [0.3, 0.9])
    const n = nodes.size
    for (const [i, j, phi] of [
      [8, 9, 0.4],
      [2, 9, 2.1],
      [5, 6, 3],
    ] as const) {
      let same = 0
      let opposite = 0
      for (let m = 0; m < moments.length; m += 1) {
        const mode = modePhase(m, moments, nodes)
        same += (m === 0 ? 1 : 2) * mode.same[i * n + j]! * Math.cos(m * phi)
        opposite +=
          (m === 0 ? 1 : 2) * mode.opposite[i * n + j]! * Math.cos(m * phi)
      }
      const [a, b] = [nodes.mu[i]!, nodes.mu[j]!]
      const cross = Math.sqrt(1 - a * a) * Math.sqrt(1 - b * b) * Math.cos(phi)
      expect(same).toBeCloseTo(
        4 * Math.PI * phaseOf(moments, a * b + cross),
        10,
      )
      expect(opposite).toBeCloseTo(
        4 * Math.PI * phaseOf(moments, cross - a * b),
        10,
      )
    }
  })

  it('add two layers into the layer doubling makes, and keep the net flux through the plane between', () => {
    const nodes = slabNodes(16, [0.5])
    const phase = modePhase(0, hg(0.6).subarray(0, 16), nodes)
    const [one, two, three] = layersAt(phase, 1, [1, 2, 3], nodes)
    const sum = addLayers(one!, two!, nodes)
    for (let i = 0; i < three!.r.length; i += 1) {
      expect(sum.layer.r[i]!).toBeCloseTo(three!.r[i]!, 10)
      expect(sum.layer.t[i]!).toBeCloseTo(three!.t[i]!, 10)
    }
    // At albedo one the net flux is the same at every depth: what crosses
    // the plane downward, beam included, less what crosses it upward, is
    // what the whole slab does not reflect.
    const n = nodes.size
    const j = n - 1
    let down = one!.e[j]!
    let up = 0
    let reflected = 0
    for (let k = 0; k < nodes.quadrature; k += 1) {
      down += nodes.flux[k]! * sum.down[k * n + j]!
      up += nodes.flux[k]! * sum.up[k * n + j]!
      reflected += nodes.flux[k]! * sum.layer.r[k * n + j]!
    }
    expect(Math.abs(down - up - (1 - reflected))).toBeLessThan(1e-7)
  })

  it('truncate by delta-M, and leave a phase function that fits alone', () => {
    const cut = truncate({ moments: hg(0.8), albedo: 0.9 }, 8)
    const delta = 0.8 ** 8
    expect(cut.delta).toBe(delta)
    expect(cut.moments).toHaveLength(8)
    expect(cut.moments[0]).toBeCloseTo(1, 15)
    expect(cut.moments[3]).toBeCloseTo((0.8 ** 3 - delta) / (1 - delta), 15)
    expect(cut.albedo).toBeCloseTo((0.9 * (1 - delta)) / (1 - 0.9 * delta), 15)
    expect(cut.depthScale).toBeCloseTo(1 - 0.9 * delta, 15)
    const whole = truncate({ moments: [1, 0.3] }, 8)
    expect([whole.delta, whole.albedo, whole.depthScale]).toEqual([0, 1, 1])
    expect([...whole.moments]).toEqual([1, 0.3])
  })

  it('solve a linear system with a zero on its diagonal', () => {
    const m = Float64Array.of(0, 2, 1, 1, 1, 0, 3, 0, 1)
    const rhs = Float64Array.of(5, 10, 3, 6, 6, 8)
    solveInPlace(m.slice(), rhs, 3, 2)
    for (let column = 0; column < 2; column += 1)
      for (let i = 0; i < 3; i += 1) {
        let sum = 0
        for (let k = 0; k < 3; k += 1)
          sum += m[i * 3 + k]! * rhs[k * 2 + column]!
        expect(sum).toBeCloseTo([5, 3, 6, 10, 6, 8][column * 3 + i]!, 12)
      }
    expect(() =>
      solveInPlace(Float64Array.of(1, 2, 2, 4), Float64Array.of(1, 1), 2, 1),
    ).toThrow(/singular/)
  })

  it('put the domain’s three special points where the rubric says they are', () => {
    const degrees = (cosine: number): number =>
      (Math.acos(cosine) * 180) / Math.PI
    // The glory's center, twice, and a row a degree from the cloudbow.
    expect(degrees(scatteringCosine(1, 1, 0, 'reflected'))).toBeCloseTo(180, 6)
    expect(
      degrees(Math.max(-1, scatteringCosine(0.2, 0.2, Math.PI, 'reflected'))),
    ).toBeCloseTo(180, 4)
    expect(degrees(scatteringCosine(1, 0.8, 0, 'reflected'))).toBeCloseTo(
      143.13,
      2,
    )
    expect(degrees(scatteringCosine(0.5, 0.4, 0, 'transmitted'))).toBeCloseTo(
      6.42,
      2,
    )
  })

  it('carry first order through the view that is the sun’s own cosine', () => {
    const at = firstOrder(3, 0.5, 0.5, 'transmitted')
    expect(at).toBeCloseTo((3 / 0.5) * Math.exp(-3 / 0.5), 14)
    expect(firstOrder(3, 0.5, 0.5 + 1e-7, 'transmitted')).toBeCloseTo(at, 6)
    expect(firstOrder(3, 0.5, 0.25, 'reflected')).toBeCloseTo(
      (0.5 * (1 - Math.exp(-3 / 0.5 - 3 / 0.25))) / 0.75,
      14,
    )
  })

  it('refuse a stream count that is odd, and a cosine that is not one', () => {
    expect(() => slabNodes(7)).toThrow(/even stream count/)
    expect(() => slabNodes(8, [0])).toThrow(/cosine/)
  })
})
