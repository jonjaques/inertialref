/*
 * ISCCP-H's zonal means: cloud cover by latitude band and month, total and
 * by level, and each cloud type's mean cover and mean optical depth.
 *
 * `cover` is laid out [month][band], bands from the south pole north,
 * `bandDegrees` wide; `low`, `middle` and `high` in the same layout. A
 * `types` row is one of ISCCP's nine types, with its mean cover and its
 * mean visible optical depth.
 *
 * A stand-in: no month, no band and no type, from no file. An ingest writes
 * this file from the monthly means it reads; rerun it rather than editing,
 * then `pnpm exec prettier -w` this file.
 */
export const ISCCP_ZONAL = {
  format: 'inertialref/isccp-zonal',
  version: 1,
  /** The product, its years, and how it is cited. */
  source: 'none: a stand-in',
  bandDegrees: 10,
  months: 0,
  cover: [] as readonly number[],
  low: [] as readonly number[],
  middle: [] as readonly number[],
  high: [] as readonly number[],
  types: [] as readonly {
    readonly type: string
    readonly cover: number
    readonly depth: number
  }[],
} as const
