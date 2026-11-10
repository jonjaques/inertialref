import { ISCCP_ZONAL } from './isccpZonal.generated.ts'

/*
 * The reader of ISCCP-H's zonal table: the cover the zonal law is fitted to,
 * and the mean depth each genus is calibrated against. A reader, not a
 * climatology: the gridded means stay out of the tree, and what a body's
 * weather needs of Earth's is a few hundred numbers.
 *
 * Every read answers null where the table holds nothing, so a fit or a
 * calibration that needs a figure skips on a table that lacks it and never
 * reads a zero as a measurement.
 */

export type IsccpLevel = 'total' | 'low' | 'middle' | 'high'

export interface IsccpZonal {
  readonly source: string
  /** Degrees of latitude a band spans, and the bands from pole to pole. */
  readonly bandDegrees: number
  readonly bands: number
  readonly months: number
  /** The mean cover of a level in a band and month, 0..1, or null where the table holds none. */
  cover(level: IsccpLevel, month: number, band: number): number | null
  /** A type's mean cover and mean visible optical depth, or null for a type the table lacks. */
  type(name: string): { readonly cover: number; readonly depth: number } | null
}

const LEVELS = {
  total: 'cover',
  low: 'low',
  middle: 'middle',
  high: 'high',
} as const

/** The committed zonal table, behind its reader. */
export function isccpZonal(): IsccpZonal {
  const table = ISCCP_ZONAL
  const bands = table.bandDegrees > 0 ? Math.round(180 / table.bandDegrees) : 0
  return {
    source: table.source,
    bandDegrees: table.bandDegrees,
    bands,
    months: table.months,
    cover(level, month, band) {
      const whole = Number.isInteger(month) && Number.isInteger(band)
      if (!whole || month < 0 || month >= table.months) return null
      if (band < 0 || band >= bands) return null
      return table[LEVELS[level]][month * bands + band] ?? null
    },
    type(name) {
      const row = table.types.find((entry) => entry.type === name)
      return row === undefined ? null : { cover: row.cover, depth: row.depth }
    },
  }
}
