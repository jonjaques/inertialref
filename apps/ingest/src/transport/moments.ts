import {
  angularTable,
  efficiencies,
  mieSeries,
  mirroredIntensities,
  wiscombeTerms,
} from '../mie.ts'
import {
  DROPLET_TABLE,
  RADIUS_GRID,
  band,
  radiusGrid,
  rowWeights,
  waterIndex,
  type RadiusGrid,
} from '../mieTable.ts'
import {
  capMoments,
  fraunhoferMomentsInto,
  gaussLegendre,
  legendreInto,
  phaseOf,
} from './legendre.ts'

/*
 * A droplet population's phase function as Legendre moments, from the Mie
 * series itself, and the two media the slab oracle solves from them.
 *
 * The population is the droplet table's: Hansen and Travis's gamma at the
 * table's variance on its radius grid, and a band of nine wavelengths under a
 * raised cosine (`mieTable.ts`). A sphere's intensity with N terms is a
 * polynomial of degree 2N in cos θ, so a Gauss–Legendre rule of 2N + 2 nodes
 * integrates it against every P_l to l = 2N exactly, and the moments are the
 * series' own to rounding. The committed table cannot give them: its texels
 * are 0.28° wide at 90°, and the moments run to l ≈ 2x, features of 0.2°.
 *
 * **The true medium** is `phase`, at the unscaled optical depth τ.
 *
 * **The renderer's medium** takes the diffraction's share of extinction,
 * f_δ = 1/Q_ext, out of both the depth and the phase:
 *
 *   τ′ = (1 − f_δ)·τ        χ′_l = (χ_l − f_δ·χ_l^diff)/(1 − f_δ)
 *
 * with χ^diff the Fraunhofer pattern's moments, area-weighted over the same
 * population. f_δ is the mean of the three bands' 1/Q_ext, because the
 * renderer's scaled extinction is one number a radius and not one a band.
 */

/** One band of a population. */
export interface BandMoments {
  /** nm. */
  readonly center: number
  /** χ_l of the whole Mie phase, l from 0: χ₀ = 1, χ₁ = g. */
  readonly phase: Float64Array
  /** χ_l of the Fraunhofer pattern, on the same l. */
  readonly diffraction: Float64Array
  /** Q_ext, by area. */
  readonly extinction: number
  /** g = ⟨cos θ⟩ from the coefficients' own sum, by scattering. */
  readonly asymmetry: number
}

export interface DropletMoments {
  /** µm: the gamma's effective radius. */
  readonly radius: number
  readonly bands: readonly BandMoments[]
  /** f_δ: one over the bands' mean Q_ext. */
  readonly share: number
}

/**
 * The moments of the population at effective radius `radius`, µm, in each of
 * `centers`, nm.
 */
export function dropletMoments(
  radius: number,
  grid: RadiusGrid = RADIUS_GRID,
  centers: readonly number[] = DROPLET_TABLE.bands,
): DropletMoments {
  const radii = radiusGrid(grid)
  const { first, weights } = rowWeights(radii, radius, DROPLET_TABLE.variance)
  const largest = radii[first + weights.length - 1]!
  const bands = centers.map((center): BandMoments => {
    const { wavelengths, weights: bandWeights } = band(center)
    const shortest = Math.min(...wavelengths) / 1000
    const terms = wiscombeTerms((2 * Math.PI * largest) / shortest)
    // 2N + 2 nodes, symmetric about zero; the positive half is summed and
    // its mirror comes with it.
    const half = terms + 1
    const rule = gaussLegendre(2 * half)
    const cosines = rule.nodes.subarray(half)
    const table = angularTable(cosines, terms)
    const forward = new Float64Array(half)
    const backward = new Float64Array(half)
    const lightForward = new Float64Array(half)
    const lightBackward = new Float64Array(half)
    const count = 2 * terms + 1
    const diffraction = new Float64Array(count)
    let scattering = 0
    let extinction = 0
    let asymmetry = 0
    let area = 0
    wavelengths.forEach((nm, l) => {
      const um = nm / 1000
      const m = waterIndex(nm)
      const cross = (um * um) / (8 * Math.PI * Math.PI)
      for (let i = 0; i < weights.length; i += 1) {
        const r = radii[first + i]!
        const x = (2 * Math.PI * r) / um
        const series = mieSeries(x, m)
        const q = efficiencies(series)
        mirroredIntensities(series, table, forward, backward)
        const f = bandWeights[l]! * weights[i]!
        const disk = f * Math.PI * r * r
        for (let k = 0; k < half; k += 1) {
          lightForward[k] = lightForward[k]! + f * cross * forward[k]!
          lightBackward[k] = lightBackward[k]! + f * cross * backward[k]!
        }
        scattering += disk * q.scattering
        extinction += disk * q.extinction
        asymmetry += disk * q.scattering * q.asymmetry
        area += disk
        fraunhoferMomentsInto(x, disk, diffraction)
      }
    })
    const phase = new Float64Array(count)
    const p = new Float64Array(count)
    for (let k = 0; k < half; k += 1) {
      legendreInto(cosines[k]!, count, p)
      const w = (2 * Math.PI * rule.weights[half + k]!) / scattering
      const even = w * (lightForward[k]! + lightBackward[k]!)
      const odd = w * (lightForward[k]! - lightBackward[k]!)
      for (let j = 0; j < count; j += 1)
        phase[j] = phase[j]! + (j % 2 === 0 ? even : odd) * p[j]!
    }
    return {
      center,
      phase,
      diffraction: diffraction.map((value) => value / area),
      extinction: extinction / area,
      asymmetry: asymmetry / scattering,
    }
  })
  const mean = bands.reduce((sum, b) => sum + b.extinction, 0) / bands.length
  return { radius, bands, share: 1 / mean }
}

/** χ′: a band's moments less the Fraunhofer pattern's share, renormalized. */
export function scaledMoments(
  moments: BandMoments,
  share: number,
): Float64Array {
  return moments.phase.map(
    (value, l) => (value - share * moments.diffraction[l]!) / (1 - share),
  )
}

/** The mean of several sets of moments, on the longest set's l: an equal mixture's phase. */
export function meanMoments(sets: readonly Float64Array[]): Float64Array {
  const out = new Float64Array(Math.max(...sets.map((set) => set.length)))
  for (const set of sets)
    for (let l = 0; l < set.length; l += 1)
      out[l] = out[l]! + set[l]! / sets.length
  return out
}

/** The sun's angular radius from 1 au, radians: 959.63″ (IAU 2015 nominal radius over the au). */
export const SOLAR_ANGULAR_RADIUS = 0.00465247

/**
 * A phase function a first-order term reads at any angle: the moments'
 * series, convolved with a sun's disk of angular radius `sun`, radians.
 */
export function exactPhase(
  moments: Float64Array,
  sun: number = SOLAR_ANGULAR_RADIUS,
): (mu: number) => number {
  const cap = capMoments(sun, moments.length)
  const convolved = moments.map((value, l) => value * cap[l]!)
  return (mu) => phaseOf(convolved, mu)
}

/**
 * The share of a phase function that is under zero: ∫max(−p, 0) dΩ, on a
 * Gauss rule of twice the moments' count. Taking a Fraunhofer pattern out of
 * a Mie phase leaves a function that dips under zero in the pattern's dark
 * rings, where a sphere's own light is the smaller of the two; this is how
 * much of the medium that is.
 */
export function negativeShare(moments: Float64Array): number {
  const rule = gaussLegendre(2 * moments.length)
  let sum = 0
  for (let k = 0; k < rule.nodes.length; k += 1)
    sum += rule.weights[k]! * Math.max(0, -phaseOf(moments, rule.nodes[k]!))
  return 2 * Math.PI * sum
}
