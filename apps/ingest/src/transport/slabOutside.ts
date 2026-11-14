import {
  describeRow,
  judgeValues,
  type JudgedRow,
  type JudgedValue,
  type SlabScale,
} from './slabJudge.ts'
import type { SourceForm } from './slabForms.ts'
import type { SourceTable } from './slabSource.ts'
import { referenceStage, type SlabPopulation } from './slabTables.ts'

/** Streams for the true medium and for the scaled one. */
export interface SlabStreams {
  readonly truth: number
  readonly scaled: number
}

/*
 * The view table judged where the rubric's domain does not look: at views,
 * bearings, suns and depths between the domain's own, under its lowest sun,
 * over its thinnest slab and past the table's last depth node. The domain is
 * five views and five bearings, and the table's nodes are not all among
 * them, so a figure taken on the domain alone says how the table does where
 * it was judged and nothing of where a march will read it.
 *
 * The oracle is the same as the domain's: the renderer's medium, first order
 * on the whole phase beside the scaled medium's orders past it. Only the
 * scaled medium is read, so the true one is solved at sixteen streams.
 */

/** A set of slabs and geometries the oracle is solved at, at each radius. */
export interface OutsideSet {
  readonly name: string
  readonly depths: readonly number[]
  readonly suns: readonly number[]
  readonly views: readonly number[]
  readonly azimuths: readonly number[]
  /** µm. */
  readonly radii: readonly number[]
}

const DOMAIN_VIEWS = [0.2, 0.4, 0.6, 0.8, 1]
const DOMAIN_AZIMUTHS = [0, 45, 90, 135, 180]
/** Views and bearings none of the domain's: 0.975 is in the table's widest gap about the normal. */
const BETWEEN_VIEWS = [0.08, 0.17, 0.31, 0.46, 0.61, 0.75, 0.89, 0.975]
const BETWEEN_AZIMUTHS = [0, 15, 30, 60, 75, 105, 120, 150, 165, 180]
const RADII = [6, 10, 16] as const

/** The sets, by name; `deep` is the one past the table's last node. */
export const OUTSIDE_SETS = {
  /** The domain's own slabs, at views and bearings between its own. */
  views: {
    name: 'views',
    depths: [5, 10, 20, 50, 7, 30],
    suns: [1, 0.5, 0.2, 0.7, 0.35],
    views: BETWEEN_VIEWS,
    azimuths: BETWEEN_AZIMUTHS,
    radii: RADII,
  },
  /** Depths, suns, views and bearings all between the domain's. */
  between: {
    name: 'between',
    depths: [6, 8.5, 14, 25, 40],
    suns: [0.27, 0.43, 0.6, 0.85],
    views: BETWEEN_VIEWS,
    azimuths: BETWEEN_AZIMUTHS,
    radii: RADII,
  },
  /** Suns under the domain's lowest, 0.2, to the table's floor. */
  low: {
    name: 'low',
    depths: [5, 8.5, 14, 25, 50],
    suns: [0.05, 0.08, 0.12, 0.16],
    views: [...DOMAIN_VIEWS, 0.08, 0.31, 0.89],
    azimuths: [...DOMAIN_AZIMUTHS, 15, 75, 165],
    radii: RADII,
  },
  /** Slabs under the domain's thinnest, τ 5. */
  thin: {
    name: 'thin',
    depths: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4],
    suns: [1, 0.6, 0.35, 0.2],
    views: [...DOMAIN_VIEWS, 0.08, 0.31, 0.89],
    azimuths: [...DOMAIN_AZIMUTHS, 15, 75, 165],
    radii: RADII,
  },
  /**
   * Past the table's last node: 16 transport depths is τ 121 at 10 µm, so
   * these slabs read the diffusion's extension through their middle.
   */
  deep: {
    name: 'deep',
    depths: [200, 400],
    suns: [1, 0.6, 0.35, 0.2],
    views: DOMAIN_VIEWS,
    azimuths: DOMAIN_AZIMUTHS,
    radii: [10],
  },
} as const satisfies Record<string, OutsideSet>

export type OutsideName = keyof typeof OUTSIDE_SETS

/** The stream counts the generator solves a set at: the domain's for the scaled medium. */
export const OUTSIDE_STREAMS: SlabStreams = { truth: 16, scaled: 128 }

/**
 * The slow test's: 64 scaled streams, within 0.41% of 128 on these sets'
 * radiances (6 µm, where the pattern's wings are widest; 0.02% at 16 µm),
 * and an eighth of the time.
 */
export const SAMPLE_STREAMS: SlabStreams = { truth: 16, scaled: 64 }

/**
 * What the slow test solves of a set: its first and last depths, every sun,
 * view and bearing, at every radius. A depth is the solve's unit of cost,
 * so this is two of the set's five to eight solves at each radius.
 */
export function outsideSample(set: OutsideSet): OutsideSet {
  return {
    ...set,
    depths: [set.depths[0]!, set.depths.at(-1)!],
  }
}

/** The oracle's rows for a set at one population, as much of them as a judgment reads. */
export function outsideRows(
  set: OutsideSet,
  population: SlabPopulation,
  streams: SlabStreams,
): JudgedRow[] {
  const stage = referenceStage(population, {
    streams,
    pairs: set.depths.flatMap((depth) =>
      set.suns.map((sunMu) => ({ depth, sunMu, set: 'grid' as const })),
    ),
    views: [...set.views],
    azimuths: [...set.azimuths],
  })
  return stage.rows.map((row) => ({
    radius: row.radius,
    depth: row.depth,
    sunMu: row.sunMu,
    viewMu: row.viewMu,
    azimuth: row.azimuth,
    side: row.side,
    set: row.set,
    angle: row.angle,
    domain: row.domain,
    scaled: row.scaled,
    first: row.first,
  }))
}

/** A set's judgment: what a header and a ceiling carry. */
export interface OutsideJudgment {
  /** Radiances judged: every band of every row the domain's exclusions keep. */
  readonly count: number
  readonly worst: number
  readonly rms: number
  /** How many are over the rubric's 5%. */
  readonly over: number
  /** The row that carries `worst`, and its band. */
  readonly where: string
}

/** The figures of a set of judged values. */
export function outsideFigures(
  values: readonly JudgedValue[],
): OutsideJudgment {
  let carrier: JudgedValue | undefined
  let squares = 0
  for (const value of values) {
    squares += value.error * value.error
    if (
      carrier === undefined ||
      Math.abs(value.error) > Math.abs(carrier.error)
    )
      carrier = value
  }
  return {
    count: values.length,
    worst: carrier === undefined ? 0 : Math.abs(carrier.error),
    rms: Math.sqrt(squares / Math.max(1, values.length)),
    over: values.filter((value) => Math.abs(value.error) > 0.05).length,
    where: carrier === undefined ? '' : describeRow(carrier.row, carrier.band),
  }
}

/** A table judged on a set's rows. */
export function judgeOutside(
  table: SourceTable,
  form: SourceForm,
  scales: readonly SlabScale[],
  rows: readonly JudgedRow[],
): OutsideJudgment {
  return outsideFigures(judgeValues(table, form, scales, rows))
}

/** A deep set judged a face and a depth at a time: where the extension lands and where it does not. */
export function deepFigures(
  values: readonly JudgedValue[],
): { side: 'reflected' | 'transmitted'; depth: number; worst: number }[] {
  const out: {
    side: 'reflected' | 'transmitted'
    depth: number
    worst: number
  }[] = []
  for (const side of ['transmitted', 'reflected'] as const)
    for (const depth of [...new Set(values.map((value) => value.row.depth))])
      out.push({
        side,
        depth,
        worst: outsideFigures(
          values.filter(
            (value) => value.row.side === side && value.row.depth === depth,
          ),
        ).worst,
      })
  return out
}
