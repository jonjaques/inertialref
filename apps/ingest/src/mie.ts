/*
 * The Lorenz–Mie series for a homogeneous sphere, in the structure of Bohren
 * and Huffman's BHMIE (Absorption and Scattering of Light by Small Particles,
 * 1983, Appendix A): the logarithmic derivative D_n(mx) by downward
 * recurrence, the Riccati–Bessel functions ψ_n and χ_n upward, and the
 * angular functions π_n and τ_n upward. Wiscombe's term count (Applied Optics
 * 19, 1505, 1980) ends the series. Everything is float64, and complex numbers
 * are (re, im) pairs.
 *
 * The index is real. Water's κ in the visible is near 10⁻⁹ (Hale and Querry's
 * Table I), which moves Q_abs by under 10⁻⁶, so D_n(mx) is real and every sum
 * here is a nonabsorbing sphere's.
 *
 * The white-light half at the bottom is what holds the series to Laven's glory
 * rings: his 24/r and 37/r are the red rings of a white-light picture, which
 * no single wavelength's intensity reproduces.
 */

/** One sphere's series: a_n and b_n at a size parameter and a real index. */
export interface MieSeries {
  /** Size parameter, 2πr/λ. */
  readonly x: number
  /** Relative refractive index, real. */
  readonly m: number
  /** Terms summed. */
  readonly terms: number
  /**
   * a_n at [2n] (re) and [2n + 1] (im) for n = 1…terms; n = 0 and
   * n = terms + 1 hold zeros, so a sum may read one term past the end.
   */
  readonly a: Float64Array
  readonly b: Float64Array
}

/** Wiscombe's (1980) N = x + 4.05·x^(1/3) + 2, the count BHMIE also stops at. */
export function wiscombeTerms(x: number): number {
  return Math.round(x + 4.05 * Math.cbrt(x) + 2)
}

/**
 * a_n and b_n. D_n starts at zero 16 terms above max(N, |mx|), one more
 * than BHMIE's 15: the downward recurrence forgets a wrong start within a few
 * terms, where the upward one would amplify every rounding past n ≈ |mx|.
 */
export function mieSeries(
  x: number,
  m: number,
  terms: number = wiscombeTerms(x),
): MieSeries {
  if (!(x > 0) || !(m > 0) || !(terms >= 1))
    throw new Error(`mie: no series at x ${x}, m ${m}, ${terms} terms`)
  const y = m * x
  const top = Math.ceil(Math.max(terms, y)) + 16
  const d = new Float64Array(top + 1)
  for (let n = top; n > 0; n -= 1) d[n - 1] = n / y - 1 / (d[n]! + n / y)
  const a = new Float64Array(2 * (terms + 2))
  const b = new Float64Array(2 * (terms + 2))
  // ψ_{n−2}, ψ_{n−1} and χ_{n−2}, χ_{n−1}, entering n = 1 at ψ₋₁, ψ₀, χ₋₁, χ₀.
  let psi0 = Math.cos(x)
  let psi1 = Math.sin(x)
  let chi0 = -Math.sin(x)
  let chi1 = Math.cos(x)
  for (let n = 1; n <= terms; n += 1) {
    const f = (2 * n - 1) / x
    const psi = f * psi1 - psi0
    const chi = f * chi1 - chi0
    // a_n = (αψ_n − ψ_{n−1}) / (αξ_n − ξ_{n−1}) with ξ = ψ − iχ: the numerator
    // is the denominator's real part, so a_n = u/(u − iv).
    const alpha = d[n]! / m + n / x
    ratio(a, n, alpha * psi - psi1, alpha * chi - chi1)
    const beta = m * d[n]! + n / x
    ratio(b, n, beta * psi - psi1, beta * chi - chi1)
    psi0 = psi1
    psi1 = psi
    chi0 = chi1
    chi1 = chi
  }
  return { x, m, terms, a, b }
}

/** u/(u − iv) = u(u + iv)/(u² + v²), into term n of `out`. */
function ratio(out: Float64Array, n: number, u: number, v: number): void {
  const s = u / (u * u + v * v)
  out[2 * n] = u * s
  out[2 * n + 1] = v * s
}

export interface MieEfficiencies {
  readonly extinction: number
  readonly scattering: number
  /** Bohren and Huffman's Q_back = 4|S₁(π)|²/x². */
  readonly back: number
  /** g = ⟨cos θ⟩. */
  readonly asymmetry: number
}

/** Q_ext, Q_sca, Q_back and g from the coefficients alone (B&H 4.61, 4.62, 4.74, 4.82). */
export function efficiencies(series: MieSeries): MieEfficiencies {
  const { a, b, terms, x } = series
  let extinction = 0
  let scattering = 0
  let asymmetry = 0
  let backRe = 0
  let backIm = 0
  for (let n = 1; n <= terms; n += 1) {
    const ar = a[2 * n]!
    const ai = a[2 * n + 1]!
    const br = b[2 * n]!
    const bi = b[2 * n + 1]!
    const weight = 2 * n + 1
    extinction += weight * (ar + br)
    scattering += weight * (ar * ar + ai * ai + br * br + bi * bi)
    // n(n+2)/(n+1)·Re(a_n a*_{n+1} + b_n b*_{n+1}) + (2n+1)/(n(n+1))·Re(a_n b*_n)
    asymmetry +=
      ((n * (n + 2)) / (n + 1)) *
        (ar * a[2 * n + 2]! +
          ai * a[2 * n + 3]! +
          br * b[2 * n + 2]! +
          bi * b[2 * n + 3]!) +
      (weight / (n * (n + 1))) * (ar * br + ai * bi)
    const sign = n % 2 === 0 ? weight : -weight
    backRe += sign * (ar - br)
    backIm += sign * (ai - bi)
  }
  const x2 = x * x
  return {
    extinction: (2 / x2) * extinction,
    scattering: (2 / x2) * scattering,
    back: (backRe * backRe + backIm * backIm) / x2,
    // g = (4/(x²·Q_sca))·Σ, and Q_sca = (2/x²)·Σ(2n + 1)(|a_n|² + |b_n|²).
    asymmetry: (2 * asymmetry) / scattering,
  }
}

export interface Amplitudes {
  readonly s1: readonly [number, number]
  readonly s2: readonly [number, number]
}

/** S₁ and S₂ at one cosine, with π_n and τ_n run up beside the sum. */
export function amplitudes(series: MieSeries, mu: number): Amplitudes {
  const { a, b, terms } = series
  let s1r = 0
  let s1i = 0
  let s2r = 0
  let s2i = 0
  let piPrevious = 0
  let pi = 1
  for (let n = 1; n <= terms; n += 1) {
    const tau = n * mu * pi - (n + 1) * piPrevious
    const c = (2 * n + 1) / (n * (n + 1))
    const ar = a[2 * n]!
    const ai = a[2 * n + 1]!
    const br = b[2 * n]!
    const bi = b[2 * n + 1]!
    s1r += c * (ar * pi + br * tau)
    s1i += c * (ai * pi + bi * tau)
    s2r += c * (ar * tau + br * pi)
    s2i += c * (ai * tau + bi * pi)
    const next = ((2 * n + 1) / n) * mu * pi - ((n + 1) / n) * piPrevious
    piPrevious = pi
    pi = next
  }
  return { s1: [s1r, s1i], s2: [s2r, s2i] }
}

/** sr⁻¹, normalized to ∫p dΩ = 1: (|S₁|² + |S₂|²)/(2π·x²·Q_sca). */
export function phase(series: MieSeries, mu: number, scattering: number) {
  const { s1, s2 } = amplitudes(series, mu)
  const intensity = s1[0] ** 2 + s1[1] ** 2 + s2[0] ** 2 + s2[1] ** 2
  return intensity / (2 * Math.PI * series.x * series.x * scattering)
}

/**
 * π_n and τ_n at fixed cosines, laid out [cosine][n] with n = 0…terms + 1,
 * for the sums of many spheres at the same angles: they depend on the angle
 * alone, and running their recurrences once rather than once a sphere is a
 * third of a sum's arithmetic.
 */
export interface AngularTable {
  readonly cosines: Float64Array
  readonly terms: number
  readonly stride: number
  readonly pi: Float64Array
  readonly tau: Float64Array
}

export function angularTable(
  cosines: ArrayLike<number>,
  terms: number,
): AngularTable {
  const stride = terms + 2
  const pi = new Float64Array(cosines.length * stride)
  const tau = new Float64Array(cosines.length * stride)
  for (let k = 0; k < cosines.length; k += 1) {
    const mu = cosines[k]!
    const base = k * stride
    pi[base + 1] = 1
    tau[base + 1] = mu
    for (let n = 2; n <= terms + 1; n += 1) {
      pi[base + n] =
        ((2 * n - 1) / (n - 1)) * mu * pi[base + n - 1]! -
        (n / (n - 1)) * pi[base + n - 2]!
      tau[base + n] = n * mu * pi[base + n]! - (n + 1) * pi[base + n - 1]!
    }
  }
  return { cosines: Float64Array.from(cosines), terms, stride, pi, tau }
}

/**
 * |S₁|² + |S₂|² at each cosine μ_k into `forward[k]`, and at −μ_k into
 * `backward[k]`.
 *
 * The mirror is free: π_n(−μ) = (−1)^(n−1)π_n(μ) and τ_n(−μ) = (−1)^n τ_n(μ)
 * (B&H 4.48), so the same products summed by parity give both. The table's
 * angles are symmetric about 90°, so its 1024 angles cost 512 sums.
 */
export function mirroredIntensities(
  series: MieSeries,
  table: AngularTable,
  forward: Float64Array,
  backward: Float64Array,
): void {
  const { terms } = series
  if (terms > table.terms)
    throw new Error(
      `mie: ${terms} terms against an angular table of ${table.terms}`,
    )
  // c_n·a_n and c_n·b_n, zero past the last term, so the loop below reads
  // terms in odd–even pairs without a branch.
  const scaled = new Float64Array(4 * (terms + 2))
  for (let n = 1; n <= terms; n += 1) {
    const c = (2 * n + 1) / (n * (n + 1))
    scaled[4 * n] = c * series.a[2 * n]!
    scaled[4 * n + 1] = c * series.a[2 * n + 1]!
    scaled[4 * n + 2] = c * series.b[2 * n]!
    scaled[4 * n + 3] = c * series.b[2 * n + 1]!
  }
  const { pi, tau, stride } = table
  for (let k = 0; k < table.cosines.length; k += 1) {
    const base = k * stride
    // Σc·aπ, Σc·bτ, Σc·aτ, Σc·bπ over odd (o) and even (e) n, re and im.
    let por = 0
    let poi = 0
    let per = 0
    let pei = 0
    let tor = 0
    let toi = 0
    let ter = 0
    let tei = 0
    let uor = 0
    let uoi = 0
    let uer = 0
    let uei = 0
    let qor = 0
    let qoi = 0
    let qer = 0
    let qei = 0
    for (let n = 1; n <= terms; n += 2) {
      let p = pi[base + n]!
      let t = tau[base + n]!
      let ar = scaled[4 * n]!
      let ai = scaled[4 * n + 1]!
      let br = scaled[4 * n + 2]!
      let bi = scaled[4 * n + 3]!
      por += ar * p
      poi += ai * p
      tor += br * t
      toi += bi * t
      uor += ar * t
      uoi += ai * t
      qor += br * p
      qoi += bi * p
      p = pi[base + n + 1]!
      t = tau[base + n + 1]!
      ar = scaled[4 * n + 4]!
      ai = scaled[4 * n + 5]!
      br = scaled[4 * n + 6]!
      bi = scaled[4 * n + 7]!
      per += ar * p
      pei += ai * p
      ter += br * t
      tei += bi * t
      uer += ar * t
      uei += ai * t
      qer += br * p
      qei += bi * p
    }
    const s1r = por + per + tor + ter
    const s1i = poi + pei + toi + tei
    const s2r = uor + uer + qor + qer
    const s2i = uoi + uei + qoi + qei
    forward[k] = s1r * s1r + s1i * s1i + s2r * s2r + s2i * s2i
    // S₁(−μ) = Σ(−1)^(n−1)c(aπ − bτ), S₂(−μ) = Σ(−1)^(n−1)c(bπ − aτ).
    const b1r = por - per - (tor - ter)
    const b1i = poi - pei - (toi - tei)
    const b2r = qor - qer - (uor - uer)
    const b2i = qoi - qei - (uoi - uei)
    backward[k] = b1r * b1r + b1i * b1i + b2r * b2r + b2i * b2i
  }
}

/* ---------------------------------------------------------------- white light */

/**
 * The CIE 1931 2° observer through Wyman, Sloan and Shirley's piecewise
 * Gaussian fit ("Simple Analytic Approximations to the CIE XYZ Color Matching
 * Functions", JCGT 2(2), 2013, Table 1 and equation 4; their Listing 1 has the
 * same numbers). Each lobe is α·exp(−½[(λ − β)·(λ < β ? γ : δ)]²), λ in nm.
 */
const CIE_1931 = {
  x: [
    [0.362, 442.0, 0.0624, 0.0374],
    [1.056, 599.8, 0.0264, 0.0323],
    [-0.065, 501.1, 0.049, 0.0382],
  ],
  y: [
    [0.821, 568.8, 0.0213, 0.0247],
    [0.286, 530.9, 0.0613, 0.0322],
  ],
  z: [
    [1.217, 437.0, 0.0845, 0.0278],
    [0.681, 459.0, 0.0385, 0.0725],
  ],
} as const

function lobes(
  nm: number,
  fit: readonly (readonly [number, number, number, number])[],
): number {
  let sum = 0
  for (const [alpha, beta, below, above] of fit) {
    const t = (nm - beta) * (nm < beta ? below : above)
    sum += alpha * Math.exp(-0.5 * t * t)
  }
  return sum
}

/** x̄, ȳ, z̄ at λ nm. */
export function cie1931(nm: number): readonly [number, number, number] {
  return [lobes(nm, CIE_1931.x), lobes(nm, CIE_1931.y), lobes(nm, CIE_1931.z)]
}

/**
 * XYZ (D65) to linear sRGB: IEC 61966-2-1 Amendment 1 (2003), as the ICC's
 * "How to interpret the sRGB color space (specified in IEC 61966-2-1) for ICC
 * profiles" (2015, item 7) prints it. Unclipped: a ratio of the channels is
 * what is measured, and clipping is the display's encoding step.
 */
export function linearSrgb(
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] {
  return [
    3.2406255 * x - 1.537208 * y - 0.4986286 * z,
    -0.9689307 * x + 1.8757561 * y + 0.0415175 * z,
    0.0557101 * x - 0.2040211 * y + 1.0569959 * z,
  ]
}

export interface Spectrum {
  /** nm, both ends included. */
  readonly from: number
  readonly to: number
  readonly count: number
}

/**
 * The redness R/(R + G + B) of one drop's light in an equal-energy white
 * spectrum, at `psi` degrees from the antisolar point. Each wavelength enters
 * as its differential cross-section, (|S₁|² + |S₂|²)/(2k²), so the λ² the
 * intensities alone leave out is in.
 */
export function whiteLightRedness(
  radius: number,
  index: (nm: number) => number,
  psi: readonly number[],
  spectrum: Spectrum,
): Float64Array {
  const cosines = psi.map((degrees) => Math.cos((degrees * Math.PI) / 180))
  const shortest = Math.min(spectrum.from, spectrum.to) / 1000
  const table = angularTable(
    cosines,
    wiscombeTerms((2 * Math.PI * radius) / shortest),
  )
  const forward = new Float64Array(psi.length)
  const backward = new Float64Array(psi.length)
  const tristimulus = new Float64Array(3 * psi.length)
  for (let j = 0; j < spectrum.count; j += 1) {
    const nm =
      spectrum.from + ((spectrum.to - spectrum.from) * j) / (spectrum.count - 1)
    const series = mieSeries((2 * Math.PI * radius) / (nm / 1000), index(nm))
    mirroredIntensities(series, table, forward, backward)
    const [xBar, yBar, zBar] = cie1931(nm)
    const square = nm * nm
    for (let k = 0; k < psi.length; k += 1) {
      const light = square * backward[k]!
      tristimulus[3 * k] = tristimulus[3 * k]! + xBar * light
      tristimulus[3 * k + 1] = tristimulus[3 * k + 1]! + yBar * light
      tristimulus[3 * k + 2] = tristimulus[3 * k + 2]! + zBar * light
    }
  }
  const redness = new Float64Array(psi.length)
  for (let k = 0; k < psi.length; k += 1) {
    const [r, g, b] = linearSrgb(
      tristimulus[3 * k]!,
      tristimulus[3 * k + 1]!,
      tristimulus[3 * k + 2]!,
    )
    redness[k] = r / (r + g + b)
  }
  return redness
}

/** Sample indices of a glory's turns; −1 for a turn the samples do not reach. */
export interface Rings {
  /** The first minimum outward from the start. */
  readonly minimum: number
  /** The first maximum after it: the first ring. */
  readonly first: number
  /** The maximum after the next minimum: the second ring. */
  readonly second: number
}

/**
 * The first minimum past the antisolar point of a curve sampled outward from
 * it, the first maximum after that, and the next. The antisolar point itself
 * is never the minimum: in white light a 10 µm drop's redness climbs from
 * 0.36 there to a 0.41 hump at 0.5° — near neutral, where a red ring reaches
 * 0.73 — and counting the hump would put the first ring at the center. A
 * band's p(π − ψ) has its glory peak there and falls from it, so it meets the
 * same first minimum either way. A turn is only found with a sample beyond
 * it, so a scan that extends its samples finds the same turns.
 */
export function rings(values: ArrayLike<number>): Rings {
  const minimum = nextTurn(values, 1, 'minimum')
  const first = minimum < 0 ? -1 : nextTurn(values, minimum + 1, 'maximum')
  const between = first < 0 ? -1 : nextTurn(values, first + 1, 'minimum')
  const second = between < 0 ? -1 : nextTurn(values, between + 1, 'maximum')
  return { minimum, first, second }
}

/** The first index from `from` (≥ 1) where the curve stops falling (a minimum) or rising (a maximum). */
function nextTurn(
  values: ArrayLike<number>,
  from: number,
  turn: 'minimum' | 'maximum',
): number {
  const sign = turn === 'minimum' ? 1 : -1
  for (let i = from; i + 1 < values.length; i += 1) {
    const ahead = sign * (values[i + 1]! - values[i]!)
    const behind = sign * (values[i - 1]! - values[i]!)
    if (ahead >= 0 && behind > 0) return i
  }
  return -1
}
