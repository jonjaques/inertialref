import {
  firstOrder,
  interfaceField,
  layersAt,
  modePhase,
  scatteringCosine,
  slabNodes,
  truncate,
} from './addingDoubling.ts'
import { gaussLegendre, henyeyGreenstein, phaseOf } from './legendre.ts'

/*
 * The higher orders' source function, cut from the oracle: what a march adds
 * a step beyond first order, as three numbers a place in a slab.
 *
 * Inside a slab of the renderer's medium the light that has scattered at
 * least once already is scattered again into a view direction at the rate
 *
 *   S_h(τ′, Ω) = ∫ p′(Ω, Ω′)·I(τ′, Ω′) dΩ′         per unit of scaled depth
 *
 * and a march that integrates first order plus S_h along its ray, through
 * the scaled depth, returns the oracle's radiance. The table holds S_h's
 * least-squares projection, over every view direction, on
 *
 *   J₀ + J₁·μ_v + J_f·Φ(ν)          Φ(ν) = 4π·HG(ν; λ) − 1
 *
 * with μ_v the cosine, to the lit face's outward normal, of light traveling
 * to the eye, ν the cosine between the sun's light and that light, and λ
 * the lobe's asymmetry, the medium's g′². J₀ and J₁ are the diffusion
 * domain's form; the lobe carries what two moments about the normal cannot,
 * the low orders' memory of the sun's direction.
 *
 * **The axes are transport depths to the two faces,** t = (1 − g′)·τ′, each
 * on a logarithm, and the sun's cosine. g′ is (g − f_δ)/(1 − f_δ) from a
 * radius's bulk g and f_δ, which a march has at every sample; it is not the
 * scaled phase's own first moment, which the Fraunhofer pattern's wings put
 * 0.005 higher.
 *
 * **The oracle's own truncation is taken back out.** The oracle solves the
 * scaled medium by delta-M, which counts the share f of every scattering as
 * no scattering and so works in a depth (1 − f)·τ′. Light the oracle calls
 * unscattered is, to the march, light that scattered forward: it is in S_h.
 * In the oracle's field I*, at its own depth τ*:
 *
 *   S_h = (1 − f)·∫p*·I* dΩ′ + f·I(Ω) + p′(ν)·(e^(−τ*_d/μ₀) − e^(−τ′_d/μ₀))
 *
 * the truncated phase's scattering of the diffuse field; the forward
 * delta's scattering of the radiance already going the eye's way, which is
 * the oracle's corrected radiance there; and first order of the beam the
 * delta feeds. Along a ray in scaled depth those three and first order
 * integrate to the oracle's corrected radiance exactly, so what the
 * reconstruction measures is the three terms and the table's read.
 */

/** The table's axes. */
export interface SourceGrid {
  /** Nodes along each depth axis. */
  readonly nodes: number
  /** Sun cosines, evenly from `sunMuMin` to one. */
  readonly suns: number
  readonly sunMuMin: number
  /** u(t) = ln(1 + t/depthScale)/ln(1 + depthMax/depthScale). */
  readonly depthScale: number
  readonly depthMax: number
}

/** The transport depth's place on its axis, 0 to 1; clamped past `depthMax`. */
export function depthCoordinate(grid: SourceGrid, depth: number): number {
  return Math.min(
    1,
    Math.log1p(Math.max(0, depth) / grid.depthScale) /
      Math.log1p(grid.depthMax / grid.depthScale),
  )
}

/** Node i's transport depth: `depthCoordinate`'s inverse at i/(nodes − 1). */
export function nodeDepth(grid: SourceGrid, i: number): number {
  return (
    grid.depthScale *
    Math.expm1(
      (i / (grid.nodes - 1)) * Math.log1p(grid.depthMax / grid.depthScale),
    )
  )
}

/** Sun node k's cosine. */
export function nodeSun(grid: SourceGrid, k: number): number {
  return grid.sunMuMin + (k * (1 - grid.sunMuMin)) / (grid.suns - 1)
}

/** The medium a table is cut from. */
export interface SourceMedium {
  /** χ′_l of the scaled phase. */
  readonly moments: Float64Array
  /** The same through the sun's disk: what a first-order term reads. */
  readonly convolved: Float64Array
  /** g′ = (g − f_δ)/(1 − f_δ): what turns a scaled depth into a transport depth. */
  readonly asymmetry: number
  /** Single-scattering albedo; one where it is left out, as a cloud's is. */
  readonly albedo?: number
}

/** Φ(ν): the lobe about the sun, with zero mean over the sphere. */
export function lobe(nu: number, asymmetry: number): number {
  return 4 * Math.PI * henyeyGreenstein(nu, asymmetry) - 1
}

/** How a cell's three terms are fitted to its source over the sphere. */
export type SourceFit =
  /** Least squares on the source itself. */
  | 'absolute'
  /** Least squares on the source over itself: every direction's error counts by its share. */
  | 'relative'

/** One table's fits, each laid out [sun][bottom][top][term]. */
export interface SourceTerms {
  /** (J₀, J₁, J_f), by each measure. */
  readonly absolute: Float64Array
  readonly relative: Float64Array
  /** (J₀, J₁, 0): the fits without the lobe. */
  readonly absolutePlain: Float64Array
  readonly relativePlain: Float64Array
  /** The delta-M share the oracle took out, and the modes it summed. */
  readonly delta: number
  readonly modes: number
}

export interface SourceOptions {
  /** Azimuths a hemisphere of bearing the source is sampled at; 16 where left out. */
  readonly azimuths?: number
  /**
   * Top nodes to do, for a run split over processes, and bottom nodes; a
   * node left out stays zero, and no layer is built for a depth neither
   * list names.
   */
  readonly rows?: readonly number[]
  readonly columns?: readonly number[]
  /**
   * Called with each cell's source before it is fitted: sr⁻¹ per unit of
   * the sun's irradiance, laid out [direction][azimuth], the quadrature's
   * cosines downward and then upward.
   */
  readonly inspect?: (
    cell: {
      readonly sun: number
      readonly bottom: number
      readonly top: number
    },
    source: Float64Array,
  ) => void
}

/** Solves the symmetric system a·x = b in place of b, by elimination: a is `size` square. */
function solveSmall(a: number[], b: number[], size: number): void {
  for (let p = 0; p < size; p += 1) {
    for (let i = p + 1; i < size; i += 1) {
      const factor = a[i * size + p]! / a[p * size + p]!
      for (let j = p; j < size; j += 1)
        a[i * size + j] = a[i * size + j]! - factor * a[p * size + j]!
      b[i] = b[i]! - factor * b[p]!
    }
  }
  for (let p = size - 1; p >= 0; p -= 1) {
    let sum = b[p]!
    for (let j = p + 1; j < size; j += 1) sum -= a[p * size + j]! * b[j]!
    b[p] = sum / a[p * size + p]!
  }
}

/**
 * The table's terms at every node: the oracle's interior field under each
 * of the grid's suns, at the plane between a layer of each top depth and a
 * layer of each bottom depth, as the source it scatters into each of the
 * quadrature's directions at each azimuth, and that source's fits.
 */
export function sourceTerms(
  medium: SourceMedium,
  grid: SourceGrid,
  lobeAsymmetry: number,
  streams: number,
  options: SourceOptions = {},
): SourceTerms {
  const albedo = medium.albedo ?? 1
  const cut = truncate({ moments: medium.moments, albedo }, streams)
  const f = cut.delta
  const suns = Array.from({ length: grid.suns }, (_, k) => nodeSun(grid, k))
  const nodes = slabNodes(streams, suns)
  const n = nodes.size
  const q = nodes.quadrature
  const columns = suns.map((_, k) => q + k)
  const every = Array.from({ length: grid.nodes }, (_, i) => i)
  const tops = options.rows ?? every
  const bottoms = options.columns ?? every
  const built = [...new Set([...tops, ...bottoms])]
  const bearings = options.azimuths ?? 16
  // Midpoints of [0, π]: the source is even in azimuth, and no sample sits
  // on the sun's own bearing, where first order's peak is.
  const azimuths = Array.from(
    { length: bearings },
    (_, a) => (Math.PI * (a + 0.5)) / bearings,
  )
  // Scaled depth, and the oracle's own.
  const scaled = Array.from(
    { length: grid.nodes },
    (_, i) => nodeDepth(grid, i) / (1 - medium.asymmetry),
  )
  const starred = scaled.map((depth) => depth * cut.depthScale)
  const directions = 2 * q
  const span = directions * bearings
  // A cell of this run: [sun][bottom][top of this run's].
  const cellOf = (sun: number, bottom: number, row: number): number =>
    (sun * grid.nodes + bottom) * tops.length + row
  const source = new Float64Array(grid.suns * grid.nodes * tops.length * span)

  // What has scattered at least once, scattered again by the truncated
  // phase, and the forward delta's share of the diffuse light itself: a
  // mode at a time, until two modes in a row move nothing.
  const down = new Float64Array(q)
  const up = new Float64Array(q)
  const wave = new Float64Array(bearings)
  let quiet = 0
  let modes = 0
  let largest = 0
  for (let m = 0; m < cut.moments.length && quiet < 2; m += 1) {
    const phase = modePhase(m, cut.moments, nodes)
    const made = layersAt(
      phase,
      cut.albedo,
      built.map((i) => starred[i]!),
      nodes,
    )
    const layers = new Map(built.map((i, at) => [i, made[at]!]))
    for (let a = 0; a < bearings; a += 1) wave[a] = Math.cos(m * azimuths[a]!)
    let moved = 0
    tops.forEach((top, row) => {
      for (const bottom of bottoms) {
        const field = interfaceField(
          layers.get(top)!,
          layers.get(bottom)!,
          nodes,
          columns,
        )
        for (let s = 0; s < grid.suns; s += 1) {
          // Radiance per unit of the sun's irradiance, this mode's.
          const scale = ((m === 0 ? 1 : 2) * suns[s]!) / Math.PI
          for (let i = 0; i < q; i += 1) {
            let sourceDown = 0
            let sourceUp = 0
            for (let k = 0; k < q; k += 1) {
              const goingDown =
                nodes.weight[k]! * field.down[k * grid.suns + s]!
              const goingUp = nodes.weight[k]! * field.up[k * grid.suns + s]!
              sourceDown +=
                phase.same[i * n + k]! * goingDown +
                phase.opposite[i * n + k]! * goingUp
              sourceUp +=
                phase.opposite[i * n + k]! * goingDown +
                phase.same[i * n + k]! * goingUp
            }
            down[i] =
              scale *
              albedo *
              ((1 - f) * 0.5 * sourceDown + f * field.down[i * grid.suns + s]!)
            up[i] =
              scale *
              albedo *
              ((1 - f) * 0.5 * sourceUp + f * field.up[i * grid.suns + s]!)
            moved = Math.max(moved, Math.abs(down[i]!), Math.abs(up[i]!))
          }
          const base = cellOf(s, bottom, row) * span
          for (let i = 0; i < q; i += 1)
            for (let a = 0; a < bearings; a += 1) {
              source[base + i * bearings + a] =
                source[base + i * bearings + a]! + down[i]! * wave[a]!
              source[base + (q + i) * bearings + a] =
                source[base + (q + i) * bearings + a]! + up[i]! * wave[a]!
            }
        }
      }
    })
    if (m === 0) largest = moved
    modes = m + 1
    quiet = moved <= 1e-7 * largest ? quiet + 1 : 0
  }

  // The two terms no mode holds, and the basis, at each direction: the
  // correction's own phase (p′/(1 − f) − p*), the first-order phase, the
  // cosine to the lit face's normal and the lobe.
  const gain = albedo / cut.depthScale
  const whole = medium.convolved.map((value, l) =>
    l < cut.moments.length
      ? gain * value - cut.albedo * cut.moments[l]!
      : gain * value,
  )
  const out: SourceTerms = {
    absolute: new Float64Array(grid.suns * grid.nodes * grid.nodes * 3),
    relative: new Float64Array(grid.suns * grid.nodes * grid.nodes * 3),
    absolutePlain: new Float64Array(grid.suns * grid.nodes * grid.nodes * 3),
    relativePlain: new Float64Array(grid.suns * grid.nodes * grid.nodes * 3),
    delta: f,
    modes,
  }
  const correction = new Float64Array(span)
  const first = new Float64Array(span)
  const about = new Float64Array(span)
  const along = new Float64Array(span)
  const solid = new Float64Array(span)
  for (let s = 0; s < grid.suns; s += 1) {
    const sun = suns[s]!
    for (let d = 0; d < directions; d += 1) {
      const mu = nodes.mu[d % q]!
      const side = d < q ? 'transmitted' : 'reflected'
      for (let a = 0; a < bearings; a += 1) {
        const nu = scatteringCosine(sun, mu, azimuths[a]!, side)
        const at = d * bearings + a
        correction[at] = phaseOf(whole, nu)
        first[at] = phaseOf(medium.convolved, nu)
        about[at] = d < q ? -mu : mu
        along[at] = lobe(nu, lobeAsymmetry)
        solid[at] = (nodes.weight[d % q]! * 2 * Math.PI) / bearings
      }
    }
    tops.forEach((top, row) => {
      for (const bottom of bottoms) {
        const samples = source.subarray(
          cellOf(s, bottom, row) * span,
          (cellOf(s, bottom, row) + 1) * span,
        )
        const beam =
          Math.exp(-starred[top]! / sun) - Math.exp(-scaled[top]! / sun)
        for (let d = 0; d < directions; d += 1) {
          const mu = nodes.mu[d % q]!
          // First order's correction to the radiance already going this
          // way, in the oracle's depth: down through the top layer, or up
          // out of the bottom one.
          const reach =
            d < q
              ? firstOrder(starred[top]!, sun, mu, 'transmitted')
              : Math.exp(-starred[top]! / sun) *
                firstOrder(starred[bottom]!, sun, mu, 'reflected')
          for (let a = 0; a < bearings; a += 1) {
            const at = d * bearings + a
            samples[at] =
              samples[at]! +
              albedo * (f * correction[at]! * reach + first[at]! * beam)
          }
        }
        options.inspect?.({ sun: s, bottom, top }, samples)
        const cell = ((s * grid.nodes + bottom) * grid.nodes + top) * 3
        for (const [terms, target, measure] of [
          [3, out.absolute, 'absolute'],
          [3, out.relative, 'relative'],
          [2, out.absolutePlain, 'absolute'],
          [2, out.relativePlain, 'relative'],
        ] as const) {
          const fitted = fitCell(samples, [about, along], solid, terms, measure)
          for (let term = 0; term < terms; term += 1)
            target[cell + term] = fitted[term]!
        }
      }
    })
  }
  return out
}

/**
 * The coefficients of (1, basis…) that fit `samples` over the sphere by
 * weighted least squares: `solid` is each sample's solid angle, and the
 * relative measure divides each sample's error by the sample.
 */
function fitCell(
  samples: Float64Array,
  basis: readonly Float64Array[],
  solid: Float64Array,
  terms: number,
  measure: SourceFit,
): number[] {
  // A source is positive; where rounding leaves a sample at or under zero,
  // the relative measure counts it at the mean's ten-thousandth.
  let mean = 0
  let total = 0
  for (let at = 0; at < samples.length; at += 1) {
    mean += solid[at]! * samples[at]!
    total += solid[at]!
  }
  // A slab of no depth has no source, and nothing to divide by.
  if (!(mean > 0)) return new Array<number>(terms).fill(0)
  const floor = (1e-4 * mean) / total
  const a = new Array<number>(terms * terms).fill(0)
  const b = new Array<number>(terms).fill(0)
  const row = new Array<number>(terms).fill(1)
  for (let at = 0; at < samples.length; at += 1) {
    const value = samples[at]!
    const scale = measure === 'relative' ? 1 / Math.max(floor, value) : 1
    const weight = solid[at]! * scale * scale
    for (let t = 1; t < terms; t += 1) row[t] = basis[t - 1]![at]!
    for (let i = 0; i < terms; i += 1) {
      b[i] = b[i]! + weight * row[i]! * value
      for (let j = 0; j < terms; j += 1)
        a[i * terms + j] = a[i * terms + j]! + weight * row[i]! * row[j]!
    }
  }
  solveSmall(a, b, terms)
  return b
}

/** A table as a march reads it. */
export interface SourceTable extends SourceGrid {
  /** Three terms a cell, laid out [sun][bottom][top][term]. */
  readonly terms: ArrayLike<number>
}

/**
 * (J₀, J₁, J_f) at transport depths `top` and `bottom` from the two faces
 * under a sun at `sunMu`: the table's trilinear read, clamped at its ends,
 * which is what a linear 3D texture returns.
 */
export function readSource(
  table: SourceTable,
  top: number,
  bottom: number,
  sunMu: number,
  out: Float64Array,
): void {
  const last = table.nodes - 1
  const x = depthCoordinate(table, top) * last
  const y = depthCoordinate(table, bottom) * last
  const z = Math.min(
    table.suns - 1,
    Math.max(
      0,
      ((sunMu - table.sunMuMin) / (1 - table.sunMuMin)) * (table.suns - 1),
    ),
  )
  const x0 = Math.min(last - 1, Math.floor(x))
  const y0 = Math.min(last - 1, Math.floor(y))
  const z0 = Math.min(table.suns - 2, Math.floor(z))
  const fx = x - x0
  const fy = y - y0
  const fz = z - z0
  out.fill(0, 0, 3)
  for (let corner = 0; corner < 8; corner += 1) {
    const dx = corner & 1
    const dy = (corner >> 1) & 1
    const dz = corner >> 2
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
    const cell = ((z0 + dz) * table.nodes + y0 + dy) * table.nodes + x0 + dx
    for (let term = 0; term < 3; term += 1)
      out[term] = out[term]! + weight * table.terms[cell * 3 + term]!
  }
}

/** One view of one slab. */
export interface SlabView {
  /** The slab's scaled optical depth, τ′. */
  readonly depth: number
  readonly sunMu: number
  readonly viewMu: number
  /** Degrees between the view ray's bearing and the sun's. */
  readonly azimuth: number
  readonly side: 'reflected' | 'transmitted'
}

const PANEL = /*@__PURE__*/ gaussLegendre(8)
/** Panels from each face, each half the one before: a source near a face changes over a depth of 0.2. */
const HALVINGS = 14

/**
 * The radiance a march adds past first order, per unit of the sun's
 * irradiance: ∫(J₀ + J₁·μ_v + J_f·Φ)·e^(−τ′_view) dτ′_view through the
 * table's own read, along the view's ray across the whole slab.
 */
export function higherOrders(
  table: SourceTable,
  view: SlabView,
  asymmetry: number,
  lobeAsymmetry: number,
): number {
  const about = view.side === 'reflected' ? view.viewMu : -view.viewMu
  const along = lobe(
    scatteringCosine(
      view.sunMu,
      view.viewMu,
      (view.azimuth * Math.PI) / 180,
      view.side,
    ),
    lobeAsymmetry,
  )
  // Panel edges as shares of the depth: 2⁻¹⁴ … ½ from the lit face, and the same from the far one.
  const edges = [0]
  for (let k = HALVINGS; k >= 1; k -= 1) edges.push(2 ** -k)
  for (let k = 2; k <= HALVINGS; k += 1) edges.push(1 - 2 ** -k)
  edges.push(1)
  const terms = new Float64Array(3)
  let sum = 0
  for (let p = 0; p + 1 < edges.length; p += 1) {
    const from = edges[p]! * view.depth
    const width = (edges[p + 1]! - edges[p]!) * view.depth
    for (let i = 0; i < PANEL.nodes.length; i += 1) {
      const depth = from + (width * (PANEL.nodes[i]! + 1)) / 2
      readSource(
        table,
        (1 - asymmetry) * depth,
        (1 - asymmetry) * (view.depth - depth),
        view.sunMu,
        terms,
      )
      const path = view.side === 'reflected' ? depth : view.depth - depth
      sum +=
        ((PANEL.weights[i]! * width) / 2) *
        (terms[0]! + terms[1]! * about + terms[2]! * along) *
        Math.exp(-path / view.viewMu)
    }
  }
  return sum / view.viewMu
}
