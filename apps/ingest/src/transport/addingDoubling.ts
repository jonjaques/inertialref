import { associatedInto, halfRangeGauss, phaseOf } from './legendre.ts'

/*
 * The slab oracle: adding-doubling for a plane-parallel, homogeneous slab
 * under a collimated sun, every azimuthal mode, in the structure of Hansen
 * and Travis ("Light scattering in planetary atmospheres", Space Science
 * Reviews 16, 527–610, 1974, §4) and de Haan, Bosma and Hovenier ("The adding
 * method for multiple scattering calculations of polarized light", Astronomy
 * and Astrophysics 183, 371–391, 1987).
 *
 * A layer is two functions of a pair of cosines, a mode at a time: R and T,
 * its diffuse reflection and transmission, in Hansen and Travis's
 * normalization, where a beam of irradiance F from cosine μ₀ leaves as
 *
 *   I(μ, φ) = (μ₀·F/π)·Σ_m (2 − δ_m0)·R^m(μ, μ₀)·cos m(φ − φ₀)
 *
 * and a product of two functions is a sum over the quadrature's cosines
 * weighted by 2·μ·w. The beam that crosses a layer unscattered is not in T:
 * it is e^(−τ/μ) on the diagonal, carried apart, because next to T's entries
 * for a thin layer it is a delta the quadrature cannot hold.
 *
 * **The cosines are a double-Gauss rule and the ones asked for.** Each
 * hemisphere takes a Gauss–Legendre rule on [0, 1], which puts no node on
 * the horizon and integrates a hemisphere's flux exactly. A requested sun or
 * view cosine joins as a node of weight zero: it is a row and a column of
 * every function and a term of no sum, so the answer at it is the solution
 * there and not an interpolation.
 *
 * **A phase function with more moments than streams is truncated by
 * delta-M** (Wiscombe, J. Atmos. Sci. 34, 1408, 1977): the moment the rule
 * cannot hold, f = χ_2N, is taken out as a forward delta, which rescales the
 * depth and the albedo. First order is then put back exactly, as Nakajima
 * and Tanaka's TMS correction (JQSRT 40, 51, 1988): the truncated problem's
 * own first order comes out and the whole phase function's goes in, on the
 * truncated depth, at ω/(1 − f·ω). So the radiance carries the forward peak,
 * the bows and the glory at the angles the series puts them, and only what
 * has scattered twice or more has seen a smoothed phase.
 */

/** The slab's medium. */
export interface SlabMedium {
  /** χ_l from l = 0: χ₀ = 1, χ₁ = g. */
  readonly moments: ArrayLike<number>
  /** Single-scattering albedo; one where it is left out. */
  readonly albedo?: number
  /** What a first-order term reads, sr⁻¹; the moments' own series where it is left out. */
  readonly phase?: (mu: number) => number
}

/** The cosines every function of a solve is laid out on. */
export interface SlabNodes {
  /** The quadrature's cosines, ascending, then the extras. */
  readonly mu: Float64Array
  /** A node's weight on [0, 1]; zero at an extra. */
  readonly weight: Float64Array
  /** 2·μ·w: what a product of two functions weighs a cosine by. */
  readonly flux: Float64Array
  /** Quadrature nodes a hemisphere. */
  readonly quadrature: number
  /** Quadrature nodes and extras together. */
  readonly size: number
}

export function slabNodes(
  streams: number,
  extras: readonly number[] = [],
): SlabNodes {
  if (!(streams >= 2) || streams % 2 !== 0)
    throw new Error(`addingDoubling: ${streams} is not an even stream count`)
  for (const mu of extras)
    if (!(mu > 0 && mu <= 1))
      throw new Error(`addingDoubling: ${mu} is not a cosine in (0, 1]`)
  const quadrature = streams / 2
  const rule = halfRangeGauss(quadrature)
  const size = quadrature + extras.length
  const mu = new Float64Array(size)
  const weight = new Float64Array(size)
  mu.set(rule.nodes)
  mu.set(extras, quadrature)
  weight.set(rule.weights)
  return {
    mu,
    weight,
    flux: mu.map((value, i) => 2 * value * weight[i]!),
    quadrature,
    size,
  }
}

/** Mode m of a phase function on the nodes, [i][j] row-major. */
export interface ModePhase {
  /** Σ (2l + 1)·χ_l·Y_l^m(μ_i)·Y_l^m(μ_j): both cosines on one side of the slab's plane. */
  readonly same: Float64Array
  /** The same sum with (−1)^(l + m): the two cosines on opposite sides. */
  readonly opposite: Float64Array
}

export function modePhase(
  m: number,
  moments: ArrayLike<number>,
  nodes: SlabNodes,
): ModePhase {
  const n = nodes.size
  const same = new Float64Array(n * n)
  const opposite = new Float64Array(n * n)
  const terms = moments.length - m
  if (terms <= 0) return { same, opposite }
  const y = new Float64Array(n * terms)
  for (let i = 0; i < n; i += 1)
    associatedInto(
      m,
      moments.length - 1,
      nodes.mu[i]!,
      y.subarray(i * terms, (i + 1) * terms),
    )
  const scale = Float64Array.from(
    { length: terms },
    (_, k) => (2 * (k + m) + 1) * moments[k + m]!,
  )
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j <= i; j += 1) {
      let even = 0
      let odd = 0
      // k = l − m, so (−1)^(l + m) is (−1)^k.
      for (let k = 0; k + 1 < terms; k += 2) {
        even += scale[k]! * y[i * terms + k]! * y[j * terms + k]!
        odd += scale[k + 1]! * y[i * terms + k + 1]! * y[j * terms + k + 1]!
      }
      if (terms % 2 === 1) {
        const k = terms - 1
        even += scale[k]! * y[i * terms + k]! * y[j * terms + k]!
      }
      same[i * n + j] = same[j * n + i] = even + odd
      opposite[i * n + j] = opposite[j * n + i] = even - odd
    }
  return { same, opposite }
}

/** A homogeneous layer, one mode. */
export interface Layer {
  readonly r: Float64Array
  readonly t: Float64Array
  /** e^(−τ/μ) a node: the unscattered beam. */
  readonly e: Float64Array
  /** τ. */
  readonly depth: number
}

/** (1 − e^(−x))/x. */
const decay = (x: number): number =>
  x < 1e-9 ? 1 - x / 2 : -Math.expm1(-x) / x

/** A layer no light is scattered in: depth zero. */
function emptyLayer(nodes: SlabNodes): Layer {
  const n = nodes.size
  return {
    r: new Float64Array(n * n),
    t: new Float64Array(n * n),
    e: new Float64Array(n).fill(1),
    depth: 0,
  }
}

/**
 * A layer's first order in closed form, at any depth:
 *
 *   R = (ω/4)·P(−μ, μ₀)·(1 − e^(−τ(1/μ + 1/μ₀)))/(μ + μ₀)
 *   T = (ω/4)·P(μ, μ₀)·(e^(−τ/μ₀) − e^(−τ/μ))/(μ₀ − μ)
 *
 * It is the layer doubling starts from, at a depth far under the smallest
 * cosine, and it is the term the TMS correction takes out of a whole slab.
 */
export function firstOrderLayer(
  phase: ModePhase,
  albedo: number,
  depth: number,
  nodes: SlabNodes,
): Layer {
  const n = nodes.size
  const { mu } = nodes
  const r = new Float64Array(n * n)
  const t = new Float64Array(n * n)
  const e = mu.map((value) => Math.exp(-depth / value))
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j <= i; j += 1) {
      const thin = (albedo * depth) / (4 * mu[i]! * mu[j]!)
      const high = Math.max(mu[i]!, mu[j]!)
      const low = Math.min(mu[i]!, mu[j]!)
      r[i * n + j] = r[j * n + i] =
        thin *
        phase.opposite[i * n + j]! *
        decay(depth / mu[i]! + depth / mu[j]!)
      t[i * n + j] = t[j * n + i] =
        thin *
        phase.same[i * n + j]! *
        Math.exp(-depth / high) *
        decay(depth / low - depth / high)
    }
  return { r, t, e, depth }
}

/** out = a·D·b: the product of two functions, summed over the quadrature's cosines. */
function product(
  a: Float64Array,
  b: Float64Array,
  nodes: SlabNodes,
): Float64Array {
  const n = nodes.size
  const out = new Float64Array(n * n)
  for (let i = 0; i < n; i += 1)
    for (let k = 0; k < nodes.quadrature; k += 1) {
      const scale = a[i * n + k]! * nodes.flux[k]!
      if (scale === 0) continue
      for (let j = 0; j < n; j += 1)
        out[i * n + j] = out[i * n + j]! + scale * b[k * n + j]!
    }
  return out
}

/**
 * Solves m·x = rhs in place by elimination with partial pivoting: `m` is
 * `size` square and `rhs` is `size` rows of `columns`, both row-major. The
 * answer is left in `rhs`.
 */
export function solveInPlace(
  m: Float64Array,
  rhs: Float64Array,
  size: number,
  columns: number,
): void {
  for (let p = 0; p < size; p += 1) {
    let pivot = p
    for (let i = p + 1; i < size; i += 1)
      if (Math.abs(m[i * size + p]!) > Math.abs(m[pivot * size + p]!)) pivot = i
    if (m[pivot * size + p] === 0)
      throw new Error('addingDoubling: a singular system')
    if (pivot !== p) {
      for (let j = p; j < size; j += 1) {
        const hold = m[p * size + j]!
        m[p * size + j] = m[pivot * size + j]!
        m[pivot * size + j] = hold
      }
      for (let j = 0; j < columns; j += 1) {
        const hold = rhs[p * columns + j]!
        rhs[p * columns + j] = rhs[pivot * columns + j]!
        rhs[pivot * columns + j] = hold
      }
    }
    const inverse = 1 / m[p * size + p]!
    for (let i = p + 1; i < size; i += 1) {
      const factor = m[i * size + p]! * inverse
      if (factor === 0) continue
      for (let j = p + 1; j < size; j += 1)
        m[i * size + j] = m[i * size + j]! - factor * m[p * size + j]!
      for (let j = 0; j < columns; j += 1)
        rhs[i * columns + j] =
          rhs[i * columns + j]! - factor * rhs[p * columns + j]!
    }
  }
  for (let p = size - 1; p >= 0; p -= 1) {
    const inverse = 1 / m[p * size + p]!
    for (let j = 0; j < columns; j += 1) {
      let sum = rhs[p * columns + j]!
      for (let k = p + 1; k < size; k += 1)
        sum -= m[p * size + k]! * rhs[k * columns + j]!
      rhs[p * columns + j] = sum * inverse
    }
  }
}

/** Two layers as one, and the diffuse light at the plane between them. */
export interface Added {
  readonly layer: Layer
  /**
   * The diffuse light crossing the plane away from the lit face, and toward
   * it, for a beam on the upper layer from each node's cosine: functions in
   * the layers' own normalization.
   */
  readonly down: Float64Array
  readonly up: Float64Array
}

/**
 * Layer `a` over layer `b`, lit from a's side (Hansen and Travis's equations
 * 4.22 to 4.26, with the beam apart):
 *
 *   Q = R_a·R_b        S = Q + Q·S         the light bouncing between the two
 *   D = T_a + S·E_a + S·T_a                down through the plane
 *   U = R_b·E_a + R_b·D                    up through it
 *   R = R_a + E_a·U + T_a·U                T = E_b·D + T_b·E_a + T_b·D
 *
 * Both layers are homogeneous, so each reflects and transmits light from
 * below as it does light from above, and one R and one T a layer serve.
 *
 * The sum's beam is e^(−τ/μ) at its own depth, not the product of the two
 * layers' beams. Doubling squares a beam thirty-four times on the way from
 * the starting layer, and a product would carry the starting layer's
 * rounding, half a unit in the last place of a number next to one, 2³⁴
 * times over: a slab that loses 10⁻⁶ of its light to arithmetic.
 */
export function addLayers(a: Layer, b: Layer, nodes: SlabNodes): Added {
  const n = nodes.size
  const q = nodes.quadrature
  const bounce = product(a.r, b.r, nodes)
  // (1 − Q·D)·S = Q on the quadrature's rows; an extra's row follows from them.
  const system = new Float64Array(q * q)
  for (let i = 0; i < q; i += 1) {
    for (let k = 0; k < q; k += 1)
      system[i * q + k] = -bounce[i * n + k]! * nodes.flux[k]!
    system[i * q + i] = system[i * q + i]! + 1
  }
  const series = bounce.slice()
  solveInPlace(system, series.subarray(0, q * n), q, n)
  const tail = product(bounce, series, nodes)
  for (let i = q * n; i < n * n; i += 1) series[i] = bounce[i]! + tail[i]!
  const down = product(series, a.t, nodes)
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1)
      down[i * n + j] =
        down[i * n + j]! + a.t[i * n + j]! + series[i * n + j]! * a.e[j]!
  const up = product(b.r, down, nodes)
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1)
      up[i * n + j] = up[i * n + j]! + b.r[i * n + j]! * a.e[j]!
  const r = product(a.t, up, nodes)
  const t = product(b.t, down, nodes)
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1) {
      r[i * n + j] = r[i * n + j]! + a.r[i * n + j]! + a.e[i]! * up[i * n + j]!
      t[i * n + j] =
        t[i * n + j]! + b.e[i]! * down[i * n + j]! + b.t[i * n + j]! * a.e[j]!
    }
  const depth = a.depth + b.depth
  return {
    layer: { r, t, e: nodes.mu.map((mu) => Math.exp(-depth / mu)), depth },
    down,
    up,
  }
}

/**
 * The diffuse light at the plane between layer `a` and layer `b` under it,
 * at the quadrature's cosines, for a beam on `a` from each of `columns`:
 * `down` and `up` as [cosine][column], in the layers' own normalization.
 * It is `addLayers`' D and U for those columns alone, which is all an
 * interior field under a few suns needs, at a fifth of the arithmetic.
 */
export function interfaceField(
  a: Layer,
  b: Layer,
  nodes: SlabNodes,
  columns: readonly number[],
): { readonly down: Float64Array; readonly up: Float64Array } {
  const n = nodes.size
  const q = nodes.quadrature
  const width = columns.length
  // Q = R_a·R_b on the quadrature's rows, at its own columns and the beams'.
  const system = new Float64Array(q * q)
  const down = new Float64Array(q * width)
  for (let i = 0; i < q; i += 1) {
    for (let k = 0; k < q; k += 1) {
      const scale = a.r[i * n + k]! * nodes.flux[k]!
      if (scale === 0) continue
      for (let j = 0; j < q; j += 1)
        system[i * q + j] = system[i * q + j]! + scale * b.r[k * n + j]!
      for (let c = 0; c < width; c += 1)
        down[i * width + c] =
          down[i * width + c]! + scale * b.r[k * n + columns[c]!]!
    }
    // (1 − Q·D)·D_down = T_a + Q·E_a.
    for (let c = 0; c < width; c += 1)
      down[i * width + c] =
        down[i * width + c]! * a.e[columns[c]!]! + a.t[i * n + columns[c]!]!
    for (let j = 0; j < q; j += 1)
      system[i * q + j] =
        (i === j ? 1 : 0) - system[i * q + j]! * nodes.flux[j]!
  }
  solveInPlace(system, down, q, width)
  const up = new Float64Array(q * width)
  for (let i = 0; i < q; i += 1)
    for (let c = 0; c < width; c += 1) {
      let sum = b.r[i * n + columns[c]!]! * a.e[columns[c]!]!
      for (let k = 0; k < q; k += 1)
        sum += b.r[i * n + k]! * nodes.flux[k]! * down[k * width + c]!
      up[i * width + c] = sum
    }
  return { down, up }
}

/**
 * The depth doubling starts under. First order alone leaves out what a
 * starting layer scatters twice, a share near τ₀/μ of what it scatters once,
 * and doubling to τ repeats that τ/τ₀ times: a slab's flux is short by about
 * τ·τ₀·ln(1/τ₀). At 2⁻³⁴ that is under 10⁻⁸ at a depth of 50.
 */
export const START_DEPTH = 2 ** -34

/**
 * The largest depth every one of `depths` is a whole multiple of, among the
 * least depth's first few divisors; zero where there is none.
 */
function commonBase(depths: readonly number[]): number {
  const positive = depths.filter((depth) => depth > 0)
  if (positive.length === 0) return 0
  const least = Math.min(...positive)
  for (let divisor = 1; divisor <= 64; divisor += 1) {
    const base = least / divisor
    if (
      positive.every((depth) => {
        const multiple = depth / base
        return (
          multiple < 4096 &&
          Math.abs(multiple - Math.round(multiple)) < 1e-9 * multiple
        )
      })
    )
      return base
  }
  return 0
}

/**
 * One mode's layers at each of `depths`, in the order given.
 *
 * Depths that are whole multiples of one base share its doublings: the
 * domain's 5, 7, 10, 20, 30 and 50 are sums of a base's powers of two, so
 * one chain of doublings and eleven additions make all six. Depths with no
 * such base take a chain each.
 */
export function layersAt(
  phase: ModePhase,
  albedo: number,
  depths: readonly number[],
  nodes: SlabNodes,
  start: number = START_DEPTH,
): Layer[] {
  const chain = (from: number, to: number): Layer[] => {
    let depth = from / 2 ** Math.max(0, Math.ceil(Math.log2(from / start)))
    let layer = firstOrderLayer(phase, albedo, depth, nodes)
    const out: Layer[] = []
    for (;;) {
      if (depth >= from * (1 - 1e-9)) out.push(layer)
      if (depth * 2 > to * (1 + 1e-9)) return out
      layer = addLayers(layer, layer, nodes).layer
      depth *= 2
    }
  }
  const base = commonBase(depths)
  const powers = base > 0 ? chain(base, Math.max(...depths)) : []
  return depths.map((depth) => {
    if (!(depth > 0)) return emptyLayer(nodes)
    if (base === 0) return chain(depth, depth)[0]!
    let sum: Layer | undefined
    let multiple = Math.round(depth / base)
    for (let bit = 0; multiple > 0; bit += 1, multiple >>= 1)
      if (multiple & 1)
        sum =
          sum === undefined
            ? powers[bit]!
            : addLayers(sum, powers[bit]!, nodes).layer
    return sum!
  })
}

/** A phase function as a rule of `streams` holds it. */
export interface Truncation {
  /** f: the share taken out as a forward delta. */
  readonly delta: number
  /** (χ_l − f)/(1 − f), l under `streams`. */
  readonly moments: Float64Array
  /** ω·(1 − f)/(1 − f·ω). */
  readonly albedo: number
  /** 1 − f·ω: what a depth is multiplied by. */
  readonly depthScale: number
}

/** Delta-M at `streams`; no truncation where the moments already fit. */
export function truncate(medium: SlabMedium, streams: number): Truncation {
  const albedo = medium.albedo ?? 1
  const count = Math.min(streams, medium.moments.length)
  const delta = medium.moments.length > streams ? medium.moments[streams]! : 0
  return {
    delta,
    moments: Float64Array.from(
      { length: count },
      (_, l) => (medium.moments[l]! - delta) / (1 - delta),
    ),
    albedo: (albedo * (1 - delta)) / (1 - delta * albedo),
    depthScale: 1 - delta * albedo,
  }
}

export interface SlabQuery {
  readonly medium: SlabMedium
  /** Optical depths. */
  readonly depths: readonly number[]
  /** The sun's cosines over the slab's normal. */
  readonly suns: readonly number[]
  /** The view's cosines. */
  readonly views: readonly number[]
  /** Degrees between the view ray's bearing and the sun's: 0 looks toward the sun's side. */
  readonly azimuths: readonly number[]
  /** 2N: the quadrature's cosines over both hemispheres. */
  readonly streams: number
  /** Modes stop when two in a row move no radiance by this share of the largest. */
  readonly tolerance?: number
}

export interface SlabSolution {
  /**
   * Diffuse radiance leaving the lit face, and the far one, per unit of the
   * sun's irradiance, sr⁻¹: laid out [depth][sun][view][azimuth].
   */
  readonly reflected: Float64Array
  readonly transmitted: Float64Array
  /** The flux leaving the lit face over the flux arriving: [depth][sun]. */
  readonly albedo: Float64Array
  /** The flux through the far face, the unscattered beam with it, over the flux arriving. */
  readonly transmittance: Float64Array
  /** Azimuthal modes summed. */
  readonly modes: number
  /** The delta-M share the solve took out. */
  readonly delta: number
}

/** The cosine of the scattering angle between a sun at `sun` and light leaving at `view`, `azimuth` radians apart. */
export function scatteringCosine(
  sun: number,
  view: number,
  azimuth: number,
  side: 'reflected' | 'transmitted',
): number {
  const along = side === 'reflected' ? -sun * view : sun * view
  return (
    along +
    Math.sqrt(Math.max(0, 1 - sun * sun)) *
      Math.sqrt(Math.max(0, 1 - view * view)) *
      Math.cos(azimuth)
  )
}

/**
 * A slab's first-order radiance per unit of the sun's irradiance and of the
 * phase function, at albedo one: what the light scattered once at each depth
 * adds up to after both attenuations.
 *
 *   reflected     μ₀·(1 − e^(−τ(1/μ₀ + 1/μ)))/(μ₀ + μ)
 *   transmitted   μ₀·(e^(−τ/μ₀) − e^(−τ/μ))/(μ₀ − μ)
 */
export function firstOrder(
  depth: number,
  sun: number,
  view: number,
  side: 'reflected' | 'transmitted',
): number {
  const thin = depth / view
  if (side === 'reflected') return thin * decay(depth / sun + depth / view)
  const high = Math.max(sun, view)
  const low = Math.min(sun, view)
  return thin * Math.exp(-depth / high) * decay(depth / low - depth / high)
}

/** Each distinct cosine's node index, past the quadrature. */
function extrasOf(...lists: readonly (readonly number[])[]): number[] {
  return [...new Set(lists.flat())]
}

/**
 * A slab's leaving radiance and fluxes: every depth, sun, view and azimuth
 * of the query, from one pass over the azimuthal modes.
 */
export function solveSlab(query: SlabQuery): SlabSolution {
  const { medium, depths, suns, views, streams } = query
  const tolerance = query.tolerance ?? 1e-8
  const cut = truncate(medium, streams)
  const extras = extrasOf(suns, views)
  const nodes = slabNodes(streams, extras)
  const n = nodes.size
  const at = (mu: number): number => nodes.quadrature + extras.indexOf(mu)
  const scaled = depths.map((depth) => depth * cut.depthScale)
  const azimuths = query.azimuths.map((degrees) => (degrees * Math.PI) / 180)
  const cells = depths.length * suns.length * views.length * azimuths.length
  const reflected = new Float64Array(cells)
  const transmitted = new Float64Array(cells)
  const albedo = new Float64Array(depths.length * suns.length)
  const transmittance = new Float64Array(depths.length * suns.length)
  let quiet = 0
  let modes = 0
  for (let m = 0; m < cut.moments.length && quiet < 2; m += 1) {
    const phase = modePhase(m, cut.moments, nodes)
    const layers = layersAt(phase, cut.albedo, scaled, nodes)
    const factor = m === 0 ? 1 : 2
    let moved = 0
    let largest = 0
    let cell = 0
    depths.forEach((_, d) => {
      const layer = layers[d]!
      const first = firstOrderLayer(phase, cut.albedo, scaled[d]!, nodes)
      suns.forEach((sun, s) => {
        const j = at(sun)
        if (m === 0) {
          let up = 0
          let through = 0
          for (let k = 0; k < nodes.quadrature; k += 1) {
            up += nodes.flux[k]! * layer.r[k * n + j]!
            through += nodes.flux[k]! * layer.t[k * n + j]!
          }
          albedo[d * suns.length + s] = up
          transmittance[d * suns.length + s] = through + layer.e[j]!
        }
        for (const view of views) {
          const i = at(view)
          // What has scattered twice or more: first order is put back whole below.
          const back =
            (sun / Math.PI) * (layer.r[i * n + j]! - first.r[i * n + j]!)
          const on =
            (sun / Math.PI) * (layer.t[i * n + j]! - first.t[i * n + j]!)
          for (const azimuth of azimuths) {
            const wave = factor * Math.cos(m * azimuth)
            reflected[cell] = reflected[cell]! + wave * back
            transmitted[cell] = transmitted[cell]! + wave * on
            moved = Math.max(moved, Math.abs(wave * back), Math.abs(wave * on))
            largest = Math.max(largest, reflected[cell]!, transmitted[cell]!)
            cell += 1
          }
        }
      })
    })
    modes = m + 1
    quiet = moved <= tolerance * largest ? quiet + 1 : 0
  }
  // First order, from the whole phase function on the truncated depth.
  const whole = medium.phase ?? ((mu: number) => phaseOf(medium.moments, mu))
  const gain = (medium.albedo ?? 1) / cut.depthScale
  let cell = 0
  for (const depth of scaled)
    for (const sun of suns)
      for (const view of views) {
        const back = gain * firstOrder(depth, sun, view, 'reflected')
        const on = gain * firstOrder(depth, sun, view, 'transmitted')
        for (const azimuth of azimuths) {
          reflected[cell] =
            reflected[cell]! +
            back * whole(scatteringCosine(sun, view, azimuth, 'reflected'))
          transmitted[cell] =
            transmitted[cell]! +
            on * whole(scatteringCosine(sun, view, azimuth, 'transmitted'))
          cell += 1
        }
      }
  return {
    reflected,
    transmitted,
    albedo,
    transmittance,
    modes,
    delta: cut.delta,
  }
}
