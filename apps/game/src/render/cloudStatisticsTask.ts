import type { LevelSpec } from '@inertialref/rendering'
import { defineTask } from '@inertialref/workers'

/*
 * A level's statistics built on the pool (phase 1 design §4.7, package F's
 * third pass): the footprint read's table, 17 covers by 8 rows of the
 * resolved field measured on 4,096 columns and 2,048 slant rays. It costs
 * 0.46 to 1.0 s a level on this Mac mini (Mac18,5, Apple M6), and 2 s in a
 * process that has not yet read the noise's texels: never a frame's work.
 *
 * The build is loaded by `import()` (`cloudStatisticsTable.ts`), not
 * imported: this file is in the worker every page boots, and a page without
 * clouds never asks. So nothing crosses the boundary but a level's four
 * members one way and its texels, 4,352 bytes, the other.
 */

export interface CloudStatisticsRequest {
  readonly spec: LevelSpec
}

export interface CloudStatisticsResponse {
  /** The spec's key, so the consumer can tell an answer it still wants from a stale one. */
  readonly key: string
  /** `statisticsTexels`: `[row][texel][rgba]`, float32. */
  readonly texels: Float32Array
  /** The build's wall time in the worker, milliseconds: a readout, never an input. */
  readonly milliseconds: number
}

/** The build's module, loaded on the first ask a worker serves. */
let build: Promise<typeof import('./cloudStatisticsTable.ts')> | null = null

export const cloudStatisticsTask = defineTask<
  CloudStatisticsRequest,
  CloudStatisticsResponse
>({
  name: 'render.cloudStatistics',
  version: 1,
  async run({ spec }) {
    // A fetch that fails is not kept: the next ask loads again rather than
    // failing for the worker's life.
    build ??= import('./cloudStatisticsTable.ts').catch((cause: unknown) => {
      build = null
      throw cause
    })
    const { buildStatisticsTable } = await build
    return buildStatisticsTable(spec)
  },
  transfers: (response) => [response.texels.buffer],
})
