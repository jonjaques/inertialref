import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  associatedInto,
  capMoments,
  fraunhoferMomentsInto,
  gaussLegendre,
  halfRangeGauss,
  henyeyGreenstein,
  henyeyGreensteinMoments,
  legendreInto,
  phaseOf,
} from './legendre.ts'

/** Float64's rounding through a sum of a few hundred terms of order one. */
const ROUNDING = 1e-12

describe('Gauss–Legendre', () => {
  it('integrates every monomial a rule of n nodes can, exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 48 }),
        fc.nat({ max: 95 }),
        (count, power) => {
          fc.pre(power <= 2 * count - 1)
          const { nodes, weights } = gaussLegendre(count)
          let sum = 0
          for (let i = 0; i < count; i += 1)
            sum += weights[i]! * nodes[i]! ** power
          const exact = power % 2 === 0 ? 2 / (power + 1) : 0
          expect(Math.abs(sum - exact)).toBeLessThan(ROUNDING)
        },
      ),
    )
  })

  it('fails the first monomial past its degree, so the property above is not vacuous', () => {
    const { nodes, weights } = gaussLegendre(4)
    let sum = 0
    for (let i = 0; i < 4; i += 1) sum += weights[i]! * nodes[i]! ** 8
    expect(Math.abs(sum - 2 / 9)).toBeGreaterThan(1e-3)
  })

  it('lays its nodes ascending and symmetric, and holds a thousand of them', () => {
    const { nodes, weights } = gaussLegendre(1001)
    for (let i = 1; i < nodes.length; i += 1)
      expect(nodes[i]!).toBeGreaterThan(nodes[i - 1]!)
    for (let i = 0; i < nodes.length; i += 1) {
      expect(nodes[i]! + nodes[nodes.length - 1 - i]!).toBe(0)
      expect(weights[i]!).toBeGreaterThan(0)
    }
    expect(nodes[500]).toBe(0)
    expect(weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(2, 13)
  })

  it('puts a hemisphere’s rule on (0, 1) and integrates its flux, 2∫μ dμ = 1', () => {
    const { nodes, weights } = halfRangeGauss(16)
    expect(nodes[0]!).toBeGreaterThan(0)
    expect(nodes[15]!).toBeLessThan(1)
    let flux = 0
    for (let i = 0; i < 16; i += 1) flux += 2 * nodes[i]! * weights[i]!
    expect(Math.abs(flux - 1)).toBeLessThan(ROUNDING)
  })
})

describe('the associated functions', () => {
  it('obey the addition theorem: Σ_m (2 − δ_m0)·Y_l^m(a)·Y_l^m(b)·cos mφ = P_l(cos γ)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 80 }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: Math.PI, noNaN: true }),
        (l, a, b, phi) => {
          let sum = 0
          for (let m = 0; m <= l; m += 1) {
            const ya = new Float64Array(l - m + 1)
            const yb = new Float64Array(l - m + 1)
            associatedInto(m, l, a, ya)
            associatedInto(m, l, b, yb)
            sum +=
              (m === 0 ? 1 : 2) * ya[l - m]! * yb[l - m]! * Math.cos(m * phi)
          }
          const between =
            a * b + Math.sqrt(1 - a * a) * Math.sqrt(1 - b * b) * Math.cos(phi)
          const p = new Float64Array(l + 1)
          legendreInto(between, l + 1, p)
          expect(Math.abs(sum - p[l]!)).toBeLessThan(ROUNDING)
        },
      ),
    )
  })

  it('stay finite at an order where the unnormalized function has left float64', () => {
    const out = new Float64Array(101)
    associatedInto(400, 500, 0.3, out)
    for (const value of out) {
      expect(Number.isFinite(value)).toBe(true)
      expect(Math.abs(value)).toBeLessThanOrEqual(1)
    }
  })
})

describe('a phase function from its moments', () => {
  it('is Henyey–Greenstein’s closed form from g^l', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -0.9, max: 0.9, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (g, mu) => {
          // g^l is under float64's rounding of the sum long before 600 terms.
          const series = phaseOf(henyeyGreensteinMoments(g, 600), mu)
          const closed = henyeyGreenstein(mu, g)
          expect(Math.abs(series - closed)).toBeLessThan(1e-10 * closed + 1e-12)
        },
      ),
    )
  })
})

describe('a cap’s moments', () => {
  it('are one for a point, and c₁ = (1 + cos α)/2 for any cap', () => {
    expect([...capMoments(0, 6)]).toEqual([1, 1, 1, 1, 1, 1])
    fc.assert(
      fc.property(fc.double({ min: 1e-4, max: 1.5, noNaN: true }), (alpha) => {
        const c = capMoments(alpha, 4)
        expect(c[0]).toBe(1)
        // The mean of cos θ over a uniform cap; 10⁻⁸ is the difference
        // P₀ − P₂ at a cap of 10⁻⁴ rad, eight digits under one.
        expect(Math.abs(c[1]! - (1 + Math.cos(alpha)) / 2)).toBeLessThan(1e-8)
      }),
    )
  })

  it('blur more at a higher order, and by (lα)²/8 while lα is small', () => {
    const alpha = 0.00465
    const c = capMoments(alpha, 400)
    for (let l = 1; l < 400; l += 1) expect(c[l]!).toBeLessThan(c[l - 1]!)
    // J₁(z)·2/z = 1 − z²/8 + z⁴/192: at l = 100, z = 0.47 and the next term is 2.5 × 10⁻⁴.
    expect(c[100]!).toBeCloseTo(1 - (100.5 * alpha) ** 2 / 8, 3)
  })
})

describe('the Fraunhofer pattern’s moments', () => {
  /** J₁ by its integral, (1/π)·∫cos(t − z·sin t) dt over [0, π], on a rule that resolves z ≤ 200. */
  const rule = gaussLegendre(256)
  const besselJ1 = (z: number): number => {
    let sum = 0
    for (let i = 0; i < rule.nodes.length; i += 1) {
      const t = (Math.PI / 2) * (rule.nodes[i]! + 1)
      sum += rule.weights[i]! * Math.cos(t - z * Math.sin(t))
    }
    return sum / 2
  }

  it('are the Airy pattern’s own, to the small-angle form’s 1/x', () => {
    const x = 60
    const moments = new Float64Array(140)
    fraunhoferMomentsInto(x, 1, moments)
    expect(moments[0]).toBeCloseTo(1, 14)
    // χ_l = 2π·∫p·P_l sin θ dθ of p ∝ (2J₁(x·sin θ)/(x·sin θ))² over the
    // forward hemisphere, in 40 panels of 16 nodes: the pattern has 19 rings.
    const panel = gaussLegendre(16)
    const direct = new Float64Array(140)
    const p = new Float64Array(140)
    for (let k = 0; k < 40; k += 1)
      for (let i = 0; i < 16; i += 1) {
        const theta = ((Math.PI / 2) * (k + (panel.nodes[i]! + 1) / 2)) / 40
        const z = x * Math.sin(theta)
        const airy = z < 1e-6 ? 1 : ((2 * besselJ1(z)) / z) ** 2
        legendreInto(Math.cos(theta), 140, p)
        const w = panel.weights[i]! * Math.sin(theta) * airy
        for (let l = 0; l < 140; l += 1) direct[l] = direct[l]! + w * p[l]!
      }
    for (const l of [1, 5, 20, 60, 100, 119]) {
      const exact = direct[l]! / direct[0]!
      // The limit is the form's own: P_l(cos θ) for J₀((l + ½)θ) costs 1/x,
      // 0.017 here, and nothing an error in the closed form would hide in:
      // the overlap of two disks without its square root is 0.1 off at l = 60.
      expect(Math.abs(moments[l]! - exact)).toBeLessThan(1 / x)
    }
  })

  it('fall monotonically to zero at l = 2x, and add by weight', () => {
    const moments = new Float64Array(200)
    fraunhoferMomentsInto(40, 0.25, moments)
    fraunhoferMomentsInto(40, 0.75, moments)
    expect(moments[0]).toBeCloseTo(1, 14)
    for (let l = 1; l < 80; l += 1)
      expect(moments[l]!).toBeLessThan(moments[l - 1]!)
    for (let l = 80; l < 200; l += 1) expect(moments[l]).toBe(0)
  })
})
