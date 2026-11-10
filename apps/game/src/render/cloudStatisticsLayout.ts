import {
  type LevelSpec,
  levelProfile,
  levelStatistics,
  PROFILE_ROWS,
  STATISTICS_COVERS,
} from '@inertialref/rendering'

/*
 * A level's statistics as the profile texture's rows hold them, built from
 * `levelStatistics`. The profile builds with it where it has no pool, and
 * the pool's task through `cloudStatisticsTable.ts`, which the task reaches
 * only by `import()`. Nothing here may import `three`: the worker loads it.
 */

/** Texels a table row holds: the covers' A texels, then their B texels. */
export const STATISTICS_TEXELS = 2 * STATISTICS_COVERS

/** A level's spec as the key its table is kept by, as `levelStatistics` keeps it. */
export const statisticsKey = (spec: LevelSpec): string =>
  `${spec.base}|${spec.top}|${spec.stratiform}|${spec.cumuliform}`

/**
 * The table's texels, `[row][texel][rgba]`, row j at a convective share of
 * j/7 as the profile's rows: texel i, the cover i/16, holds (fraction,
 * depth, shape, sight in cells), and texel 17 + i holds (gain, 0, 0, 0).
 * The sight is in cells so a half float holds it: a sparse row's runs to a
 * hundred cells, 500 km at cirrus's.
 */
export function statisticsTexels(spec: LevelSpec): Float32Array {
  const stats = levelStatistics(spec)
  const { cell } = levelProfile(spec)
  const texels = new Float32Array(PROFILE_ROWS * STATISTICS_TEXELS * 4)
  for (let row = 0; row < PROFILE_ROWS; row += 1)
    for (let i = 0; i < STATISTICS_COVERS; i += 1) {
      const from = i * PROFILE_ROWS + row
      const a = (row * STATISTICS_TEXELS + i) * 4
      texels[a] = stats.fraction[from]!
      texels[a + 1] = stats.depth[from]!
      texels[a + 2] = stats.shape[from]!
      texels[a + 3] = stats.sight[from]! / cell
      texels[(row * STATISTICS_TEXELS + STATISTICS_COVERS + i) * 4] =
        stats.gain[from]!
    }
  return texels
}
