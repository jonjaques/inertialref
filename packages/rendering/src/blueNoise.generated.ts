/*
 * The spatiotemporal blue-noise mask: `width × height` texels a slice,
 * `slices` slices, one byte a texel, as base64, laid out [slice][y][x]. A
 * pixel reads its own texel, wrapped, in the slice of its sample count.
 *
 * A stand-in: 2 × 2 × 2, the eight values an eighth apart. A generator
 * writes this file; rerun it rather than editing, then
 * `pnpm exec prettier -w` this file.
 */
export const BLUE_NOISE = {
  format: 'inertialref/blue-noise',
  version: 1,
  width: 2,
  height: 2,
  slices: 2,
  bytes: 'AIBAwCCgYOA=',
} as const
