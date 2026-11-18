/*
 * Legendre arithmetic for the slab references: Gauss–Legendre quadrature, the
 * polynomials P_l, the associated functions an azimuthal mode is expanded in,
 * and the two closed forms the phase moments are multiplied by.
 *
 * A phase function is held as its moments χ_l, with χ₀ = 1 and χ₁ = g:
 *
 *   p(cos Θ) = (1/4π)·Σ (2l + 1)·χ_l·P_l(cos Θ)        sr⁻¹, ∫p dΩ = 1
 *
 * Everything is float64. A cloud's phase function needs a thousand moments,
 * and its forward peak is five orders over its side minimum, so the sums
 * below lose about five of float64's sixteen digits where p is smallest and
 * nothing a half-float table could show.
 */

export interface Quadrature {
  readonly nodes: Float64Array
  readonly weights: Float64Array
}

/**
 * Gauss–Legendre on [−1, 1], nodes ascending: Newton on P_n from the
 * Chebyshev-like guess. Exact for polynomials of degree 2n − 1.
 */
export function gaussLegendre(count: number): Quadrature {
  if (!(count >= 1) || !Number.isInteger(count))
    throw new Error(`legendre: no quadrature of ${count} nodes`)
  const nodes = new Float64Array(count)
  const weights = new Float64Array(count)
  // P_n′(x) from P_n and P_{n−1}.
  const slopeAt = (x: number): readonly [value: number, slope: number] => {
    let below = 1
    let value = x
    for (let l = 2; l <= count; l += 1) {
      const next = ((2 * l - 1) * x * value - (l - 1) * below) / l
      below = value
      value = next
    }
    return [value, (count * (x * value - below)) / (x * x - 1)]
  }
  for (let i = 0; i < count >> 1; i += 1) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (count + 0.5))
    for (let pass = 0; pass < 100; pass += 1) {
      const [value, slope] = slopeAt(x)
      const step = value / slope
      x -= step
      if (Math.abs(step) < 4e-16) break
    }
    const slope = slopeAt(x)[1]
    const weight = 2 / ((1 - x * x) * slope * slope)
    nodes[count - 1 - i] = x
    nodes[i] = -x
    weights[count - 1 - i] = weight
    weights[i] = weight
  }
  if (count % 2 === 1) {
    // The middle node is zero exactly, where the slope's own form is 0/0 no
    // longer: P_n′(0) = n·P_{n−1}(0).
    let below = 1
    let value = 0
    for (let l = 2; l <= count; l += 1) {
      const next = (-(l - 1) * below) / l
      below = value
      value = next
    }
    const slope = count === 1 ? 1 : count * below
    weights[(count - 1) / 2] = 2 / (slope * slope)
  }
  return { nodes, weights }
}

/** Gauss–Legendre on [0, 1]: the half range a double-Gauss scheme uses for each hemisphere. */
export function halfRangeGauss(count: number): Quadrature {
  const full = gaussLegendre(count)
  return {
    nodes: full.nodes.map((x) => (x + 1) / 2),
    weights: full.weights.map((w) => w / 2),
  }
}

/** P_0…P_{count − 1} at `mu`, into `out`. */
export function legendreInto(
  mu: number,
  count: number,
  out: Float64Array,
): void {
  if (count > 0) out[0] = 1
  if (count > 1) out[1] = mu
  for (let l = 2; l < count; l += 1)
    out[l] = ((2 * l - 1) * mu * out[l - 1]! - (l - 1) * out[l - 2]!) / l
}

/**
 * Y_l^m(μ) = √((l − m)!/(l + m)!)·P_l^m(μ) for l = m…lMax, into
 * `out[l − m]`. The square root is in the function because P_l^m itself
 * leaves float64 near m = 150; normalized, every value is at most one, and a
 * phase function's mode m is Σ (2l + 1)·χ_l·Y_l^m(μ)·Y_l^m(μ′) with no
 * factorial left over.
 */
export function associatedInto(
  m: number,
  lMax: number,
  mu: number,
  out: Float64Array,
): void {
  if (lMax < m) return
  // Y_m^m = √((2m − 1)!!/(2m)!!)·(1 − μ²)^(m/2), built a factor at a time so
  // the product never overflows on the way to a value that is small.
  const sine = Math.sqrt(Math.max(0, 1 - mu * mu))
  let start = 1
  for (let k = 1; k <= m; k += 1)
    start *= Math.sqrt((2 * k - 1) / (2 * k)) * sine
  out[0] = start
  if (lMax === m) return
  out[1] = mu * Math.sqrt(2 * m + 1) * start
  for (let l = m + 2; l <= lMax; l += 1)
    out[l - m] =
      ((2 * l - 1) * mu * out[l - m - 1]! -
        Math.sqrt((l - 1) * (l - 1) - m * m) * out[l - m - 2]!) /
      Math.sqrt(l * l - m * m)
}

/** p(mu), sr⁻¹, of the moments χ_0…χ_L. */
export function phaseOf(moments: ArrayLike<number>, mu: number): number {
  let sum = 0
  let p0 = 1
  let p1 = mu
  for (let l = 0; l < moments.length; l += 1) {
    sum += (2 * l + 1) * moments[l]! * p0
    const next = ((2 * l + 3) * mu * p1 - (l + 1) * p0) / (l + 2)
    p0 = p1
    p1 = next
  }
  return sum / (4 * Math.PI)
}

/**
 * The moments of a uniform cap of angular radius `alpha`, radians:
 * c_l = (P_{l−1}(cos α) − P_{l+1}(cos α))/((2l + 1)·(1 − cos α)). By the
 * Funk–Hecke theorem a phase function convolved with that cap has the moments
 * χ_l·c_l, which is how a sun's disk enters a first-order term.
 */
export function capMoments(alpha: number, count: number): Float64Array {
  const out = new Float64Array(count).fill(1)
  if (!(alpha > 0)) return out
  const c = Math.cos(alpha)
  const p = new Float64Array(count + 1)
  legendreInto(c, count + 1, p)
  // 1 − cos α as 2·sin²(α/2): a sun's disk is 5 mrad, where the difference
  // from one keeps eleven digits and this keeps sixteen.
  const cap = 2 * Math.sin(alpha / 2) ** 2
  for (let l = 1; l < count; l += 1)
    out[l] = (p[l - 1]! - p[l + 1]!) / ((2 * l + 1) * cap)
  return out
}

/** Henyey–Greenstein's moments, g^l, for l under `count`. */
export function henyeyGreensteinMoments(
  g: number,
  count: number,
): Float64Array {
  return Float64Array.from({ length: count }, (_, l) => g ** l)
}

/** Henyey–Greenstein, sr⁻¹. */
export function henyeyGreenstein(mu: number, g: number): number {
  return (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * mu) ** 1.5)
}

/**
 * The Fraunhofer pattern's moments for a disk of size parameter x, in the
 * small-angle form P_l(cos θ) ≈ J₀((l + ½)·θ): the Hankel transform of the
 * Airy pattern is the overlap of two unit disks (l + ½)/x apart,
 *
 *   χ_l = (2/π)·(acos s − s·√(1 − s²)),   s = (l + ½)/(2x),   zero from s = 1
 *
 * divided by its own l = 0 value, 1 − 1/(πx) + …, so the pattern integrates
 * to one as a phase function must.
 */
export function fraunhoferMomentsInto(
  x: number,
  weight: number,
  out: Float64Array,
): void {
  const overlap = (s: number): number =>
    s >= 1 ? 0 : (2 / Math.PI) * (Math.acos(s) - s * Math.sqrt(1 - s * s))
  const scale = weight / overlap(0.25 / x)
  const last = Math.min(out.length, Math.ceil(2 * x))
  for (let l = 0; l < last; l += 1)
    out[l] = out[l]! + scale * overlap((l + 0.5) / (2 * x))
}
