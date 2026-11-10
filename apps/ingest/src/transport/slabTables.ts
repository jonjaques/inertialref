import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rootSeed } from '@inertialref/procedural'
import {
  firstOrder,
  scatteringCosine,
  solveSlab,
  type SlabMedium,
} from './addingDoubling.ts'
import { capMoments, halfRangeGauss, legendreInto } from './legendre.ts'
import {
  SOLAR_ANGULAR_RADIUS,
  dropletMoments,
  exactPhase,
  meanMoments,
  negativeShare,
  scaledMoments,
} from './moments.ts'
import { phaseTable, traceRow, type TraceRow } from './monteCarloSlab.ts'
import {
  higherOrders,
  sourceTerms,
  type SourceFit,
  type SourceGrid,
  type SourceMedium,
  type SourceTable,
} from './slabSource.ts'

/*
 * The slab tables' generator. The oracle's rows are minutes of arithmetic,
 * so it runs in stages, each a process, each writing what it made under
 * `.data/weather/slab/`; `write` then reads them all and writes the two
 * generated files. Up to four stages run at once:
 *
 *   node apps/ingest/src/transport/slabTables.ts reference 6     (and 10, 16)
 *   node apps/ingest/src/transport/slabTables.ts source 16 0 2   (nodes, part, parts)
 *   node apps/ingest/src/transport/slabTables.ts flux
 *   node apps/ingest/src/transport/slabTables.ts montecarlo 5    (and 10, 20, 50, bill, glory)
 *   node apps/ingest/src/transport/slabTables.ts write
 *   pnpm exec prettier -w packages/rendering/src/slabReference.generated.ts \
 *     packages/rendering/src/slabSource.generated.ts
 *
 * Nothing a stage writes, and nothing in a generated file, names the machine
 * or the time: two runs are byte-equal.
 */

/** The rubric's domain of "within 5%" (the MVP's §6.1), and the depths recorded under it. */
export const SLAB_DOMAIN = {
  radii: [6, 10, 16],
  depths: { grid: [5, 10, 20, 50], held: [7, 30], thin: [0.5, 1, 2] },
  suns: { grid: [1, 0.5, 0.2], held: [0.7, 0.35] },
  views: [0.2, 0.4, 0.6, 0.8, 1],
  azimuths: [0, 45, 90, 135, 180],
} as const

/** Streams each medium is solved at. */
export const SLAB_STREAMS = { truth: 256, scaled: 128 } as const

export type SlabSide = 'reflected' | 'transmitted'
/** Which part of the domain a slab is: fitted on, judged on, or recorded. */
export type SlabSet = 'grid' | 'held' | 'thin'

/**
 * Whether a direction is in the domain, by its scattering angle, degrees.
 * Reflected light within 8° of the antisolar direction or from 136° to 146°
 * is the glory's and the cloudbow's, held by their own test; transmitted
 * light within 6° of the sun is the forward cone.
 */
export function inDomain(side: SlabSide, angle: number): boolean {
  return side === 'reflected'
    ? angle < 172 && !(angle >= 136 && angle <= 146)
    : angle > 6
}

/** The scattering angle, degrees. */
export function scatteringAngle(
  sunMu: number,
  viewMu: number,
  azimuth: number,
  side: SlabSide,
): number {
  const cosine = scatteringCosine(
    sunMu,
    viewMu,
    (azimuth * Math.PI) / 180,
    side,
  )
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI
}

/** One band of a population as the oracle's two problems. */
export interface SlabBand {
  readonly center: number
  /** The whole Mie phase, at the unscaled depth. */
  readonly truth: SlabMedium
  /** The scaled phase, at the scaled depth. */
  readonly scaled: SlabMedium
  /** The whole phase through the sun's disk, sr⁻¹: what the march's first order reads. */
  readonly whole: (mu: number) => number
  /** χ of the whole phase, and of the Fraunhofer pattern, through the sun's disk. */
  readonly disk: Float64Array
  readonly pattern: Float64Array
  /** The share of the scaled phase that is under zero. */
  readonly negative: number
}

/** A droplet population as the oracle solves it. */
export interface SlabPopulation {
  readonly radius: number
  /** f_δ. */
  readonly share: number
  /** g′ = (g − f_δ)/(1 − f_δ), from the bands' mean g. */
  readonly asymmetry: number
  readonly bands: readonly SlabBand[]
  /** A digest of the moments, to ten figures: what a generated file names its input by. */
  readonly digest: string
}

export function slabPopulation(radius: number): SlabPopulation {
  const droplets = dropletMoments(radius)
  const hash = createHash('sha256')
  const bands = droplets.bands.map((band): SlabBand => {
    const scaled = scaledMoments(band, droplets.share)
    const cap = capMoments(SOLAR_ANGULAR_RADIUS, band.diffraction.length)
    for (const value of band.phase) hash.update(value.toPrecision(10))
    for (const value of band.diffraction) hash.update(value.toPrecision(10))
    return {
      center: band.center,
      truth: { moments: band.phase, phase: exactPhase(band.phase) },
      scaled: { moments: scaled, phase: exactPhase(scaled) },
      whole: exactPhase(band.phase),
      disk: band.phase.map((value, l) => value * cap[l]!),
      pattern: band.diffraction.map((value, l) => value * cap[l]!),
      negative: negativeShare(scaled),
    }
  })
  const g =
    droplets.bands.reduce((sum, band) => sum + band.asymmetry, 0) /
    droplets.bands.length
  return {
    radius,
    share: droplets.share,
    asymmetry: (g - droplets.share) / (1 - droplets.share),
    bands,
    digest: hash.digest('hex').slice(0, 16),
  }
}

/** A value a band of the population: three, for the table's three bands. */
type Triple = readonly number[]

/** One geometry of one slab, a band a channel. */
export interface ReferenceRow {
  readonly radius: number
  readonly depth: number
  readonly sunMu: number
  readonly viewMu: number
  readonly azimuth: number
  readonly side: SlabSide
  readonly set: SlabSet
  /** The scattering angle, degrees, and whether the rubric's domain holds the direction. */
  readonly angle: number
  readonly domain: boolean
  /** The renderer's medium: the scaled medium's orders past the first, under first order on the whole phase. */
  readonly scaled: Triple
  /** That first order alone. */
  readonly first: Triple
  /** The true medium. */
  readonly truth: Triple
  /** The scaled medium with its own first order, for the record: it is in no generated file. */
  readonly pure: Triple
}

/** One slab's reflected flux over the flux arriving. */
export interface ReferenceFlux {
  readonly radius: number
  readonly depth: number
  readonly sunMu: number
  readonly set: SlabSet
  /** The renderer's medium, the part of it that is first order, and the true medium. */
  readonly scaled: Triple
  readonly first: Triple
  readonly truth: Triple
}

export interface ReferenceStage {
  readonly radius: number
  readonly share: number
  readonly asymmetry: number
  readonly digest: string
  readonly negative: readonly number[]
  /** The delta-M share each solve took out, a band. */
  readonly delta: {
    readonly truth: readonly number[]
    readonly scaled: readonly number[]
  }
  readonly streams: { readonly truth: number; readonly scaled: number }
  readonly rows: readonly ReferenceRow[]
  readonly fluxes: readonly ReferenceFlux[]
}

/** The (depth, sun) pairs of the domain, with the set each is in. */
export function slabPairs(): { depth: number; sunMu: number; set: SlabSet }[] {
  const { depths, suns } = SLAB_DOMAIN
  const pairs: { depth: number; sunMu: number; set: SlabSet }[] = []
  for (const set of ['grid', 'held', 'thin'] as const)
    for (const depth of depths[set])
      for (const sunMu of suns[set === 'held' ? 'held' : 'grid'])
        pairs.push({ depth, sunMu, set })
  return pairs
}

/**
 * First order's reflected flux over the flux arriving, for a phase function
 * of the moments given: (1/μ₀)·∫p(ν)·K(μ)·μ dΩ, with the phase's azimuthal
 * mean from its moments, (1/2)·Σ (2l + 1)·χ_l·P_l(−μ)·P_l(μ₀) over 2π.
 */
function firstOrderFlux(
  moments: Float64Array,
  depth: number,
  sunMu: number,
): number {
  const rule = halfRangeGauss(64)
  const count = moments.length
  const at = new Float64Array(count)
  const sun = new Float64Array(count)
  legendreInto(sunMu, count, sun)
  let flux = 0
  for (let k = 0; k < rule.nodes.length; k += 1) {
    const mu = rule.nodes[k]!
    legendreInto(-mu, count, at)
    let mean = 0
    for (let l = 0; l < count; l += 1)
      mean += (2 * l + 1) * moments[l]! * at[l]! * sun[l]!
    flux +=
      rule.weights[k]! *
      mu *
      (mean / 2) *
      firstOrder(depth, sunMu, mu, 'reflected')
  }
  return flux / sunMu
}

/** What a reference stage solves; the whole domain where a member is left out. */
export interface ReferenceOptions {
  readonly streams?: { readonly truth: number; readonly scaled: number }
  readonly pairs?: readonly {
    readonly depth: number
    readonly sunMu: number
    readonly set: SlabSet
  }[]
  readonly views?: readonly number[]
  readonly azimuths?: readonly number[]
}

/** A population's rows: every slab of the domain, both media, every band. */
export function referenceStage(
  population: SlabPopulation,
  options: ReferenceOptions = {},
): ReferenceStage {
  const streams = options.streams ?? SLAB_STREAMS
  const pairs = options.pairs ?? slabPairs()
  const views = options.views ?? SLAB_DOMAIN.views
  const azimuths = options.azimuths ?? SLAB_DOMAIN.azimuths
  const depths = [...new Set(pairs.map((pair) => pair.depth))]
  const suns = [...new Set(pairs.map((pair) => pair.sunMu))]
  const keep = 1 - population.share
  const solved = population.bands.map((band) => ({
    truth: solveSlab({
      medium: band.truth,
      depths,
      suns,
      views,
      azimuths,
      streams: streams.truth,
    }),
    scaled: solveSlab({
      medium: band.scaled,
      depths: depths.map((depth) => depth * keep),
      suns,
      views,
      azimuths,
      streams: streams.scaled,
    }),
  }))
  const triple = (of: (band: number) => number): Triple =>
    population.bands.map((_, band) => of(band))
  const rows: ReferenceRow[] = []
  const fluxes: ReferenceFlux[] = []
  for (const { depth, sunMu, set } of pairs) {
    const d = depths.indexOf(depth)
    const s = suns.indexOf(sunMu)
    fluxes.push({
      radius: population.radius,
      depth,
      sunMu,
      set,
      // The scaled medium's own flux and the pattern's share of first order.
      scaled: triple(
        (b) =>
          solved[b]!.scaled.albedo[d * suns.length + s]! +
          (population.share / keep) *
            firstOrderFlux(population.bands[b]!.pattern, depth * keep, sunMu),
      ),
      first: triple(
        (b) =>
          firstOrderFlux(population.bands[b]!.disk, depth * keep, sunMu) / keep,
      ),
      truth: triple((b) => solved[b]!.truth.albedo[d * suns.length + s]!),
    })
    for (const side of ['reflected', 'transmitted'] as const)
      views.forEach((viewMu, v) =>
        azimuths.forEach((azimuth, a) => {
          const cell =
            ((d * suns.length + s) * views.length + v) * azimuths.length + a
          const cosine = scatteringCosine(
            sunMu,
            viewMu,
            (azimuth * Math.PI) / 180,
            side,
          )
          const angle = scatteringAngle(sunMu, viewMu, azimuth, side)
          const reach = firstOrder(depth * keep, sunMu, viewMu, side)
          const first = triple(
            (b) => (population.bands[b]!.whole(cosine) / keep) * reach,
          )
          const pure = triple((b) => solved[b]!.scaled[side][cell]!)
          rows.push({
            radius: population.radius,
            depth,
            sunMu,
            viewMu,
            azimuth,
            side,
            set,
            angle,
            domain: inDomain(side, angle),
            // First order on the whole phase is the scaled medium's own
            // plus the pattern's share: σ·p = σ′·p′ + σ·f_δ·p_diff.
            scaled: triple(
              (b) =>
                pure[b]! +
                first[b]! -
                population.bands[b]!.scaled.phase!(cosine) * reach,
            ),
            first,
            truth: triple((b) => solved[b]!.truth[side][cell]!),
            pure,
          })
        }),
      )
  }
  return {
    radius: population.radius,
    share: population.share,
    asymmetry: population.asymmetry,
    digest: population.digest,
    negative: population.bands.map((band) => band.negative),
    delta: {
      truth: solved.map((band) => band.truth.delta),
      scaled: solved.map((band) => band.scaled.delta),
    },
    streams,
    rows,
    fluxes,
  }
}

/** The largest relative difference between two of a row's radiances, over rows a filter keeps. */
export function worstDifference<Row extends { readonly domain: boolean }>(
  rows: readonly Row[],
  of: (row: Row) => readonly number[],
  against: (row: Row) => readonly number[],
  keep: (row: Row) => boolean = () => true,
): { readonly error: number; readonly row: Row | null; readonly band: number } {
  let error = 0
  let worst: Row | null = null
  let band = 0
  for (const row of rows) {
    if (!row.domain || !keep(row)) continue
    const a = of(row)
    const b = against(row)
    for (let k = 0; k < a.length; k += 1) {
      const difference = Math.abs(a[k]! / b[k]! - 1)
      if (difference > error) {
        error = difference
        worst = row
        band = k
      }
    }
  }
  return { error, row: worst, band }
}

/* ------------------------------------------------------------ the source */

/** The source table's axes but its node count, which the reconstruction chooses. */
export const SOURCE_AXES = {
  suns: 8,
  sunMuMin: 0.05,
  depthScale: 0.02,
  depthMax: 16,
} as const

/** µm: the radius row the source table is cut at. */
export const SOURCE_RADIUS = 10

/** The medium the source table is cut from: a population's three bands as one, scaled. */
export function sourceMedium(population: SlabPopulation): SourceMedium {
  const moments = meanMoments(
    population.bands.map((band) => band.scaled.moments as Float64Array),
  )
  const cap = capMoments(SOLAR_ANGULAR_RADIUS, moments.length)
  return {
    moments,
    convolved: moments.map((value, l) => value * cap[l]!),
    asymmetry: population.asymmetry,
  }
}

/** One table's reconstruction against the oracle's rows. */
export interface Reconstruction {
  /** The worst relative error over the domain's grid and held-out slabs. */
  readonly error: number
  /** The same over each set alone, and at each thin depth. */
  readonly grid: number
  readonly held: number
  readonly thin: readonly number[]
  /** Root mean square over the grid and the held-out slabs. */
  readonly rms: number
  /**
   * The worst relative error of those slabs' reflected flux, the higher
   * orders summed by the rubric's quadrature: eight Gauss points in μ and
   * sixteen azimuths.
   */
  readonly flux: number
  /** The row that carries `error`, and its band. */
  readonly worst: string
}

/** What a population's rows need of it to be reconstructed. */
export interface SlabScale {
  readonly radius: number
  readonly share: number
  readonly asymmetry: number
}

/** What a march's source adds to a row's first order, through the table's own read. */
export function reconstruct(
  table: SourceTable,
  lobeAsymmetry: number,
  scale: SlabScale,
  row: {
    readonly depth: number
    readonly sunMu: number
    readonly viewMu: number
    readonly azimuth: number
    readonly side: SlabSide
  },
): number {
  return higherOrders(
    table,
    {
      depth: row.depth * (1 - scale.share),
      sunMu: row.sunMu,
      viewMu: row.viewMu,
      azimuth: row.azimuth,
      side: row.side,
    },
    scale.asymmetry,
    lobeAsymmetry,
  )
}

type JudgedRow = Pick<
  ReferenceRow,
  | 'radius'
  | 'depth'
  | 'sunMu'
  | 'viewMu'
  | 'azimuth'
  | 'side'
  | 'set'
  | 'angle'
  | 'domain'
  | 'scaled'
  | 'first'
>

type JudgedFlux = Pick<
  ReferenceFlux,
  'radius' | 'depth' | 'sunMu' | 'set' | 'scaled' | 'first'
>

/** The rubric's quadrature for a flux: eight Gauss points in μ, sixteen azimuths. */
const FLUX_RULE = /*@__PURE__*/ halfRangeGauss(8)
const FLUX_AZIMUTHS = 16

/** The worst relative error of the reflected flux a table rebuilds. */
function judgeFlux(
  table: SourceTable,
  lobeAsymmetry: number,
  scales: readonly SlabScale[],
  fluxes: readonly JudgedFlux[],
): number {
  let worst = 0
  for (const flux of fluxes) {
    if (flux.set === 'thin') continue
    const scale = scales.find((item) => item.radius === flux.radius)!
    let higher = 0
    for (let k = 0; k < FLUX_RULE.nodes.length; k += 1)
      for (let a = 0; a < FLUX_AZIMUTHS; a += 1) {
        // Midpoints around the whole circle; the source is even in azimuth.
        const around = (360 * (a + 0.5)) / FLUX_AZIMUTHS
        higher +=
          FLUX_RULE.weights[k]! *
          FLUX_RULE.nodes[k]! *
          ((2 * Math.PI) / FLUX_AZIMUTHS) *
          reconstruct(table, lobeAsymmetry, scale, {
            depth: flux.depth,
            sunMu: flux.sunMu,
            viewMu: FLUX_RULE.nodes[k]!,
            azimuth: around > 180 ? 360 - around : around,
            side: 'reflected',
          })
      }
    flux.scaled.forEach((exact, band) => {
      worst = Math.max(
        worst,
        Math.abs((flux.first[band]! + higher / flux.sunMu) / exact - 1),
      )
    })
  }
  return worst
}

/** A table's error at every row of the domain, and in every slab's flux. */
export function judge(
  table: SourceTable,
  lobeAsymmetry: number,
  scales: readonly SlabScale[],
  rows: readonly JudgedRow[],
  fluxes: readonly JudgedFlux[],
): Reconstruction {
  const worst = { grid: 0, held: 0 }
  const thin = SLAB_DOMAIN.depths.thin.map(() => 0)
  let squares = 0
  let count = 0
  let error = 0
  let where = ''
  for (const row of rows) {
    if (!row.domain) continue
    const scale = scales.find((item) => item.radius === row.radius)!
    const higher = reconstruct(table, lobeAsymmetry, scale, row)
    row.scaled.forEach((exact, band) => {
      const off = Math.abs((row.first[band]! + higher) / exact - 1)
      if (row.set === 'thin') {
        const at = SLAB_DOMAIN.depths.thin.indexOf(row.depth as 0.5)
        thin[at] = Math.max(thin[at]!, off)
        return
      }
      worst[row.set] = Math.max(worst[row.set], off)
      squares += off * off
      count += 1
      if (off > error) {
        error = off
        where = describeRow(row, band)
      }
    })
  }
  return {
    error,
    grid: worst.grid,
    held: worst.held,
    thin,
    rms: Math.sqrt(squares / Math.max(1, count)),
    flux: judgeFlux(table, lobeAsymmetry, scales, fluxes),
    worst: where,
  }
}

const BAND_NAMES = ['680 nm', '550 nm', '440 nm']

/** A row in a sentence. */
export function describeRow(
  row: Pick<
    ReferenceRow,
    'radius' | 'depth' | 'sunMu' | 'viewMu' | 'azimuth' | 'side' | 'angle'
  >,
  band: number,
): string {
  return `${row.radius} µm, ${BAND_NAMES[band]}, τ ${row.depth}, μ₀ ${row.sunMu}, μ ${row.viewMu} at ${row.azimuth}°, ${row.side}, ${row.angle.toFixed(1)}° from the sun's direction`
}

/* -------------------------------------------------- the black-surface flux */

/** `R(τ, μ₀)`'s axes: ten depths a decade from 0.1 to 100, at ISCCP's two suns. */
export const FLUX_AXES = {
  sunMus: [0.7, 0.4],
  depths: Array.from({ length: 31 }, (_, i) =>
    Number((0.1 * 10 ** (i / 10)).toPrecision(6)),
  ),
} as const

/** The true medium's reflected flux over a black surface, [sun][depth], the three bands as one. */
export function blackSurfaceFlux(population: SlabPopulation): number[] {
  const moments = meanMoments(
    population.bands.map((band) => band.truth.moments as Float64Array),
  )
  const slab = solveSlab({
    medium: { moments },
    depths: FLUX_AXES.depths,
    suns: FLUX_AXES.sunMus,
    views: [],
    azimuths: [],
    streams: SLAB_STREAMS.scaled,
  })
  const flux: number[] = []
  FLUX_AXES.sunMus.forEach((_, s) =>
    FLUX_AXES.depths.forEach((_, d) =>
      flux.push(slab.albedo[d * FLUX_AXES.sunMus.length + s]!),
    ),
  )
  return flux
}

/* --------------------------------------------------------- the Monte Carlo */

/**
 * The Monte Carlo's seed, its slabs, and the paths a committed row walks.
 *
 * A path's collisions grow as the depth squared, 30 µs a path at τ 5 and
 * 1.5 ms at 50, so a deeper slab walks fewer, and a row of τ 20 is inside
 * the slow suite's minute. The thinnest slab walks the most because its
 * score has the longest tail: under the sun at μ₀ 0.2 the light a detector
 * gets is what came down a beam a fifth of a depth long. Traced through
 * one transmitted direction, twenty-four seeds of 200,000 paths stood 1.31
 * of their own standard errors from the oracle, root mean square, where
 * the same paths under a sun overhead stood 0.77. One of them, this seed,
 * was 3.9 off.
 */
export const MONTE_CARLO = {
  seed: 'slab',
  radius: 10,
  band: 1,
  suns: [1, 0.5, 0.2],
  depths: [5, 10, 20, 50],
  paths: [800_000, 200_000, 100_000, 40_000],
  glory: { depth: 10, paths: 1_000_000 },
  views: [
    [0.6, 0, 'reflected'],
    [0.6, 90, 'reflected'],
    [0.2, 90, 'reflected'],
    [0.4, 45, 'reflected'],
    [0.2, 0, 'reflected'],
    [0.8, 90, 'reflected'],
    [0.6, 0, 'transmitted'],
    [0.4, 0, 'transmitted'],
    [0.2, 90, 'transmitted'],
    [0.8, 45, 'transmitted'],
    [0.6, 180, 'transmitted'],
    [0.2, 180, 'transmitted'],
  ],
  /** The slab the scaling's bill is largest in: 6 µm in red at τ 5, toward a low sun. */
  bill: {
    radius: 6,
    band: 0,
    depth: 5,
    paths: 200_000,
    suns: [0.5, 0.35, 0.2],
    views: [
      [0.4, 0, 'transmitted'],
      [0.2, 0, 'transmitted'],
      [0.6, 0, 'transmitted'],
      [0.8, 45, 'reflected'],
    ],
  },
} as const

/** One traced direction under one sun, beside the oracle's two answers. */
export interface MonteCarloRow {
  readonly radius: number
  readonly band: number
  readonly depth: number
  readonly sunMu: number
  readonly viewMu: number
  readonly azimuth: number
  readonly side: SlabSide
  readonly domain: boolean
  readonly paths: number
  readonly mean: number
  readonly error: number
  /** Adding-doubling on the true medium, and on the renderer's. */
  readonly oracle: number
  readonly scaled: number
}

/** One direction of the true medium traced under every sun: a committed row's trace, from its seed. */
export function traceView(
  population: SlabPopulation,
  band: number,
  depth: number,
  suns: readonly number[],
  view: readonly [number, number, SlabSide],
  paths: number,
): TraceRow {
  return traceRow(
    phaseTable(population.bands[band]!.truth.moments as Float64Array),
    {
      depth,
      suns,
      viewMu: view[0],
      azimuth: view[1],
      side: view[2],
      seed: rootSeed(MONTE_CARLO.seed),
    },
    paths,
  )
}

/** The rows of one slab: every view, every sun, traced and solved. */
export function monteCarloRows(
  population: SlabPopulation,
  band: number,
  depth: number,
  suns: readonly number[],
  views: readonly (readonly [number, number, SlabSide])[],
  paths: number,
  streams: { truth: number; scaled: number } = SLAB_STREAMS,
): MonteCarloRow[] {
  const medium = population.bands[band]!
  const table = phaseTable(medium.truth.moments as Float64Array)
  const cosines = [...new Set(views.map((view) => view[0]))]
  const azimuths = [...new Set(views.map((view) => view[1]))]
  const keep = 1 - population.share
  const truth = solveSlab({
    medium: medium.truth,
    depths: [depth],
    suns,
    views: cosines,
    azimuths,
    streams: streams.truth,
  })
  const scaled = solveSlab({
    medium: medium.scaled,
    depths: [depth * keep],
    suns,
    views: cosines,
    azimuths,
    streams: streams.scaled,
  })
  const rows: MonteCarloRow[] = []
  for (const [viewMu, azimuth, side] of views) {
    const traced = traceRow(
      table,
      { depth, suns, viewMu, azimuth, side, seed: rootSeed(MONTE_CARLO.seed) },
      paths,
    )
    suns.forEach((sunMu, s) => {
      const cell =
        (s * cosines.length + cosines.indexOf(viewMu)) * azimuths.length +
        azimuths.indexOf(azimuth)
      const cosine = scatteringCosine(
        sunMu,
        viewMu,
        (azimuth * Math.PI) / 180,
        side,
      )
      rows.push({
        radius: population.radius,
        band,
        depth,
        sunMu,
        viewMu,
        azimuth,
        side,
        domain: inDomain(side, scatteringAngle(sunMu, viewMu, azimuth, side)),
        paths,
        mean: traced.mean[s]!,
        error: traced.error[s]!,
        oracle: truth[side][cell]!,
        scaled:
          scaled[side][cell]! +
          (medium.whole(cosine) / keep - medium.scaled.phase!(cosine)) *
            firstOrder(depth * keep, sunMu, viewMu, side),
      })
    })
  }
  return rows
}

/** The oracle's stream convergence, which a Monte Carlo row is allowed beside its own error. */
export const ORACLE_CONVERGENCE = 0.005

/** Whether a traced row is within 3·SE + 0.5% of adding-doubling. */
export function monteCarloHolds(row: MonteCarloRow): boolean {
  return (
    Math.abs(row.mean - row.oracle) <=
    3 * row.error + ORACLE_CONVERGENCE * row.oracle
  )
}

/** The glory: where its first ring and the trough inside it are, and how bright each is three ways. */
export interface GloryStage {
  readonly radius: number
  readonly band: number
  readonly depth: number
  /** Degrees from the antisolar point. */
  readonly trough: number
  readonly ring: number
  /** Ring over trough: the Monte Carlo on the true medium, with its error, and the oracle twice. */
  readonly traced: number
  readonly error: number
  readonly oracle: number
  readonly scaled: number
  readonly paths: number
}

/** The first minimum of a curve past its start, and the first maximum after it: sample indices. */
function firstRing(values: readonly number[]): readonly [number, number] {
  let trough = 1
  while (trough + 1 < values.length && values[trough + 1]! < values[trough]!)
    trough += 1
  let ring = trough
  while (ring + 1 < values.length && values[ring + 1]! > values[ring]!)
    ring += 1
  return [trough, ring]
}

/** The red glory of a deck from straight above, under a sun straight above it. */
export function gloryStage(
  population: SlabPopulation,
  depth: number,
  paths: number,
  streams: { truth: number; scaled: number } = SLAB_STREAMS,
): GloryStage {
  const band = 0
  const medium = population.bands[band]!
  const step = 0.02
  const curve = Array.from({ length: 300 }, (_, k) =>
    medium.whole(-Math.cos((k * step * Math.PI) / 180)),
  )
  const [troughAt, ringAt] = firstRing(curve)
  const angles = [troughAt * step, ringAt * step]
  const cosines = angles.map((degrees) => Math.cos((degrees * Math.PI) / 180))
  const keep = 1 - population.share
  const solve = (side: 'truth' | 'scaled'): number[] => {
    const slab = solveSlab({
      medium: medium[side],
      depths: [side === 'truth' ? depth : depth * keep],
      suns: [1],
      views: cosines,
      azimuths: [0],
      streams: streams[side],
    })
    return cosines.map((mu, v) =>
      side === 'truth'
        ? slab.reflected[v]!
        : slab.reflected[v]! +
          (medium.whole(-mu) / keep - medium.scaled.phase!(-mu)) *
            firstOrder(depth * keep, 1, mu, 'reflected'),
    )
  }
  const table = phaseTable(medium.truth.moments as Float64Array)
  const traced = cosines.map((viewMu) =>
    traceRow(
      table,
      {
        depth,
        suns: [1],
        viewMu,
        azimuth: 0,
        side: 'reflected',
        seed: rootSeed(MONTE_CARLO.seed),
      },
      paths,
    ),
  )
  const truth = solve('truth')
  const scaled = solve('scaled')
  const ratio = traced[1]!.mean[0]! / traced[0]!.mean[0]!
  return {
    radius: population.radius,
    band,
    depth,
    trough: angles[0]!,
    ring: angles[1]!,
    traced: ratio,
    error:
      ratio *
      Math.hypot(
        traced[0]!.error[0]! / traced[0]!.mean[0]!,
        traced[1]!.error[0]! / traced[1]!.mean[0]!,
      ),
    oracle: truth[1]! / truth[0]!,
    scaled: scaled[1]! / scaled[0]!,
    paths,
  }
}

/* -------------------------------------------------------------- the files */

/**
 * Where the stages are kept. `IR_SLAB_DATA` names another directory, so two
 * whole runs can stand side by side and be compared.
 */
const DATA =
  process.env.IR_SLAB_DATA ??
  fileURLToPath(new URL('../../../../.data/weather/slab/', import.meta.url))
const RENDERING = fileURLToPath(
  new URL('../../../../packages/rendering/src/', import.meta.url),
)

function save(name: string, value: unknown): void {
  mkdirSync(DATA, { recursive: true })
  writeFileSync(`${DATA}${name}.json`, JSON.stringify(value))
  console.log(`slabTables: wrote ${DATA}${name}.json`)
}

function load<Value>(name: string): Value {
  return JSON.parse(readFileSync(`${DATA}${name}.json`, 'utf8')) as Value
}

/** A stage's source terms, as the stage file holds them. */
interface SourceStage {
  readonly nodes: number
  readonly streams: number
  readonly lobe: number
  readonly asymmetry: number
  readonly digest: string
  readonly delta: number
  readonly modes: number
  readonly fits: Record<SourceFit | 'absolutePlain' | 'relativePlain', number[]>
}

/** Five figures: a radiance's rounding is 10⁻⁵ of it, a hundredth of the oracle's own convergence. */
const five = (value: number): number => Number(value.toPrecision(5))
const percent = (value: number): string => `${(100 * value).toFixed(2)}%`

/** The shortest decimal that rounds to the same half float as `value`. */
export function halfDecimal(value: number): number {
  const half = Math.f16round(value)
  for (let digits = 1; digits <= 9; digits += 1) {
    const short = Number(half.toPrecision(digits))
    if (Math.f16round(short) === half) return short
  }
  return half
}

/** A source stage as a table a march reads, by one of its fits. */
export function stageTable(
  stage: SourceStage,
  fit: keyof SourceStage['fits'],
): SourceTable {
  return {
    ...SOURCE_AXES,
    nodes: stage.nodes,
    terms: stage.fits[fit].map(halfDecimal),
  }
}

/**
 * A header: runs of lines are paragraphs, filled to 76 columns, so a figure
 * of any length leaves no line long; an empty line parts two paragraphs,
 * and a line that starts with two spaces is kept as it is written.
 */
function comment(lines: readonly string[]): string {
  const out: string[] = []
  let words: string[] = []
  const fill = (): void => {
    let line = ''
    for (const word of words) {
      if (line !== '' && line.length + 1 + word.length > 76) {
        out.push(line)
        line = word
      } else line = line === '' ? word : `${line} ${word}`
    }
    if (line !== '') out.push(line)
    words = []
  }
  for (const line of lines) {
    if (line === '' || line.startsWith('  ')) {
      fill()
      out.push(line)
    } else words.push(...line.split(' '))
  }
  fill()
  return (
    '/*\n' +
    out.map((line) => (line ? ` * ${line}` : ' *')).join('\n') +
    '\n */\n'
  )
}

/**
 * Numbers as a generated file holds them: text, parsed where the file is
 * read. An array literal of thirty thousand numbers is thirty thousand
 * operands to the complexity score, and a number a line is thirty thousand
 * lines to it: either way it reads a table as the most complex file in the
 * tree.
 */
function numbersText(values: readonly number[], perLine: number): string {
  const lines: string[] = []
  for (let at = 0; at < values.length; at += perLine)
    lines.push(values.slice(at, at + perLine).join(' '))
  return '`\n' + lines.join('\n') + '\n`'
}

/** Records as a generated file holds them, for the same reason: JSON text, a record a line. */
function recordsText(records: readonly object[]): string {
  return (
    '`[\n' +
    records.map((record) => JSON.stringify(record)).join(',\n') +
    '\n]`'
  )
}

/** The parser a generated file carries for `numbersText`. */
const NUMBERS_TEXT = [
  '/** The numbers a block of text holds, a row a line. */',
  'function numbers(text: string): readonly number[] {',
  '  return text.trim().split(/\\s+/).map(Number)',
  '}',
  '',
]

/**
 * The rows as the generated file holds them: the domain's axes once, and
 * nine radiances a row. Written out a row an object the file is a megabyte
 * that every importer of the rendering package parses; this is a third of
 * it, and the file rebuilds the rows where it is read.
 */
function rowsText(rows: readonly ReferenceRow[]): string[] {
  const pairs = slabPairs()
  const sides = ['reflected', 'transmitted'] as const
  const { radii, views, azimuths } = SLAB_DOMAIN
  const angles: number[] = []
  const radiance: number[] = []
  let domain = ''
  let at = 0
  radii.forEach((radius, r) => {
    for (const pair of pairs)
      for (const side of sides)
        for (const viewMu of views)
          for (const azimuth of azimuths) {
            const row = rows[at]
            // The layout is the stages' own order; a row out of it is a
            // table whose radiances would be read at the wrong geometry.
            if (
              row === undefined ||
              row.radius !== radius ||
              row.depth !== pair.depth ||
              row.sunMu !== pair.sunMu ||
              row.set !== pair.set ||
              row.side !== side ||
              row.viewMu !== viewMu ||
              row.azimuth !== azimuth
            )
              throw new Error(
                `slabTables: row ${at} is not where the layout puts it`,
              )
            if (r === 0) {
              angles.push(Number(row.angle.toFixed(1)))
              domain += row.domain ? '1' : '0'
            }
            radiance.push(
              ...row.scaled.map(five),
              ...row.first.map(five),
              ...row.truth.map(five),
            )
            at += 1
          }
  })
  if (at !== rows.length)
    throw new Error(
      `slabTables: ${rows.length} rows where the layout holds ${at}`,
    )
  return [
    `const RADII = ${JSON.stringify(radii)} as const`,
    `const VIEWS = ${JSON.stringify(views)} as const`,
    `const AZIMUTHS = ${JSON.stringify(azimuths)} as const`,
    "const SIDES = ['reflected', 'transmitted'] as const",
    '/** The domain’s slabs: an unscaled depth, a sun’s cosine, and the set the slab is in. */',
    `const SLABS = ${JSON.stringify(pairs.map((pair) => [pair.depth, pair.sunMu, pair.set]))} as const`,
    ...NUMBERS_TEXT,
    '/** Each geometry’s scattering angle, degrees, laid out [slab][side][view][azimuth]. */',
    `const ANGLES = /*@__PURE__*/ numbers(${numbersText(angles, 25)})`,
    '/** On the same layout: 1 where the rubric’s domain holds the geometry. */',
    `const DOMAIN = '${domain}'`,
    '/**',
    ' * `scaled`, `first` and `truth`, three bands each, laid out',
    ' * [radius][slab][side][view][azimuth]: a line is one face of one slab.',
    ' */',
    // A line is one face of one slab at one radius: twenty-five rows.
    `const RADIANCE = /*@__PURE__*/ numbers(${numbersText(radiance, 225)})`,
    '',
    'interface SlabReferenceRow {',
    '  readonly radius: number',
    '  readonly depth: number',
    '  readonly sunMu: number',
    '  readonly viewMu: number',
    '  readonly azimuth: number',
    "  readonly side: 'reflected' | 'transmitted'",
    "  readonly set: 'grid' | 'held' | 'thin'",
    '  readonly angle: number',
    '  readonly domain: boolean',
    '  readonly scaled: readonly [number, number, number]',
    '  readonly first: readonly [number, number, number]',
    '  readonly truth: readonly [number, number, number]',
    '}',
    '',
    '/** A slab’s reflected flux over the flux arriving, a band a channel. */',
    'interface SlabReferenceFlux {',
    '  readonly radius: number',
    '  readonly depth: number',
    '  readonly sunMu: number',
    "  readonly set: 'grid' | 'held' | 'thin'",
    '  /** The renderer’s medium, the part of it that is first order, and the true medium. */',
    '  readonly scaled: readonly [number, number, number]',
    '  readonly first: readonly [number, number, number]',
    '  readonly truth: readonly [number, number, number]',
    '}',
    '',
    '/** One traced direction under one sun: radiance per unit of the sun’s irradiance, in one band. */',
    'interface SlabMonteCarloRow {',
    '  readonly radius: number',
    '  /** The band’s index: 0 is 680 nm. */',
    '  readonly band: number',
    '  readonly depth: number',
    '  readonly sunMu: number',
    '  readonly viewMu: number',
    '  readonly azimuth: number',
    "  readonly side: 'reflected' | 'transmitted'",
    '  readonly domain: boolean',
    '  readonly paths: number',
    '  /** The trace’s mean and its standard error. */',
    '  readonly mean: number',
    '  readonly error: number',
    '  /** Adding-doubling on the true medium, and on the renderer’s. */',
    '  readonly oracle: number',
    '  readonly scaled: number',
    '}',
    '',
    '/** The rows, rebuilt from the axes and the radiances. */',
    'function slabReferenceRows(): SlabReferenceRow[] {',
    '  const rows: SlabReferenceRow[] = []',
    '  const triple = (at: number): [number, number, number] => [',
    '    RADIANCE[at]!,',
    '    RADIANCE[at + 1]!,',
    '    RADIANCE[at + 2]!,',
    '  ]',
    '  let at = 0',
    '  for (const radius of RADII) {',
    '    let geometry = 0',
    '    for (const [depth, sunMu, set] of SLABS)',
    '      for (const side of SIDES)',
    '        for (const viewMu of VIEWS)',
    '          for (const azimuth of AZIMUTHS) {',
    '            rows.push({',
    '              radius,',
    '              depth,',
    '              sunMu,',
    '              viewMu,',
    '              azimuth,',
    '              side,',
    '              set,',
    '              angle: ANGLES[geometry]!,',
    "              domain: DOMAIN[geometry] === '1',",
    '              scaled: triple(at),',
    '              first: triple(at + 3),',
    '              truth: triple(at + 6),',
    '            })',
    '            at += 9',
    '            geometry += 1',
    '          }',
    '  }',
    '  return rows',
    '}',
    '',
  ]
}

/** What `write` gathers before it writes anything. */
export interface SlabInputs {
  readonly references: readonly ReferenceStage[]
  readonly sources: readonly SourceStage[]
  readonly flux: readonly number[]
  readonly monteCarlo: readonly MonteCarloRow[]
  readonly glory: GloryStage
}

/** The choice of table, and every figure the two headers carry. */
export interface SlabVerdict {
  readonly scaling: ReturnType<typeof worstDifference<ReferenceRow>>
  readonly scalingPure: ReturnType<typeof worstDifference<ReferenceRow>>
  readonly scalingGrid: number
  readonly scalingFlux: number
  readonly candidates: readonly {
    readonly nodes: number
    readonly fit: keyof SourceStage['fits']
    readonly judged: Reconstruction
  }[]
  readonly chosen: {
    readonly stage: SourceStage
    readonly fit: SourceFit
    readonly judged: Reconstruction
  }
  /** The same table by the other measure, and by the chosen one without the lobe. */
  readonly alternate: {
    readonly fit: SourceFit
    readonly judged: Reconstruction
  }
  readonly withoutLobe: Reconstruction
}

/** Every candidate table judged, and the one that is written. */
export function decide(inputs: SlabInputs): SlabVerdict {
  const rows = inputs.references.flatMap((stage) => stage.rows)
  const fluxes = inputs.references.flatMap((stage) => stage.fluxes)
  const candidates = inputs.sources.flatMap((stage) =>
    (['absolute', 'relative', 'absolutePlain', 'relativePlain'] as const).map(
      (fit) => ({
        nodes: stage.nodes,
        fit,
        judged: judge(
          stageTable(stage, fit),
          stage.lobe,
          inputs.references,
          rows,
          fluxes,
        ),
      }),
    ),
  )
  // The smaller worst error draws (the design's §7.4); among tables within
  // a point of it, the fewest nodes, which is the design's rule for a count.
  const lobed = candidates.filter((item) => !item.fit.endsWith('Plain'))
  const best = Math.min(...lobed.map((item) => item.judged.error))
  const winner = lobed
    .filter((item) => item.judged.error <= best + 0.01)
    .sort((a, b) => a.nodes - b.nodes || a.judged.error - b.judged.error)[0]!
  const beside = (fit: string): Reconstruction =>
    candidates.find((item) => item.nodes === winner.nodes && item.fit === fit)!
      .judged
  const other: SourceFit = winner.fit === 'relative' ? 'absolute' : 'relative'
  let scalingFlux = 0
  for (const flux of fluxes)
    if (flux.set !== 'thin')
      flux.scaled.forEach((value, band) => {
        scalingFlux = Math.max(
          scalingFlux,
          Math.abs(value / flux.truth[band]! - 1),
        )
      })
  return {
    scaling: worstDifference(
      rows,
      (row) => row.scaled,
      (row) => row.truth,
      (row) => row.set !== 'thin',
    ),
    scalingPure: worstDifference(
      rows,
      (row) => row.pure,
      (row) => row.truth,
      (row) => row.set !== 'thin',
    ),
    scalingGrid: worstDifference(
      rows,
      (row) => row.scaled,
      (row) => row.truth,
      (row) => row.set === 'grid',
    ).error,
    scalingFlux,
    candidates,
    chosen: {
      stage: inputs.sources.find((stage) => stage.nodes === winner.nodes)!,
      fit: winner.fit as SourceFit,
      judged: winner.judged,
    },
    alternate: { fit: other, judged: beside(other) },
    withoutLobe: beside(`${winner.fit}Plain`),
  }
}

/** `slabReference.generated.ts`'s text, before prettier. */
export function referenceText(
  inputs: SlabInputs,
  verdict: SlabVerdict,
): string {
  const { references, monteCarlo, glory } = inputs
  const rows = references.flatMap((stage) => stage.rows)
  const held = monteCarlo.filter((row) => row.domain)
  const failing = held.filter((row) => !monteCarloHolds(row))
  const sigma = Math.max(
    ...held.map((row) => Math.abs(row.mean - row.oracle) / row.error),
  )
  const header = [
    'Generated by `node apps/ingest/src/transport/slabTables.ts write` from the',
    'stages its header lists; rerun them rather than editing, then',
    '`pnpm exec prettier -w` this file.',
    '',
    'The slab oracle’s reference: a plane slab of droplets under a collimated',
    'sun, by adding-doubling with every azimuthal mode (Hansen and Travis 1974;',
    'de Haan, Bosma and Hovenier 1987), delta-M at the stream count and first',
    'order put back whole (Nakajima and Tanaka 1988). Radiance is per unit of the',
    'sun’s irradiance, sr⁻¹, a band a channel (680, 550, 440 nm); a flux is over',
    'the flux arriving. The droplets are the droplet table’s populations at',
    `effective radii ${SLAB_DOMAIN.radii.join(', ')} µm; their moments’ digests are`,
    `${references.map((stage) => stage.digest).join(', ')}. First order reads the phase`,
    'function through a sun’s disk of 959.63″.',
    '',
    '`rows` are one geometry each, rebuilt from the axes and the radiances below',
    'where this file is read, at an unscaled optical depth `depth`: `truth`',
    `is the true medium, the whole Mie phase at that depth, at ${references[0]!.streams.truth} streams;`,
    '`scaled` is the renderer’s medium, at the depth (1 − f_δ)·`depth`: the',
    `scaled phase’s orders past the first, at ${references[0]!.streams.scaled} streams, under first order on the`,
    'whole phase, which is `first`. `side` is the face the light leaves,',
    '`azimuth` the degrees between the view ray’s bearing and the sun’s, `angle`',
    'the scattering angle, and `domain` whether the rubric’s domain holds the',
    'direction: not the glory, the cloudbow or the forward cone. `set` is `grid`',
    'for a slab a fit is made on, `held` for one it is judged on, and `thin`',
    'for a depth that is recorded and judged by nothing. `media` is each',
    'radius’s f_δ (`share`) and g′ = (g − f_δ)/(1 − f_δ) (`asymmetry`).',
    '',
    `The scaling’s bill, \`scalingError\`: ${percent(verdict.scaling.error)}, the largest relative`,
    'difference of `scaled` from `truth` over the domain’s grid and held-out',
    `slabs, at ${describeRow(verdict.scaling.row!, verdict.scaling.band)}.`,
    `On the grid alone it is ${percent(verdict.scalingGrid)}; with the scaled medium’s own first order in`,
    `place of the whole phase’s, ${percent(verdict.scalingPure.error)}; and in the reflected flux, ${percent(verdict.scalingFlux)}.`,
    '',
    '`reflected` is each slab’s reflected flux, both media, with the part of the',
    'renderer’s that is first order (`first`). `flux` is the true',
    `medium’s over a black surface, \`R(τ, μ₀)\`, at ${SOURCE_RADIUS} µm with the three bands`,
    'as one, at each `depths[i]` for each of `sunMus`, laid out [sun][depth].',
    '',
    '`monteCarlo` is the backward Monte Carlo on the true medium',
    `(\`monteCarloSlab.ts\`), seed '${MONTE_CARLO.seed}', beside adding-doubling on the`,
    'true medium (`oracle`) and on the renderer’s (`scaled`). Of its',
    `${held.length} values in the domain, ${held.length - failing.length} are within 3·SE + 0.5% of the oracle,`,
    `and the farthest is ${sigma.toFixed(2)} standard errors off.`,
    `\`glory\` is the red ring’s peak over the trough inside it, ${glory.radius} µm at τ ${glory.depth}`,
    `from straight above under a sun straight above: ${glory.traced.toFixed(3)} ± ${glory.error.toFixed(3)} traced,`,
    `${glory.oracle.toFixed(3)} by the oracle on the true medium and ${glory.scaled.toFixed(3)} on the renderer’s.`,
  ]
  const body = [
    ...rowsText(rows),
    'export const SLAB_REFERENCE = {',
    "  format: 'inertialref/slab-reference',",
    '  version: 1,',
    '  /** The largest relative difference in radiance between the two media over the domain’s rows. */',
    `  scalingError: ${Number(verdict.scaling.error.toPrecision(4))},`,
    '  media: ' +
      JSON.stringify(
        references.map((stage) => ({
          radius: stage.radius,
          share: Number(stage.share.toPrecision(7)),
          asymmetry: Number(stage.asymmetry.toPrecision(7)),
        })),
      ) +
      ',',
    '  rows: /*@__PURE__*/ slabReferenceRows() as readonly SlabReferenceRow[],',
    `  reflected: /*@__PURE__*/ JSON.parse(${recordsText(
      references.flatMap((stage) =>
        stage.fluxes.map((flux) => ({
          ...flux,
          scaled: flux.scaled.map(five),
          first: flux.first.map(five),
          truth: flux.truth.map(five),
        })),
      ),
    )}) as readonly SlabReferenceFlux[],`,
    `  sunMus: ${JSON.stringify(FLUX_AXES.sunMus)},`,
    `  depths: ${JSON.stringify(FLUX_AXES.depths)},`,
    `  flux: ${JSON.stringify(inputs.flux.map(five))},`,
    `  monteCarlo: /*@__PURE__*/ JSON.parse(${recordsText(
      monteCarlo.map((row) => ({
        ...row,
        mean: five(row.mean),
        error: Number(row.error.toPrecision(3)),
        oracle: five(row.oracle),
        scaled: five(row.scaled),
      })),
    )}) as readonly SlabMonteCarloRow[],`,
    '  glory: ' +
      JSON.stringify({
        ...glory,
        trough: Number(glory.trough.toFixed(2)),
        ring: Number(glory.ring.toFixed(2)),
        traced: five(glory.traced),
        error: Number(glory.error.toPrecision(3)),
        oracle: five(glory.oracle),
        scaled: five(glory.scaled),
      }) +
      ',',
    '} as const',
    '',
  ]
  return comment(header) + body.join('\n')
}

/** `slabSource.generated.ts`'s text, before prettier. */
export function sourceText(verdict: SlabVerdict): string {
  const { stage, fit, judged } = verdict.chosen
  const table = stageTable(stage, fit)
  const others = verdict.candidates
    .filter((item) => !item.fit.endsWith('Plain'))
    .map((item) => `${item.nodes} ${item.fit} ${percent(item.judged.error)}`)
    .join(', ')
  const header = [
    'Generated by `node apps/ingest/src/transport/slabTables.ts write` from the',
    'stages its header lists; rerun them rather than editing, then',
    '`pnpm exec prettier -w` this file.',
    '',
    'The higher orders’ source function in a plane slab of the renderer’s scaled',
    'medium, per unit of the sun’s irradiance and of scaled optical depth: what',
    'a march adds a step beyond first order, as three terms,',
    '',
    '  J₀ + J₁·μ_v + J_f·Φ(ν)        Φ(ν) = 4π·HG(ν; lobe) − 1',
    '',
    'with μ_v the cosine, to the lit face’s outward normal, of light traveling to',
    'the eye, and ν the cosine between the sun’s light and that light. The terms',
    `are the ${fit} least-squares fit, over every direction, of the adding-doubling`,
    `oracle’s interior field at ${stage.streams} streams (\`slabSource.ts\`), for the droplet`,
    `table’s population at ${SOURCE_RADIUS} µm with the three bands as one (moments’ digest`,
    `${stage.digest}).`,
    '',
    'Laid out [sun][bottom][top][term]: `suns` cosines evenly from `sunMuMin` to',
    '1, and `nodes` each of u(t_b) and u(t_d), the transport depth from the far',
    'face and from the lit one, t = (1 − g′)·τ′ with g′ = (g − f_δ)/(1 − f_δ) at',
    'the sample’s own radius, on u(t) = ln(1 + t/depthScale)/ln(1 + depthMax/depthScale).',
    'A value is a half float’s, printed as the shortest decimal that rounds to it,',
    'twelve to a line: four nodes of the top axis, three terms each.',
    '',
    '`reconstructionError` is the worst relative error of a slab’s leaving',
    'radiance rebuilt through this table’s own trilinear read, first order',
    'beside it, against the oracle’s `scaled` rows of `slabReference.generated.ts`:',
    'every band, radius, depth, sun, view and azimuth of the domain’s grid and',
    `held-out slabs. It is ${percent(judged.error)}, at ${judged.worst}.`,
    `\`reconstruction\` breaks it down: ${percent(judged.grid)} on the grid, ${percent(judged.held)} on the held-out slabs,`,
    `${percent(judged.rms)} root mean square, ${judged.thin.map(percent).join(', ')} at τ ${SLAB_DOMAIN.depths.thin.join(', ')}; ${percent(judged.flux)} in the`,
    'reflected flux, the higher orders summed at eight Gauss points in μ and',
    `sixteen azimuths; and ${percent(verdict.withoutLobe.error)} in radiance without the lobe.`,
    '',
    `\`SLAB_SOURCE_ALTERNATE\` is the same table by the ${verdict.alternate.fit} measure, whose worst error is`,
    `${percent(verdict.alternate.judged.error)} (${percent(verdict.alternate.judged.rms)} root mean square, ${percent(verdict.alternate.judged.flux)} in the flux): the measure with`,
    'the smaller worst error is `terms`. The candidates’ worst errors, by node',
    `count and measure: ${others}.`,
  ]
  const body = [
    ...NUMBERS_TEXT,
    'export const SLAB_SOURCE = {',
    "  format: 'inertialref/slab-source',",
    '  version: 1,',
    `  nodes: ${stage.nodes},`,
    `  suns: ${SOURCE_AXES.suns},`,
    `  sunMuMin: ${SOURCE_AXES.sunMuMin},`,
    `  depthScale: ${SOURCE_AXES.depthScale},`,
    `  depthMax: ${SOURCE_AXES.depthMax},`,
    '  /** µm: the radius row the table is generated at. */',
    `  radius: ${SOURCE_RADIUS},`,
    '  /** The lobe’s asymmetry: g′² at that radius. */',
    `  lobe: ${Number(stage.lobe.toPrecision(7))},`,
    '  /** Which least squares the terms are: on the source, or on the source over itself. */',
    `  fit: '${fit}',`,
    '  /** The reconstruction’s worst relative error against the oracle, on the domain and between its nodes. */',
    `  reconstructionError: ${Number(judged.error.toPrecision(4))},`,
    '  reconstruction: ' +
      JSON.stringify({
        grid: Number(judged.grid.toPrecision(4)),
        held: Number(judged.held.toPrecision(4)),
        rms: Number(judged.rms.toPrecision(4)),
        thin: judged.thin.map((value) => Number(value.toPrecision(4))),
        flux: Number(judged.flux.toPrecision(4)),
        withoutLobe: Number(verdict.withoutLobe.error.toPrecision(4)),
      }) +
      ',',
    `  terms: /*@__PURE__*/ numbers(${numbersText(Array.from(table.terms), 12)}),`,
    '} as const',
    '',
    '/**',
    ` * The same table by the ${verdict.alternate.fit} measure, on the same layout: a constant of`,
    ' * its own, so that a build that draws with `SLAB_SOURCE` does not carry it.',
    ' */',
    'export const SLAB_SOURCE_ALTERNATE = {',
    `  fit: '${verdict.alternate.fit}',`,
    `  reconstructionError: ${Number(verdict.alternate.judged.error.toPrecision(4))},`,
    `  terms: /*@__PURE__*/ numbers(${numbersText(Array.from(stageTable(stage, verdict.alternate.fit).terms), 12)}),`,
    '} as const',
    '',
  ]
  return comment(header) + body.join('\n')
}

/** Reads every stage `write` needs. */
export function gather(): SlabInputs {
  const references = SLAB_DOMAIN.radii.map((radius) =>
    load<ReferenceStage>(`reference-${radius}`),
  )
  const sources: SourceStage[] = []
  for (const nodes of [16, 24, 32]) {
    try {
      sources.push(load<SourceStage>(`source-${nodes}`))
    } catch {
      // A node count that was not run is not a candidate.
    }
  }
  return {
    references,
    sources,
    flux: load<number[]>('flux'),
    monteCarlo: [...MONTE_CARLO.depths, 'bill'].flatMap((name) =>
      load<MonteCarloRow[]>(`montecarlo-${name}`),
    ),
    glory: load<GloryStage>('glory'),
  }
}

function runSource(nodes: number, part: number, parts: number): void {
  const population = slabPopulation(SOURCE_RADIUS)
  const medium = sourceMedium(population)
  const grid: SourceGrid = { ...SOURCE_AXES, nodes }
  const rows = Array.from({ length: nodes }, (_, i) => i).filter(
    (i) => i % parts === part,
  )
  const lobe = medium.asymmetry ** 2
  const terms = sourceTerms(medium, grid, lobe, SLAB_STREAMS.scaled, { rows })
  save(`source-${nodes}-${part}of${parts}`, {
    nodes,
    streams: SLAB_STREAMS.scaled,
    lobe,
    asymmetry: medium.asymmetry,
    digest: population.digest,
    delta: terms.delta,
    modes: terms.modes,
    fits: {
      absolute: Array.from(terms.absolute),
      relative: Array.from(terms.relative),
      absolutePlain: Array.from(terms.absolutePlain),
      relativePlain: Array.from(terms.relativePlain),
    },
  } satisfies SourceStage)
}

/** The parts of a source table as one stage: a part holds zeros where another holds a row. */
function mergeSource(nodes: number, parts: number): void {
  const stages = Array.from({ length: parts }, (_, part) =>
    load<SourceStage>(`source-${nodes}-${part}of${parts}`),
  )
  const sum = (fit: keyof SourceStage['fits']): number[] =>
    stages[0]!.fits[fit].map((_, at) =>
      stages.reduce((total, stage) => total + stage.fits[fit][at]!, 0),
    )
  save(`source-${nodes}`, {
    ...stages[0]!,
    fits: {
      absolute: sum('absolute'),
      relative: sum('relative'),
      absolutePlain: sum('absolutePlain'),
      relativePlain: sum('relativePlain'),
    },
  } satisfies SourceStage)
}

function runMonteCarlo(name: string): void {
  if (name === 'glory') {
    const { depth, paths } = MONTE_CARLO.glory
    save('glory', gloryStage(slabPopulation(MONTE_CARLO.radius), depth, paths))
    return
  }
  if (name === 'bill') {
    const { radius, band, depth, suns, views } = MONTE_CARLO.bill
    save(
      'montecarlo-bill',
      monteCarloRows(
        slabPopulation(radius),
        band,
        depth,
        suns,
        views,
        MONTE_CARLO.bill.paths,
      ),
    )
    return
  }
  save(
    `montecarlo-${name}`,
    monteCarloRows(
      slabPopulation(MONTE_CARLO.radius),
      MONTE_CARLO.band,
      Number(name),
      MONTE_CARLO.suns,
      MONTE_CARLO.views,
      MONTE_CARLO.paths[MONTE_CARLO.depths.indexOf(Number(name) as 5)]!,
    ),
  )
}

function write(): void {
  const inputs = gather()
  const verdict = decide(inputs)
  writeFileSync(
    `${RENDERING}slabReference.generated.ts`,
    referenceText(inputs, verdict),
  )
  writeFileSync(`${RENDERING}slabSource.generated.ts`, sourceText(verdict))
  save('verdict', {
    scaling: verdict.scaling,
    scalingPure: verdict.scalingPure,
    scalingGrid: verdict.scalingGrid,
    scalingFlux: verdict.scalingFlux,
    candidates: verdict.candidates,
    chosen: {
      nodes: verdict.chosen.stage.nodes,
      fit: verdict.chosen.fit,
      judged: verdict.chosen.judged,
    },
    alternate: verdict.alternate,
    withoutLobe: verdict.withoutLobe,
  })
  console.log(
    `slabTables: wrote the two generated files under ${RENDERING}; now run pnpm exec prettier -w on them`,
  )
}

if (import.meta.main) {
  const [stage, ...rest] = process.argv.slice(2)
  if (stage === 'reference')
    save(
      `reference-${rest[0]}`,
      referenceStage(slabPopulation(Number(rest[0]))),
    )
  else if (stage === 'source')
    runSource(Number(rest[0]), Number(rest[1] ?? 0), Number(rest[2] ?? 1))
  else if (stage === 'merge') mergeSource(Number(rest[0]), Number(rest[1]))
  else if (stage === 'flux')
    save('flux', blackSurfaceFlux(slabPopulation(SOURCE_RADIUS)))
  else if (stage === 'montecarlo') runMonteCarlo(rest[0] ?? '')
  else if (stage === 'write') write()
  else {
    console.error(
      'slabTables: a stage is one of reference <radius>, source <nodes> <part> <parts>, merge <nodes> <parts>, flux, montecarlo <depth | bill | glory>, write',
    )
    process.exit(1)
  }
}
