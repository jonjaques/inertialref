import type { LevelSpec } from '@inertialref/rendering'
import { statisticsKey, statisticsTexels } from './cloudStatisticsLayout.ts'

/*
 * A level's statistics built for the pool: the one module
 * `render.cloudStatistics` imports on its first ask (`cloudStatisticsTask.ts`)
 * and no other module imports at all, so the build, the genus table's droplet
 * rows and the noise's CPU texels it reads ride in a chunk of their own that
 * a page without clouds never fetches.
 *
 * The module holds code of its own, not only re-exports: a chunk of nothing
 * but re-exports carries no source map, which the build refuses
 * (`requireSourceMaps` in `vite.config.ts`). Nothing here may import
 * `three`: this module is part of the worker bundle.
 */

/** A level's table, its key, and the build's wall time in milliseconds: a readout. */
export function buildStatisticsTable(spec: LevelSpec): {
  readonly key: string
  readonly texels: Float32Array
  readonly milliseconds: number
} {
  const start = performance.now()
  const texels = statisticsTexels(spec)
  return {
    key: statisticsKey(spec),
    texels,
    milliseconds: performance.now() - start,
  }
}
