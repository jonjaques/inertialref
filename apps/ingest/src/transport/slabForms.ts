import {
  bearingCosine,
  stretchedHarmonic,
  viewReads,
  viewSlabs,
  type SlabViewBlend,
} from '@inertialref/rendering'
import { halfRangeGauss } from './legendre.ts'
import {
  lobe,
  sourceSamples,
  type SourceDirections,
  type SourceGrid,
  type SourceMedium,
  type SourceOptions,
  type SourceRay,
  type SourceRead,
  type SourceRun,
} from './slabSource.ts'

/*
 * The forms a source table can take: what a slab's four channels are, how
 * they are fitted to the oracle's samples, and which slabs a ray reads with
 * which weights.
 *
 * A march reads the table once or twice a step and multiplies. Everything
 * else a form needs is constant along a ray, so it is the ray's to work out
 * once: which hemisphere the light travels in, its cosine to the lit face's
 * normal, its bearing from the sun's, and any function of them. So a form is
 * a set of slabs and, for a ray, at most two of them with four weights each:
 *
 *   S_h = Σ_reads Σ_channels texel(slab; t_d, t_b, μ₀)[channel]·weight[channel]
 *
 * and the forms differ in what they spend the slabs on. `threeTerms` is one
 * slab of (J₀, J₁, J_f) over the whole sphere. `hemispheres` fits the light
 * going toward the lit face and away from it apart, because across the
 * horizon the source is a step. `viewNodes` tabulates the source at
 * cosines of its own in each hemisphere and fits only its bearing, and a
 * ray blends the two cosines it lies between.
 */

/** A function of a ray: one of the things a channel is multiplied by. */
export interface SourceBasis {
  readonly name: string
  at(ray: SourceRay): number
}

export const ONE: SourceBasis = { name: '1', at: () => 1 }
/** The cosine to the lit face's outward normal. */
export const COSINE: SourceBasis = { name: 'μ', at: (ray) => ray.muV }
/** The part of the light's direction along the sun's bearing: sin θ·cos φ. */
export const ALONG: SourceBasis = { name: 'h', at: (ray) => ray.along }
/** cos kφ: the k-th harmonic of the bearing. */
export function harmonic(k: number): SourceBasis {
  return {
    name: k === 0 ? '1' : `cos ${k === 1 ? '' : k}φ`,
    at: (ray) => Math.cos(k * Math.acos(bearingCosine(ray))),
  }
}

/**
 * cos kψ, with ψ the bearing stretched near the sun's own: ψ = π·(φ/π)^power.
 * A power under one spends the harmonics where a source's lobe is.
 */
export function stretched(k: number, power: number): SourceBasis {
  return {
    name: k === 0 ? '1' : `cos ${k}ψ(${power})`,
    at: (ray) => stretchedHarmonic(k, power, bearingCosine(ray)),
  }
}

/** Φ(ν) = 4π·HG(ν; asymmetry) − 1: a lobe about the sun's own direction. */
export function lobeBasis(asymmetry: number): SourceBasis {
  return {
    name: `Φ(${Number(asymmetry.toPrecision(4))})`,
    at: (ray) => lobe(ray.nu, asymmetry),
  }
}

/** The product of two bases. */
export function times(a: SourceBasis, b: SourceBasis): SourceBasis {
  return { name: `${a.name}·${b.name}`, at: (ray) => a.at(ray) * b.at(ray) }
}

/** How a fit counts a sample's error: as it is, or over the sample. */
export type SourceMeasure = 'absolute' | 'relative'

/** A form of the table. */
export interface SourceForm {
  readonly name: string
  /** Stacks of the sun's slices the form fills. */
  readonly slabs: number
  /** A cell's texels, four a slab, from its samples. */
  fit(samples: Float64Array, directions: SourceDirections): Float64Array
  /** The slabs a ray reads, at most two, and each one's weights. */
  reads(ray: SourceRay): SourceRead[]
}

/** The cosine of the forward cone the rubric's domain leaves out: 6° from the sun. */
const CONE = /*@__PURE__*/ Math.cos((6 * Math.PI) / 180)

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

/** A fit's samples: which of a cell's, and what each basis is at each. */
interface FitSet {
  /** Indices into the cell's samples. */
  readonly samples: readonly number[]
  /** A column a basis, the basis at each of those samples. */
  readonly columns: readonly Float64Array[]
  /** Each sample's measure: a solid angle, or a share of the circle. */
  readonly weights: Float64Array
}

/**
 * The coefficients that fit a cell's samples by weighted least squares.
 * The relative measure divides each sample's error by the sample. A `ridge`
 * over zero scales each column to unit length and adds itself to the
 * diagonal: a fit whose bases are nearly one function at a node (a lobe and
 * a constant, straight up) has coefficients that cancel to six figures
 * without it, which a half float does not hold.
 */
function leastSquares(
  samples: Float64Array,
  set: FitSet,
  measure: SourceMeasure,
  ridge: number,
): number[] {
  const terms = set.columns.length
  // A source is positive; where rounding leaves a sample at or under zero,
  // the relative measure counts it at the mean's ten-thousandth.
  let mean = 0
  let total = 0
  set.samples.forEach((at, k) => {
    mean += set.weights[k]! * samples[at]!
    total += set.weights[k]!
  })
  // A slab of no depth has no source, and nothing to divide by.
  if (!(mean > 0)) return new Array<number>(terms).fill(0)
  const floor = (1e-4 * mean) / total
  const a = new Array<number>(terms * terms).fill(0)
  const b = new Array<number>(terms).fill(0)
  set.samples.forEach((at, k) => {
    const value = samples[at]!
    const scale = measure === 'relative' ? 1 / Math.max(floor, value) : 1
    const weight = set.weights[k]! * scale * scale
    for (let i = 0; i < terms; i += 1) {
      const left = set.columns[i]![k]!
      b[i] = b[i]! + weight * left * value
      for (let j = 0; j < terms; j += 1)
        a[i * terms + j] =
          a[i * terms + j]! + weight * left * set.columns[j]![k]!
    }
  })
  if (ridge === 0) {
    solveSmall(a, b, terms)
    return b
  }
  // A basis that is zero at every sample has no length and takes no part.
  const length = Array.from({ length: terms }, (_, i) =>
    a[i * terms + i]! > 0 ? Math.sqrt(a[i * terms + i]!) : 1,
  )
  const scaled = a.map(
    (value, at) =>
      value / (length[Math.floor(at / terms)]! * length[at % terms]!),
  )
  for (let i = 0; i < terms; i += 1)
    scaled[i * terms + i] = scaled[i * terms + i]! + ridge
  const right = b.map((value, i) => value / length[i]!)
  solveSmall(scaled, right, terms)
  return right.map((value, i) => value / length[i]!)
}

/** A cell's samples as a ray each, for a basis to be evaluated at. */
function rayAt(directions: SourceDirections, at: number): SourceRay {
  return {
    sunMu: directions.sunMu,
    muV: directions.muV[at]!,
    along: directions.along[at]!,
    nu: directions.nu[at]!,
  }
}

/** The samples a fit of the whole of one hemisphere, or of both, is made on. */
function hemisphereSet(
  directions: SourceDirections,
  basis: readonly SourceBasis[],
  keep: (ray: SourceRay) => boolean,
): FitSet {
  const samples: number[] = []
  for (let at = 0; at < directions.muV.length; at += 1)
    if (keep(rayAt(directions, at))) samples.push(at)
  return {
    samples,
    columns: basis.map((item) =>
      Float64Array.from(samples, (at) => item.at(rayAt(directions, at))),
    ),
    weights: Float64Array.from(samples, (at) => directions.solid[at]!),
  }
}

/** Fit sets are the directions' alone, so one sun's are made once and kept. */
function memo<Value>(
  make: (directions: SourceDirections) => Value,
): (directions: SourceDirections) => Value {
  const kept = new WeakMap<SourceDirections, Value>()
  return (directions) => {
    let value = kept.get(directions)
    if (value === undefined) {
      value = make(directions)
      kept.set(directions, value)
    }
    return value
  }
}

/** Four weights of a ray, from up to four bases. */
function weightsOf(
  basis: readonly SourceBasis[],
  ray: SourceRay,
  scale = 1,
): [number, number, number, number] {
  const at = (k: number): number => scale * (basis[k]?.at(ray) ?? 0)
  return [at(0), at(1), at(2), at(3)]
}

export interface ThreeTermsOptions {
  /** The lobe's asymmetry. */
  readonly lobe: number
  readonly measure: SourceMeasure
  /** Whether the third term is fitted; without it the form is (J₀, J₁) alone. */
  readonly withLobe: boolean
}

/**
 * One slab over the whole sphere: J₀ + J₁·μ_v + J_f·Φ(ν), the form the first
 * table had. Its fit is on every sample, the forward cone's with the rest.
 */
export function threeTerms(options: ThreeTermsOptions): SourceForm {
  const basis = options.withLobe
    ? [ONE, COSINE, lobeBasis(options.lobe)]
    : [ONE, COSINE]
  const sets = memo((directions) =>
    hemisphereSet(directions, basis, () => true),
  )
  return {
    name: `three-${options.measure}${options.withLobe ? '' : '-plain'}`,
    slabs: 1,
    fit: (samples, directions) =>
      Float64Array.from(
        { length: 4 },
        (_, k) =>
          leastSquares(samples, sets(directions), options.measure, 0)[k] ?? 0,
      ),
    reads: (ray) => [{ slab: 0, weights: weightsOf(basis, ray) }],
  }
}

export interface HemispheresOptions {
  readonly name: string
  /** Up to eight bases: four a read. */
  readonly basis: readonly SourceBasis[]
  readonly measure: SourceMeasure
  readonly ridge?: number
}

/**
 * The two hemispheres fitted apart: light traveling toward the lit face
 * reads one set of slabs and light traveling away from it another, each
 * with the same bases. A slab holds four coefficients, so up to four bases
 * are one read a step and up to eight are two.
 */
export function hemispheres(options: HemispheresOptions): SourceForm {
  const { basis } = options
  if (basis.length < 1 || basis.length > 8)
    throw new Error(`slabForms: ${basis.length} bases are not one or two reads`)
  const each = Math.ceil(basis.length / 4)
  const sets = memo((directions) => [
    hemisphereSet(directions, basis, (ray) => ray.muV > 0),
    // Away from the lit face the forward cone is not judged, and its peak
    // would be all a fit on the source itself sees.
    hemisphereSet(directions, basis, (ray) => ray.muV < 0 && ray.nu < CONE),
  ])
  return {
    name: options.name,
    slabs: 2 * each,
    fit: (samples, directions) => {
      const out = new Float64Array(2 * each * 4)
      sets(directions).forEach((set, side) => {
        const fitted = leastSquares(
          samples,
          set,
          options.measure,
          options.ridge ?? 1e-9,
        )
        fitted.forEach((value, k) => {
          out[side * each * 4 + k] = value
        })
      })
      return out
    },
    reads: (ray) =>
      Array.from({ length: each }, (_, r) => ({
        slab: (ray.muV >= 0 ? 0 : each) + r,
        weights: weightsOf(basis.slice(4 * r, 4 * r + 4), ray),
      })),
  }
}

export interface ViewNodesOptions {
  readonly name: string
  /**
   * The cosines the source is tabulated at in each hemisphere, ascending.
   * Each is one of the oracle's own quadrature cosines, so a node's samples
   * are the solution there and not an interpolation.
   */
  readonly cosines: readonly number[]
  /** Up to four bases of the bearing, fitted at each cosine. */
  readonly basis: readonly SourceBasis[]
  /**
   * Where the bases are `stretched(k, stretch)` for k = 0…3: a ray's reads
   * are then `viewReads`, the read the game's node is held to.
   */
  readonly stretch?: number
  readonly measure: SourceMeasure
  readonly ridge?: number
  /** What a ray between two cosines blends in (`SlabViewBlend`); the angle where left out. */
  readonly blend?: SlabViewBlend
}

/**
 * The view's cosine as a coordinate of the table. Each hemisphere has a
 * slab a cosine; a slab's four channels are the fit, at that cosine, of the
 * source's dependence on bearing; and a ray reads the two slabs whose
 * cosines it lies between, blended by its own. A ray steeper or shallower
 * than every node reads the nearest.
 */
export function viewNodes(options: ViewNodesOptions): SourceForm {
  const { basis, cosines } = options
  if (basis.length > 4)
    throw new Error(`slabForms: ${basis.length} bases are not one texel`)
  const count = cosines.length
  const sets = memo((directions) => {
    const bearings = directions.azimuths.length
    const q = directions.cosines.length
    const out: FitSet[] = []
    // Toward the lit face first, then away from it.
    for (const toward of [true, false])
      for (const cosine of cosines) {
        const node = directions.cosines.findIndex(
          (value) => Math.abs(value - cosine) < 1e-12,
        )
        if (node < 0)
          throw new Error(
            `slabForms: ${cosine} is not one of the oracle's quadrature cosines`,
          )
        const from = (toward ? q + node : node) * bearings
        const all = Array.from({ length: bearings }, (_, a) => from + a)
        const outside = all.filter((at) => toward || directions.nu[at]! < CONE)
        // A cosine whose every bearing is inside the cone is fitted on all of them.
        const samples = outside.length >= basis.length ? outside : all
        out.push({
          samples,
          columns: basis.map((item) =>
            Float64Array.from(samples, (at) => item.at(rayAt(directions, at))),
          ),
          weights: Float64Array.from(
            samples,
            (at) => directions.shares[at % bearings]!,
          ),
        })
      }
    return out
  })
  return {
    name: options.name,
    slabs: 2 * count,
    fit: (samples, directions) => {
      const out = new Float64Array(2 * count * 4)
      sets(directions).forEach((set, slab) => {
        leastSquares(
          samples,
          set,
          options.measure,
          options.ridge ?? 1e-9,
        ).forEach((value, k) => {
          out[slab * 4 + k] = value
        })
      })
      return out
    },
    reads: (ray) =>
      options.stretch === undefined
        ? viewSlabs(cosines, ray.muV, options.blend).map(({ slab, share }) => ({
            slab,
            weights: weightsOf(basis, ray, share),
          }))
        : viewReads(
            { cosines, stretch: options.stretch, blend: options.blend },
            ray,
          ),
  }
}

/** The oracle's quadrature cosines nearest each of `targets`, ascending and distinct. */
export function quadratureCosines(
  streams: number,
  targets: readonly number[],
): number[] {
  const { nodes } = halfRangeGauss(streams / 2)
  const picked = targets.map((target) =>
    nodes.reduce((best, value) =>
      Math.abs(value - target) < Math.abs(best - target) ? value : best,
    ),
  )
  return [...new Set(picked)].sort((a, b) => a - b)
}

/** Every form's table from one run of the oracle's interior. */
export interface Tabulated extends SourceRun {
  /** A form's texels by its name, laid out [slab][sun][bottom][top][channel]. */
  readonly tables: ReadonlyMap<string, Float64Array>
}

/**
 * Each form's table: the oracle's source at every node, fitted a cell at a
 * time by every form at once, so that the forms are compared on one
 * solution.
 */
export function tabulate(
  medium: SourceMedium,
  grid: SourceGrid,
  streams: number,
  forms: readonly SourceForm[],
  options: SourceOptions = {},
): Tabulated {
  const plane = grid.nodes * grid.nodes
  const tables = new Map(
    forms.map((form) => [
      form.name,
      new Float64Array(form.slabs * grid.suns * plane * 4),
    ]),
  )
  const run = sourceSamples(
    medium,
    grid,
    streams,
    options,
    (cell, samples, directions) => {
      for (const form of forms) {
        const fitted = form.fit(samples, directions)
        const table = tables.get(form.name)!
        for (let slab = 0; slab < form.slabs; slab += 1)
          table.set(
            fitted.subarray(slab * 4, slab * 4 + 4),
            (((slab * grid.suns + cell.sun) * grid.nodes + cell.bottom) *
              grid.nodes +
              cell.top) *
              4,
          )
      }
    },
  )
  return { ...run, tables }
}
