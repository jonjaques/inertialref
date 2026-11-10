import {
  firstOrder,
  interfaceField,
  layersAt,
  modePhase,
  scatteringCosine,
  slabNodes,
  truncate,
} from './addingDoubling.ts'
import {
  sourceAt,
  type SlabSourceGrid,
  type SlabSourceReadOptions,
  type SlabSourceRay,
  type SlabSourceRead,
  type SlabSourceTable,
} from '@inertialref/rendering'
import { gaussLegendre, henyeyGreenstein, phaseOf } from './legendre.ts'

// The read is the game's as well, so it lives in `packages/rendering`
// (`slabSourceRead.ts`); the generator's names for its types stand here.
export {
  depthCoordinate,
  readSource,
  type SlabSourceGrid as SourceGrid,
  type SlabSourceRay as SourceRay,
  type SlabSourceRead as SourceRead,
  type SlabSourceTable as SourceTable,
} from '@inertialref/rendering'

/*
 * The higher orders' source function, cut from the oracle: what a march adds
 * a step beyond first order, at every place in a slab and in every
 * direction, and the read of a table that holds a fit of it.
 *
 * Inside a slab of the renderer's medium the light that has scattered at
 * least once already is scattered again into a view direction at the rate
 *
 *   S_h(τ′, Ω) = ∫ p′(Ω, Ω′)·I(τ′, Ω′) dΩ′         per unit of scaled depth
 *
 * and a march that integrates first order plus S_h along its ray, through
 * the scaled depth, returns the oracle's radiance. `sourceSamples` is S_h
 * at the oracle's own directions; what a table's texels are of it is a
 * form's to say (`slabForms.ts`), and `higherOrders` is the march's
 * integral through any of them.
 *
 * **The axes are transport depths to the two faces,** t = (1 − g′)·τ′, each
 * on a logarithm, and the sun's cosine. Which first moment g′ is belongs to
 * the table (`slabSourceTable.ts`): the formula's (g − f_δ)/(1 − f_δ), from
 * a radius's bulk g and f_δ, or the scaled phase's own, which the
 * Fraunhofer pattern's wings put 0.005 higher at 10 µm.
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
 * integrate to the oracle's corrected radiance exactly, so what a
 * reconstruction measures is a form's fit and the table's read.
 *
 * **Three terms do not hold a slab under an oblique sun,** by either
 * measure of fit: a mean, the cosine to the lit face's normal, and a lobe
 * about the sun's direction, which is the diffusion domain's form and the
 * low orders' memory of the sun. Across the horizon the source is a step, not a line:
 * light going up was sent by the slab below, and near the lit face almost
 * nothing is above to send light down. A tenth of a scaled depth under the
 * face, under a sun at μ₀ 0.19, the source away from the sun is 0.04 from
 * the horizon to straight up and 0.008 straight down; toward the sun's far
 * side it is 0.29 along the horizon, the lobe, and 0.04 and 0.01 straight
 * up and down. One cosine cannot be a step, and the lobe lies along it.
 * Least squares on the source follows the lobe and is 109% high straight
 * up; least squares on the source over itself spreads the error, 70% at
 * worst, and loses 3% to 4% of the reflected flux. Under a sun straight
 * above, the lobe points down the normal and the first fit is within 8%.
 * So a table's form is a choice with a cost, and the choice is made on the
 * samples, not here.
 */

/** Node i's transport depth: `depthCoordinate`'s inverse at i/(nodes − 1). */
export function nodeDepth(grid: SlabSourceGrid, i: number): number {
  return (
    grid.depthScale *
    Math.expm1(
      (i / (grid.nodes - 1)) * Math.log1p(grid.depthMax / grid.depthScale),
    )
  )
}

/** Sun node k's cosine. */
export function nodeSun(grid: SlabSourceGrid, k: number): number {
  return grid.sunMuMin + (k * (1 - grid.sunMuMin)) / (grid.suns - 1)
}

/** The medium a table is cut from. */
export interface SourceMedium {
  /** χ′_l of the scaled phase. */
  readonly moments: Float64Array
  /** The same through the sun's disk: what a first-order term reads. */
  readonly convolved: Float64Array
  /** g′, by the table's own convention: what turns a scaled depth into its transport depth. */
  readonly asymmetry: number
  /** Single-scattering albedo; one where it is left out, as a cloud's is. */
  readonly albedo?: number
}

/** Φ(ν): the lobe about the sun, with zero mean over the sphere. */
export function lobe(nu: number, asymmetry: number): number {
  return 4 * Math.PI * henyeyGreenstein(nu, asymmetry) - 1
}

/** Where a cell's source is sampled in azimuth, over the half circle the source is even about. */
export interface SourceBearings {
  readonly count: number
  /**
   * Whether the samples stand on the sun's own bearing and the one opposite
   * (a trapezoid's, `count` from 0 to π), or at the midpoints of `count`
   * equal parts.
   */
  readonly ends: boolean
}

/** Sixteen midpoints: no sample on the sun's own bearing, where first order's peak is. */
export const MIDPOINT_BEARINGS: SourceBearings = { count: 16, ends: false }

/**
 * The directions a cell's source is sampled at under one sun: the
 * quadrature's cosines, traveling away from the lit face and then toward
 * it, each at every bearing. A sample is at [direction][bearing].
 */
export interface SourceDirections {
  readonly sunMu: number
  /** The quadrature's cosines, ascending, and their weights on (0, 1). */
  readonly cosines: Float64Array
  readonly weights: Float64Array
  /** Radians from the sun's bearing, and each one's share of the whole circle. */
  readonly azimuths: Float64Array
  readonly shares: Float64Array
  /** A sample's cosine to the lit face's outward normal, of light traveling the sample's way. */
  readonly muV: Float64Array
  /** The part of that light's direction along the sun's own bearing: sin θ·cos φ. */
  readonly along: Float64Array
  /** The cosine between the sun's light and that light. */
  readonly nu: Float64Array
  /** A sample's solid angle: the samples' sum is 4π. */
  readonly solid: Float64Array
}

/** A cell of the table: a sun node, and a depth node from each face. */
export interface SourceCell {
  readonly sun: number
  readonly bottom: number
  readonly top: number
}

export interface SourceOptions {
  /** Where the source is sampled in azimuth; sixteen midpoints where left out. */
  readonly bearings?: SourceBearings
  /**
   * Top nodes to do, for a run split over processes, and bottom nodes; a
   * node left out is not visited, and no layer is built for a depth
   * neither list names.
   */
  readonly rows?: readonly number[]
  readonly columns?: readonly number[]
}

/** What a run of the oracle's interior says of itself. */
export interface SourceRun {
  /** The delta-M share the oracle took out, and the modes it summed. */
  readonly delta: number
  readonly modes: number
}

/**
 * The oracle's source at every node of the grid: under each of the grid's
 * suns, at the plane between a layer of each top depth and a layer of each
 * bottom depth, the light scattered again into each of the quadrature's
 * directions at each bearing, sr⁻¹ per unit of the sun's irradiance and of
 * scaled depth. `each` is handed a cell's samples, which are its own to
 * keep or to fit.
 */
export function sourceSamples(
  medium: SourceMedium,
  grid: SlabSourceGrid,
  streams: number,
  options: SourceOptions,
  each: (
    cell: SourceCell,
    samples: Float64Array,
    directions: SourceDirections,
  ) => void,
): SourceRun {
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
  const layout = options.bearings ?? MIDPOINT_BEARINGS
  const bearings = layout.count
  const azimuths = Float64Array.from({ length: bearings }, (_, a) =>
    layout.ends
      ? (Math.PI * a) / (bearings - 1)
      : (Math.PI * (a + 0.5)) / bearings,
  )
  const shares = Float64Array.from({ length: bearings }, (_, a) =>
    layout.ends
      ? ((a === 0 || a === bearings - 1 ? 1 : 2) * Math.PI) / (bearings - 1)
      : (2 * Math.PI) / bearings,
  )
  // Scaled depth, and the oracle's own.
  const scaled = Array.from(
    { length: grid.nodes },
    (_, i) => nodeDepth(grid, i) / (1 - medium.asymmetry),
  )
  const starred = scaled.map((depth) => depth * cut.depthScale)
  const directions = 2 * q
  const span = directions * bearings
  // A cell of this run: [sun][bottom of this run's][top of this run's].
  const cellOf = (sun: number, column: number, row: number): number =>
    (sun * bottoms.length + column) * tops.length + row
  const source = new Float64Array(
    grid.suns * bottoms.length * tops.length * span,
  )

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
      bottoms.forEach((bottom, column) => {
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
          const base = cellOf(s, column, row) * span
          for (let i = 0; i < q; i += 1)
            for (let a = 0; a < bearings; a += 1) {
              source[base + i * bearings + a] =
                source[base + i * bearings + a]! + down[i]! * wave[a]!
              source[base + (q + i) * bearings + a] =
                source[base + (q + i) * bearings + a]! + up[i]! * wave[a]!
            }
        }
      })
    })
    if (m === 0) largest = moved
    modes = m + 1
    quiet = moved <= 1e-7 * largest ? quiet + 1 : 0
  }

  // The two terms no mode holds, at each direction: the correction's own
  // phase (p′/(1 − f) − p*) and the first-order phase.
  const gain = albedo / cut.depthScale
  const whole = medium.convolved.map((value, l) =>
    l < cut.moments.length
      ? gain * value - cut.albedo * cut.moments[l]!
      : gain * value,
  )
  const correction = new Float64Array(span)
  const first = new Float64Array(span)
  for (let s = 0; s < grid.suns; s += 1) {
    const sun = suns[s]!
    const muV = new Float64Array(span)
    const along = new Float64Array(span)
    const nu = new Float64Array(span)
    const solid = new Float64Array(span)
    for (let d = 0; d < directions; d += 1) {
      const mu = nodes.mu[d % q]!
      const side = d < q ? 'transmitted' : 'reflected'
      for (let a = 0; a < bearings; a += 1) {
        const at = d * bearings + a
        nu[at] = scatteringCosine(sun, mu, azimuths[a]!, side)
        correction[at] = phaseOf(whole, nu[at]!)
        first[at] = phaseOf(medium.convolved, nu[at]!)
        muV[at] = d < q ? -mu : mu
        along[at] = Math.sqrt(1 - mu * mu) * Math.cos(azimuths[a]!)
        // The midpoints' form is the first table's own arithmetic, kept to
        // the last bit so that table is the one this still makes.
        solid[at] = layout.ends
          ? nodes.weight[d % q]! * shares[a]!
          : (nodes.weight[d % q]! * 2 * Math.PI) / bearings
      }
    }
    const where: SourceDirections = {
      sunMu: sun,
      cosines: nodes.mu.slice(0, q),
      weights: nodes.weight.slice(0, q),
      azimuths,
      shares,
      muV,
      along,
      nu,
      solid,
    }
    tops.forEach((top, row) => {
      bottoms.forEach((bottom, column) => {
        const samples = source.subarray(
          cellOf(s, column, row) * span,
          (cellOf(s, column, row) + 1) * span,
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
        each({ sun: s, bottom, top }, samples, where)
      })
    })
  }
  return { delta: f, modes }
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

/** A view's ray. */
export function slabRay(view: SlabView): SlabSourceRay {
  const azimuth = (view.azimuth * Math.PI) / 180
  return {
    sunMu: view.sunMu,
    muV: view.side === 'reflected' ? view.viewMu : -view.viewMu,
    along:
      Math.sqrt(Math.max(0, 1 - view.viewMu * view.viewMu)) * Math.cos(azimuth),
    nu: scatteringCosine(view.sunMu, view.viewMu, azimuth, view.side),
  }
}

const PANEL = /*@__PURE__*/ gaussLegendre(8)
/** Panels from each face, each half the one before: a source near a face changes over a depth of 0.2. */
const HALVINGS = 14

/**
 * The radiance a march adds past first order, per unit of the sun's
 * irradiance: the source, as the ray's reads of the table sum it, through
 * the view's own attenuation along the ray across the whole slab.
 */
export function higherOrders(
  table: SlabSourceTable,
  reads: readonly SlabSourceRead[],
  view: SlabView,
  asymmetry: number,
  options: SlabSourceReadOptions = {},
): number {
  // Panel edges as shares of the depth: 2⁻¹⁴ … ½ from the lit face, and the same from the far one.
  const edges = [0]
  for (let k = HALVINGS; k >= 1; k -= 1) edges.push(2 ** -k)
  for (let k = 2; k <= HALVINGS; k += 1) edges.push(1 - 2 ** -k)
  edges.push(1)
  const texel = new Float64Array(4)
  let sum = 0
  for (let p = 0; p + 1 < edges.length; p += 1) {
    const from = edges[p]! * view.depth
    const width = (edges[p + 1]! - edges[p]!) * view.depth
    for (let i = 0; i < PANEL.nodes.length; i += 1) {
      const depth = from + (width * (PANEL.nodes[i]! + 1)) / 2
      const source = sourceAt(
        table,
        reads,
        (1 - asymmetry) * depth,
        (1 - asymmetry) * (view.depth - depth),
        view.sunMu,
        texel,
        options,
      )
      const path = view.side === 'reflected' ? depth : view.depth - depth
      sum +=
        ((PANEL.weights[i]! * width) / 2) *
        source *
        Math.exp(-path / view.viewMu)
    }
  }
  return sum / view.viewMu
}
