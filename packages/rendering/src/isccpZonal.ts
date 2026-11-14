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
 *
 * A level's cover is ISCCP's: the cloud whose top is in that level, as a
 * satellite sees it from above, so the three levels of a band sum to its
 * total. A level drawn with random overlap under the levels above it is
 * compared with these only after the same view from above is taken of it.
 */

export type IsccpLevel = 'total' | 'low' | 'middle' | 'high'

/** A level, or the total over land or over ocean alone. */
export type IsccpCover = IsccpLevel | 'land' | 'ocean'

/** One of ISCCP's nine types, liquid and ice together. */
export interface IsccpType {
  /** Its mean cover, 0..1, over the area where types are retrieved. */
  readonly cover: number
  /** Its radiatively averaged mean visible optical depth: what the calibration holds a genus to. */
  readonly depth: number
  /** The linear and the logarithmic means of the same depths, beside it. */
  readonly linearDepth: number
  readonly logDepth: number
  /** Its mean cloud-top pressure, hPa. */
  readonly pressure: number
}

export interface IsccpZonal {
  readonly source: string
  /** Degrees of latitude a band spans, and the bands from pole to pole. */
  readonly bandDegrees: number
  readonly bands: number
  readonly months: number
  /** The mean cover of a level in a band and month, 0..1, or null where the table holds none. */
  cover(level: IsccpLevel, month: number, band: number): number | null
  /** A band's mean over the ten years and every month, 0..1, or null where the table holds none. */
  zonal(cover: IsccpCover, band: number): number | null
  /** The global mean, 0..1, or null where the table holds none. */
  global(cover: IsccpCover): number | null
  /** A type's means, or null for a type the table lacks. */
  type(name: string): IsccpType | null
}

const KEYS = {
  total: 'cover',
  low: 'low',
  middle: 'middle',
  high: 'high',
  land: 'land',
  ocean: 'ocean',
} as const

type Table = typeof ISCCP_ZONAL

const whole = (value: number): boolean => Number.isInteger(value)

/** The committed zonal table, behind its reader. */
export function isccpZonal(table: Table = ISCCP_ZONAL): IsccpZonal {
  const bands = table.bandDegrees > 0 ? Math.round(180 / table.bandDegrees) : 0
  const inBand = (band: number): boolean =>
    whole(band) && band >= 0 && band < bands
  const annual: Readonly<Record<string, readonly (number | null)[]>> =
    table.annual
  const global: Readonly<Record<string, number>> = table.global
  return {
    source: table.source,
    bandDegrees: table.bandDegrees,
    bands,
    months: table.months,
    cover(level, month, band) {
      if (!whole(month) || month < 0 || month >= table.months) return null
      if (!inBand(band)) return null
      const series: readonly number[] = table[KEYS[level]]
      return series[month * bands + band] ?? null
    },
    zonal(cover, band) {
      if (!inBand(band)) return null
      return annual[KEYS[cover]]?.[band] ?? null
    },
    global(cover) {
      return global[KEYS[cover]] ?? null
    },
    type(name) {
      const row = table.types.find((entry) => entry.type === name)
      if (row === undefined) return null
      const { cover, depth, linearDepth, logDepth, pressure } = row
      return { cover, depth, linearDepth, logDepth, pressure }
    },
  }
}
