import type { Vec3 } from '@inertialref/spatial'

/*
 * The CPU reference of the noises the clouds bake once and read every step:
 * the Perlin–Worley base shape, the Worley detail and the 2D curl. Each tiles
 * at its period because its lattice hashes modulo the period with `pcg4d` on
 * integer cells, so the GPU's textures can be held to it texel by texel.
 * Arguments are the GPU nodes' own (`cloudNoise.ts`): a point in cells for
 * the volumes, a texel coordinate in [0, 1)² for the curl.
 */

const notYet = (): never => {
  throw new Error('not yet: WP4')
}

/** The base shape at a point in base-cell units, in [0, 1]. */
export function baseNoise(_cells: Vec3): number {
  return notYet()
}

/** The detail noise at a point in its own cell units, in [0, 1]. */
export function detailNoise(_cells: Vec3): number {
  return notYet()
}

/** The curl at a point of the unit square, each component in [−1, 1]. */
export function curlNoise(_u: number, _v: number): readonly [number, number] {
  return notYet()
}
