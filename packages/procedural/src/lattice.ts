import type { Seed } from './seed.ts'

/*
 * Integer-lattice hashing for feature placement.
 *
 * `hash3` in `hash.ts` mixes three integers into one and is what the gradient
 * noise uses. A feature field wants something else: given one lattice cell it
 * needs *several* decorrelated values — does a crater exist here, where in the
 * cell is its center, how wide, how old, what type — and calling a one-output
 * hash six times costs six mixes for six numbers.
 *
 * pcg3d and pcg4d (Jarzynski & Olano, JCGT 2020, "Hash Functions for GPU
 * Rendering", table 2) do the whole vector at once: one multiply-add per lane,
 * two rounds of cross-lane mixing, one shift-xor between them. Three or four
 * statistically independent uint32 for roughly the cost of one `mix32`, which
 * is why the crater band can afford eight lattice levels.
 *
 * The arithmetic is `Math.imul` and unsigned shifts throughout, exactly as
 * `hash.ts` is and for the same reason: the same cell must produce the same
 * crater in Chrome, in a worker, in Node and — when the band eventually runs as
 * a TSL kernel — on the GPU. The paper's functions are specified over uint32
 * and this is the one JavaScript spelling of them that cannot drift.
 *
 * The GPU half of that promise is the reason to prefer these over anything
 * cleverer: `docs/adr/0023-the-gpu-producer.md` keeps structural decisions —
 * which crater exists, which cell holds a plate nucleus — bit-identical
 * everywhere, while float arithmetic is allowed to differ. Integer hashing is how that line is
 * drawn, so every *placement* question goes through this file and only
 * amplitudes go through floats.
 */

const PCG_MULTIPLIER = 1_664_525
const PCG_INCREMENT = 1_013_904_223

export interface Lattice3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface Lattice4 extends Lattice3 {
  readonly w: number
}

/** Three decorrelated uint32 from a 3D lattice cell. */
export function pcg3d(x: number, y: number, z: number): Lattice3 {
  let vx = (Math.imul(x | 0, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0
  let vy = (Math.imul(y | 0, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0
  let vz = (Math.imul(z | 0, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0

  vx = (vx + Math.imul(vy, vz)) >>> 0
  vy = (vy + Math.imul(vz, vx)) >>> 0
  vz = (vz + Math.imul(vx, vy)) >>> 0

  vx ^= vx >>> 16
  vy ^= vy >>> 16
  vz ^= vz >>> 16

  vx = (vx + Math.imul(vy, vz)) >>> 0
  vy = (vy + Math.imul(vz, vx)) >>> 0
  vz = (vz + Math.imul(vx, vy)) >>> 0

  return { x: vx, y: vy, z: vz }
}

/** Four decorrelated uint32 from a 4D lattice cell. */
export function pcg4d(x: number, y: number, z: number, w: number): Lattice4 {
  let vx = (Math.imul(x | 0, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0
  let vy = (Math.imul(y | 0, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0
  let vz = (Math.imul(z | 0, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0
  let vw = (Math.imul(w | 0, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0

  vx = (vx + Math.imul(vy, vw)) >>> 0
  vy = (vy + Math.imul(vz, vx)) >>> 0
  vz = (vz + Math.imul(vx, vy)) >>> 0
  vw = (vw + Math.imul(vy, vz)) >>> 0

  vx ^= vx >>> 16
  vy ^= vy >>> 16
  vz ^= vz >>> 16
  vw ^= vw >>> 16

  vx = (vx + Math.imul(vy, vw)) >>> 0
  vy = (vy + Math.imul(vz, vx)) >>> 0
  vz = (vz + Math.imul(vx, vy)) >>> 0
  vw = (vw + Math.imul(vy, vz)) >>> 0

  return { x: vx, y: vy, z: vz, w: vw }
}

/**
 * A seed folded down to the one 32-bit lane a lattice hash can carry.
 *
 * All four lanes, not just `a`: a seed's lanes are independently derived, so
 * taking one of them would let two surfaces that differ only in `b` place every
 * crater in the same cell. The gradient noise in `noise.ts` takes `seed.a`
 * alone and predates this; it is left as it is because changing it would
 * regenerate every existing world, which is a version bump rather than a
 * cleanup.
 */
export function latticeSeed(seed: Seed): number {
  const { x } = pcg3d(seed.a ^ seed.d, seed.b, seed.c)
  return x
}

/** A uint32 as a float in [0, 1). */
export const toUnit = (value: number): number => (value >>> 0) / 0x1_0000_0000
