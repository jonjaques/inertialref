/*
 * The path-traced cumulus: what the float64 tracer renders of the fixture.
 * `probes` are single pixels, each a view and a sun with the radiance per
 * band and its standard error; `curves` are the reference's radiance along
 * a scan across the cloud; `voxels` are samples of the fixture the
 * reference was traced through, by index, so a field that has moved since
 * fails against them. `genusHash` is the genus table's the reference was
 * generated under.
 *
 * A stand-in: no probe, no curve and no voxel, under no genus table. A
 * generator writes this file; rerun it rather than editing, then
 * `pnpm exec prettier -w` this file.
 */
export const CUMULUS_REFERENCE = {
  format: 'inertialref/cumulus-reference',
  version: 1,
  genusHash: '',
  probes: [] as readonly {
    readonly case: string
    readonly pixel: readonly [number, number]
    readonly radiance: readonly [number, number, number]
    readonly error: readonly [number, number, number]
  }[],
  curves: [] as readonly {
    readonly case: string
    readonly radiance: readonly number[]
  }[],
  voxels: [] as readonly {
    readonly index: number
    readonly sigma: number
    readonly radius: number
  }[],
} as const
