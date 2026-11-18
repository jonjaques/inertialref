import type { SlabSourceReadOptions } from '@inertialref/rendering'
import { halfRangeGauss } from './legendre.ts'
import type { SourceForm } from './slabForms.ts'
import {
  higherOrders,
  slabRay,
  type SlabView,
  type SourceTable,
} from './slabSource.ts'

/*
 * A source table judged against the oracle's rows: a slab's leaving
 * radiance rebuilt as a march would, first order beside what the table adds,
 * at every geometry of the rubric's domain. It is the forecast of the
 * rubric's rows 1 and 2 in Node: the worst error, where it is, and how the
 * error is spread, because a table that is 30% off at one grazing view and
 * within 2% at every other is not the table its worst error describes.
 */

/**
 * What a radius's rows need of it to be rebuilt: f_δ, and the first moment
 * that turns its scaled depth into the table's transport depth, by the
 * table's own convention.
 */
export interface SlabScale {
  readonly radius: number
  readonly share: number
  readonly asymmetry: number
}

/** A row of the reference, as much of it as a judgment reads. */
export interface JudgedRow {
  readonly radius: number
  readonly depth: number
  readonly sunMu: number
  readonly viewMu: number
  readonly azimuth: number
  readonly side: 'reflected' | 'transmitted'
  readonly set: 'grid' | 'held' | 'thin'
  readonly angle: number
  readonly domain: boolean
  readonly scaled: readonly number[]
  readonly first: readonly number[]
}

/** A slab's reflected flux, as much of it as a judgment reads. */
export interface JudgedFlux {
  readonly radius: number
  readonly depth: number
  readonly sunMu: number
  readonly set: 'grid' | 'held' | 'thin'
  readonly scaled: readonly number[]
  readonly first: readonly number[]
}

const BAND_NAMES = ['680 nm', '550 nm', '440 nm']

/** A row in a sentence. */
export function describeRow(
  row: Pick<
    JudgedRow,
    'radius' | 'depth' | 'sunMu' | 'viewMu' | 'azimuth' | 'side' | 'angle'
  >,
  band: number,
): string {
  return `${row.radius} µm, ${BAND_NAMES[band]}, τ ${row.depth}, μ₀ ${row.sunMu}, μ ${row.viewMu} at ${row.azimuth}°, ${row.side}, ${row.angle.toFixed(1)}° from the sun's direction`
}

/** What a march's source adds to a row's first order, through the table's own read. */
export function reconstruct(
  table: SourceTable,
  form: SourceForm,
  scale: SlabScale,
  row: Pick<JudgedRow, 'depth' | 'sunMu' | 'viewMu' | 'azimuth' | 'side'>,
  options: SlabSourceReadOptions = {},
): number {
  const view: SlabView = {
    depth: row.depth * (1 - scale.share),
    sunMu: row.sunMu,
    viewMu: row.viewMu,
    azimuth: row.azimuth,
    side: row.side,
  }
  return higherOrders(
    table,
    form.reads(slabRay(view)),
    view,
    scale.asymmetry,
    options,
  )
}

/** One radiance of one row: the rebuilt value's signed relative error. */
export interface JudgedValue {
  readonly row: JudgedRow
  readonly band: number
  readonly error: number
}

/** A table's judgment. */
export interface Reconstruction {
  /** The worst relative error in radiance over the domain's grid and held-out slabs. */
  readonly error: number
  /** The same over each set alone, and at each thin depth. */
  readonly grid: number
  readonly held: number
  readonly thin: readonly number[]
  /** Root mean square over the grid and the held-out slabs. */
  readonly rms: number
  /** The error half, 95% and 99% of those radiances are inside. */
  readonly median: number
  readonly ninetyFifth: number
  readonly ninetyNinth: number
  /**
   * The worst relative error of those slabs' reflected flux, the higher
   * orders summed by the rubric's quadrature: eight Gauss points in μ and
   * sixteen azimuths.
   */
  readonly flux: number
  /** The row that carries `error`, and its band. */
  readonly worst: string
  /** The worst error under each sun and at each depth of the grid and the held-out slabs. */
  readonly bySun: readonly (readonly [sunMu: number, error: number])[]
  readonly byDepth: readonly (readonly [depth: number, error: number])[]
  /** How many of those radiances are over the rubric's 5%, and how many there are. */
  readonly over: number
  readonly count: number
}

/** The rubric's quadrature for a flux: eight Gauss points in μ, sixteen azimuths. */
const FLUX_RULE = /*@__PURE__*/ halfRangeGauss(8)
const FLUX_AZIMUTHS = 16

/** The worst relative error of the reflected flux a table rebuilds. */
export function judgeFlux(
  table: SourceTable,
  form: SourceForm,
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
          reconstruct(table, form, scale, {
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

/** Every radiance of the domain's rows rebuilt: the thin depths' with the rest. */
export function judgeValues(
  table: SourceTable,
  form: SourceForm,
  scales: readonly SlabScale[],
  rows: readonly JudgedRow[],
  options: SlabSourceReadOptions = {},
): JudgedValue[] {
  const values: JudgedValue[] = []
  for (const row of rows) {
    if (!row.domain) continue
    const scale = scales.find((item) => item.radius === row.radius)!
    const higher = reconstruct(table, form, scale, row, options)
    row.scaled.forEach((exact, band) => {
      values.push({ row, band, error: (row.first[band]! + higher) / exact - 1 })
    })
  }
  return values
}

/** The magnitude a share of the values are inside. */
export function percentile(
  values: readonly JudgedValue[],
  share: number,
): number {
  if (values.length === 0) return 0
  const sorted = values
    .map((value) => Math.abs(value.error))
    .sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!
}

/** The worst magnitude among values. */
export function worstOf(values: readonly JudgedValue[]): number {
  return values.reduce(
    (worst, value) => Math.max(worst, Math.abs(value.error)),
    0,
  )
}

/** The values that occur, each once, descending. */
function distinct(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => b - a)
}

/** A table's error at every row of the domain, and in every slab's flux. */
export function judge(
  table: SourceTable,
  form: SourceForm,
  scales: readonly SlabScale[],
  rows: readonly JudgedRow[],
  fluxes: readonly JudgedFlux[],
  thinDepths: readonly number[] = [0.5, 1, 2],
): Reconstruction {
  const values = judgeValues(table, form, scales, rows)
  const judged = values.filter((value) => value.row.set !== 'thin')
  let squares = 0
  let carrier: JudgedValue | undefined
  for (const value of judged) {
    squares += value.error * value.error
    if (
      carrier === undefined ||
      Math.abs(value.error) > Math.abs(carrier.error)
    )
      carrier = value
  }
  const of = (keep: (value: JudgedValue) => boolean): number =>
    worstOf(values.filter(keep))
  return {
    error: worstOf(judged),
    grid: of((value) => value.row.set === 'grid'),
    held: of((value) => value.row.set === 'held'),
    thin: thinDepths.map((depth) =>
      of((value) => value.row.set === 'thin' && value.row.depth === depth),
    ),
    rms: Math.sqrt(squares / Math.max(1, judged.length)),
    median: percentile(judged, 0.5),
    ninetyFifth: percentile(judged, 0.95),
    ninetyNinth: percentile(judged, 0.99),
    flux: judgeFlux(table, form, scales, fluxes),
    worst: carrier === undefined ? '' : describeRow(carrier.row, carrier.band),
    bySun: distinct(judged.map((value) => value.row.sunMu)).map((sunMu) => [
      sunMu,
      of((value) => value.row.set !== 'thin' && value.row.sunMu === sunMu),
    ]),
    byDepth: distinct(judged.map((value) => value.row.depth)).map((depth) => [
      depth,
      of((value) => value.row.set !== 'thin' && value.row.depth === depth),
    ]),
    over: judged.filter((value) => Math.abs(value.error) > 0.05).length,
    count: judged.length,
  }
}
