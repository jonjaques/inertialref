import { hash3 } from './hash.ts'
import type { Seed } from './seed.ts'

/*
 * Stateless gradient noise.
 *
 * Stateless is the requirement, not an optimization: terrain patches are
 * generated in whatever order workers happen to pick them up, so a noise
 * function that carried a stream would produce a different planet depending on
 * which way the player flew round it. Every sample here is a pure function of
 * (seed, lattice coordinate).
 */

const GRADIENTS: readonly (readonly [number, number, number])[] = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
]

/** Quintic smoothstep — C2 continuous, so fBm derivatives stay clean. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

function gradientDot(
  seed: number,
  ix: number,
  iy: number,
  iz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const g =
    GRADIENTS[hash3(ix ^ seed, iy, iz) % GRADIENTS.length] ?? GRADIENTS[0]
  if (g === undefined) return 0
  return g[0] * dx + g[1] * dy + g[2] * dz
}

/** Perlin-style gradient noise in roughly [-1, 1]. */
export function noise3(seed: Seed, x: number, y: number, z: number): number {
  const s = seed.a | 0
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const u = fade(fx)
  const v = fade(fy)
  const w = fade(fz)

  const n000 = gradientDot(s, ix, iy, iz, fx, fy, fz)
  const n100 = gradientDot(s, ix + 1, iy, iz, fx - 1, fy, fz)
  const n010 = gradientDot(s, ix, iy + 1, iz, fx, fy - 1, fz)
  const n110 = gradientDot(s, ix + 1, iy + 1, iz, fx - 1, fy - 1, fz)
  const n001 = gradientDot(s, ix, iy, iz + 1, fx, fy, fz - 1)
  const n101 = gradientDot(s, ix + 1, iy, iz + 1, fx - 1, fy, fz - 1)
  const n011 = gradientDot(s, ix, iy + 1, iz + 1, fx, fy - 1, fz - 1)
  const n111 = gradientDot(s, ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1)

  return lerp(
    lerp(lerp(n000, n100, u), lerp(n010, n110, u), v),
    lerp(lerp(n001, n101, u), lerp(n011, n111, u), v),
    w,
  )
}

export interface FbmOptions {
  readonly octaves: number
  readonly frequency: number
  readonly lacunarity: number
  readonly gain: number
}

export const DEFAULT_FBM: FbmOptions = {
  octaves: 6,
  frequency: 1,
  lacunarity: 2.03, // Not exactly 2: integer lacunarity makes octave lattices align and streak.
  gain: 0.5,
}

/** Fractional Brownian motion, normalized to roughly [-1, 1]. */
export function fbm3(
  seed: Seed,
  x: number,
  y: number,
  z: number,
  options: Partial<FbmOptions> = {},
): number {
  const { octaves, frequency, lacunarity, gain } = {
    ...DEFAULT_FBM,
    ...options,
  }
  let sum = 0
  let amplitude = 1
  let norm = 0
  let f = frequency
  for (let i = 0; i < octaves; i += 1) {
    sum += amplitude * noise3(seed, x * f, y * f, z * f)
    norm += amplitude
    amplitude *= gain
    f *= lacunarity
  }
  return norm === 0 ? 0 : sum / norm
}

/**
 * Ridged multifractal — sharp crests from folded noise. Mountain ranges want
 * this; plain fBm reads as rolling dunes at every scale.
 */
export function ridged3(
  seed: Seed,
  x: number,
  y: number,
  z: number,
  options: Partial<FbmOptions> = {},
): number {
  const { octaves, frequency, lacunarity, gain } = {
    ...DEFAULT_FBM,
    ...options,
  }
  let sum = 0
  let amplitude = 1
  let norm = 0
  let f = frequency
  for (let i = 0; i < octaves; i += 1) {
    const n = 1 - Math.abs(noise3(seed, x * f, y * f, z * f))
    sum += amplitude * n * n
    norm += amplitude
    amplitude *= gain
    f *= lacunarity
  }
  return norm === 0 ? 0 : (sum / norm) * 2 - 1
}
