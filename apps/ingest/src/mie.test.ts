import { describe, expect, it } from 'vitest'
import {
  amplitudes,
  angularTable,
  cie1931,
  efficiencies,
  linearSrgb,
  mieSeries,
  mirroredIntensities,
  phase,
  rings,
  whiteLightRedness,
} from './mie.ts'
import { waterIndex } from './mieTable.ts'

const radians = (degrees: number) => (degrees * Math.PI) / 180
const intensity = ({ s1, s2 }: ReturnType<typeof amplitudes>) =>
  s1[0] ** 2 + s1[1] ** 2 + s2[0] ** 2 + s2[1] ** 2

/** Gauss–Legendre nodes and weights on [−1, 1], by Newton on P_n. */
function gaussLegendre(n: number): { nodes: number[]; weights: number[] } {
  const nodes: number[] = []
  const weights: number[] = []
  for (let i = 1; i <= n; i += 1) {
    let x = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5))
    let derivative = 0
    for (let step = 0; step < 100; step += 1) {
      let p0 = 1
      let p1 = x
      for (let k = 2; k <= n; k += 1) {
        const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k
        p0 = p1
        p1 = p2
      }
      derivative = (n * (x * p1 - p0)) / (x * x - 1)
      const dx = p1 / derivative
      x -= dx
      if (Math.abs(dx) < 1e-16) break
    }
    nodes.push(x)
    weights.push(2 / ((1 - x * x) * derivative * derivative))
  }
  return { nodes, weights }
}

describe('the Lorenz–Mie series', () => {
  it('meets the Rayleigh limit, p = 3(1 + cos²θ)/(16π), at x = 0.01', () => {
    // The dipole is exact only as x → 0: a₂ and b₁ enter at x² relative to
    // a₁, 4.4 × 10⁻⁵ of the shape at x = 0.01 measured.
    const series = mieSeries(0.01, 1.33)
    const { scattering } = efficiencies(series)
    for (let i = 0; i <= 36; i += 1) {
      const mu = Math.cos(radians(5 * i))
      const rayleigh = (3 * (1 + mu * mu)) / (16 * Math.PI)
      expect(
        Math.abs(phase(series, mu, scattering) / rayleigh - 1),
      ).toBeLessThan(1e-4)
    }
  })

  it('prints what Bohren and Huffman’s Appendix A prints for m = 1.55, x = 5.213', () => {
    // Bohren and Huffman (1983), p. 482: a sphere of radius 0.525 at 0.6328 in
    // a medium of index 1, so x = 2π·0.525/0.6328 = 5.2128 (printed 5.213).
    // The printout carries six significant digits from a program that is
    // single precision outside ψ_n and D_n: Q_sca = Q_ext = 3.10543 and
    // Q_back = 2.92534 meet these to −1.4 × 10⁻⁶ and 2.2 × 10⁻⁷, and every
    // matrix element below to one unit in its sixth digit.
    const series = mieSeries((2 * Math.PI * 0.525) / 0.6328, 1.55)
    const q = efficiencies(series)
    expect(Math.abs(q.scattering / 3.10543 - 1)).toBeLessThan(1e-5)
    expect(Math.abs(q.extinction / 3.10543 - 1)).toBeLessThan(1e-5)
    expect(Math.abs(q.back / 2.92534 - 1)).toBeLessThan(1e-5)
    // Angle, S11 (normalized forward), POL, S33, S34.
    const printout = [
      [0, 0.1e1, 0, 0.1e1, 0],
      [9, 0.78539, -0.459811e-2, 0.9994, 0.343261e-1],
      [18, 0.356897, -0.458541e-1, 0.986022, 0.160184],
      [27, 0.766119e-1, -0.364744, 0.843603, 0.394076],
      [36, 0.355355e-1, -0.534997, 0.686967, -0.491787],
      [45, 0.701845e-1, 0.959953e-2, 0.959825, -0.280434],
      [54, 0.574313e-1, 0.477927e-1, 0.985371, 0.163584],
      [63, 0.21966e-1, -0.440604, 0.648043, 0.621216],
      [72, 0.125959e-1, -0.831996, 0.203255, -0.516208],
      [81, 0.17375e-1, 0.34167e-1, 0.795354, -0.605182],
      [90, 0.124601e-1, 0.230462, 0.937497, 0.260742],
      [99, 0.679093e-2, -0.713472, -0.717397e-2, 0.700647],
      [108, 0.954239e-2, -0.756255, -0.394748e-1, -0.653085],
      [117, 0.863419e-2, -0.281215, 0.536251, -0.795835],
      [126, 0.227421e-2, -0.239612, 0.967602, 0.795798e-1],
      [135, 0.543998e-2, -0.850804, 0.187531, -0.490882],
      [144, 0.160243e-1, -0.706334, 0.495254, -0.505781],
      [153, 0.188852e-1, -0.891081, 0.453277, -0.226817e-1],
      [162, 0.195254e-1, -0.783319, -0.391613, 0.482752],
      [171, 0.301676e-1, -0.196194, -0.962069, 0.189556],
      [180, 0.383189e-1, 0, -0.1e1, 0],
    ] as const
    const unit = (v: number) =>
      v === 0 ? 1e-12 : 10 ** (Math.floor(Math.log10(Math.abs(v))) - 5)
    const forward = intensity(amplitudes(series, 1)) / 2
    for (const [angle, ...printed] of printout) {
      const { s1, s2 } = amplitudes(series, Math.cos(radians(angle)))
      const i1 = s1[0] ** 2 + s1[1] ** 2
      const i2 = s2[0] ** 2 + s2[1] ** 2
      const s11 = (i1 + i2) / 2
      // S₂S₁*: B&H's S33 is its real part, S34 its imaginary, over S11.
      const re = s2[0] * s1[0] + s2[1] * s1[1]
      const im = s2[1] * s1[0] - s2[0] * s1[1]
      const mine = [s11 / forward, (i1 - i2) / 2 / s11, re / s11, im / s11]
      mine.forEach((value, k) =>
        expect(Math.abs(value - printed[k]!)).toBeLessThanOrEqual(
          unit(printed[k]!),
        ),
      )
    }
  })

  it('holds the optical theorem, Q_ext = (4/x²)·Re S₁(0)', () => {
    // Q_ext is summed from a_n + b_n and S₁(0) from π_n(1) = τ_n(1) =
    // n(n + 1)/2, so this is the angular functions against the coefficients:
    // 3.5 × 10⁻¹³ apart at x = 500 measured.
    for (const x of [5, 50, 500]) {
      const series = mieSeries(x, 1.33)
      const { s1 } = amplitudes(series, 1)
      const theorem = (4 / (x * x)) * s1[0]
      expect(
        Math.abs(efficiencies(series).extinction / theorem - 1),
      ).toBeLessThan(1e-9)
    }
  })

  it('has S₁ = S₂ straight ahead and S₁ = −S₂ straight back', () => {
    for (const x of [5, 50, 500]) {
      const series = mieSeries(x, 1.33)
      const ahead = amplitudes(series, 1)
      const back = amplitudes(series, -1)
      const size = (z: readonly [number, number]) => Math.hypot(z[0], z[1])
      expect(
        Math.hypot(ahead.s1[0] - ahead.s2[0], ahead.s1[1] - ahead.s2[1]) /
          size(ahead.s1),
      ).toBeLessThan(1e-9)
      expect(
        Math.hypot(back.s1[0] + back.s2[0], back.s1[1] + back.s2[1]) /
          size(back.s1),
      ).toBeLessThan(1e-9)
      // Q_back is B&H's 4|S₁(π)|²/x², from the coefficients alone.
      expect(
        Math.abs(
          efficiencies(series).back / ((4 * size(back.s1) ** 2) / (x * x)) - 1,
        ),
      ).toBeLessThan(1e-9)
    }
  })

  it('normalizes its phase function to ∫p dΩ = 1 at x = 5, 50 and 500', () => {
    // |S|² is a polynomial of degree 2N in cos θ, so N + 8 Gauss–Legendre
    // nodes integrate it exactly: what is left is the series' own
    // consistency between Q_sca and the amplitudes.
    for (const x of [5, 50, 500]) {
      const series = mieSeries(x, 1.33)
      const { scattering } = efficiencies(series)
      const { nodes, weights } = gaussLegendre(series.terms + 8)
      const integral = nodes.reduce(
        (sum, mu, k) => sum + weights[k]! * phase(series, mu, scattering),
        0,
      )
      expect(Math.abs(2 * Math.PI * integral - 1)).toBeLessThan(1e-6)
    }
  })

  it('approaches the extinction paradox, Q_ext → 2, at x = 1000', () => {
    // 2.016 measured: the edge term, ~2x^(−2/3), is the rest.
    expect(
      Math.abs(efficiencies(mieSeries(1000, 1.33)).extinction / 2 - 1),
    ).toBeLessThan(0.03)
  })

  it('has converged at Wiscombe’s count: twenty more terms move S₁ under 10⁻⁶', () => {
    // 2.5 × 10⁻⁷ at x = 50, the worst of the four, measured: a thousandth of
    // the table's half-float step.
    for (const x of [5, 50, 500, 1000]) {
      const series = mieSeries(x, 1.33)
      const longer = mieSeries(x, 1.33, series.terms + 20)
      const a = amplitudes(series, -0.3).s1
      const b = amplitudes(longer, -0.3).s1
      expect(
        Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.hypot(...b),
      ).toBeLessThan(1e-6)
    }
  })

  it('sums both mirrored halves of an angle set as the direct sum does', () => {
    // The generator's sums against the single-angle one the tests above hold
    // to Bohren and Huffman.
    const cosines = [1, 0.9999, 0.93, 0.5, 0.17, 0.001]
    for (const x of [3, 80, 640]) {
      const series = mieSeries(x, 1.333)
      const table = angularTable(cosines, series.terms)
      const forward = new Float64Array(cosines.length)
      const backward = new Float64Array(cosines.length)
      mirroredIntensities(series, table, forward, backward)
      cosines.forEach((mu, k) => {
        expect(forward[k]! / intensity(amplitudes(series, mu)) - 1).toBeCloseTo(
          0,
          10,
        )
        expect(
          backward[k]! / intensity(amplitudes(series, -mu)) - 1,
        ).toBeCloseTo(0, 10)
      })
    }
  })
})

describe('white light', () => {
  it('has the CIE 1931 observer’s equal areas, through Wyman, Sloan and Shirley’s fit', () => {
    // The observer is normalized so equal-energy white sits at x = y = 1/3.
    // The fit puts it at (0.33295, 0.33367) measured; a coefficient mistyped
    // by its last digit moves x by about 0.002.
    const sum = [0, 0, 0]
    for (let nm = 360; nm <= 830; nm += 1)
      cie1931(nm).forEach((value, k) => (sum[k] = sum[k]! + value))
    const total = sum[0]! + sum[1]! + sum[2]!
    expect(Math.abs(sum[0]! / total - 1 / 3)).toBeLessThan(1e-3)
    expect(Math.abs(sum[1]! / total - 1 / 3)).toBeLessThan(1e-3)
  })

  it('maps D65 white to linear sRGB (1, 1, 1)', () => {
    // D65's chromaticity is x 0.3127, y 0.3290 (the ICC's note on IEC
    // 61966-2-1, item 3); the four-digit matrix leaves 1.7 × 10⁻⁴.
    for (const channel of linearSrgb(0.3127 / 0.329, 1, 0.3583 / 0.329))
      expect(Math.abs(channel - 1)).toBeLessThan(1e-3)
  })
})

describe('Laven’s glory rings, on the series (the Done-when’s first half)', () => {
  it('puts a drop’s red rings in white light at 24/r and 37/r degrees', () => {
    // Laven (philiplaven.com/p2c1.html) reads the red rings of a white-light
    // image of monodisperse drops at about 24/r, 37/r, 56/r and 76/r degrees,
    // and warns that they are not where any one wavelength peaks. So:
    // 100 wavelengths across 380–700 nm, equal energy, the CIE 1931 observer,
    // linear sRGB, and redness R/(R + G + B). The first ring measures −10.3,
    // −8.8, −6.7 and −6.2% of 24/r for 6, 10, 16 and 25 µm, and the second
    // −1.5, +0.7, +2.3 and +2.0% of 37/r. The bounds leave room for the fit's
    // distance from CIE's own tables.
    const step = 0.005
    for (const r of [6, 10, 16, 25]) {
      const psi = Array.from(
        { length: Math.ceil((1.6 * 37) / r / step) },
        (_, k) => k * step,
      )
      const found = rings(
        whiteLightRedness(r, waterIndex, psi, {
          from: 380,
          to: 700,
          count: 100,
        }),
      )
      expect(found.second).toBeGreaterThan(0)
      expect(Math.abs((psi[found.first]! * r) / 24 - 1)).toBeLessThan(0.12)
      expect(Math.abs((psi[found.second]! * r) / 37 - 1)).toBeLessThan(0.06)
    }
  })

  it('counts a ring only past the antisolar point’s own first minimum', () => {
    // A curve that climbs from ψ = 0 to a hump has its first minimum after
    // the hump, as a 10 µm drop's redness does; one that falls from a peak
    // there, as a band's p(π − ψ) does, has it where the fall stops.
    expect(rings([0.36, 0.41, 0.3, 0.73, 0.02, 0.63, 0.5])).toEqual({
      minimum: 2,
      first: 3,
      second: 5,
    })
    expect(rings([9, 4, 1, 3, 5, 2, 0])).toEqual({
      minimum: 2,
      first: 4,
      second: -1,
    })
    expect(rings([1, 2, 3, 4]).first).toBe(-1)
  })
})
