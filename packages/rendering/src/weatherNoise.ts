import { pcg4d } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'

/*
 * The CPU reference of the noises the clouds bake once and read every step:
 * the Perlin–Worley base shape, the Worley detail and the 2D curl. Each tiles
 * at its period because every lattice hashes its integer cell modulo the
 * period with `pcg4d`, so the GPU's textures can be held to it texel by
 * texel (`cloudNoise.ts` ports each function line for line).
 *
 * Every number a lattice draws is the hash's top 24 bits over 2²⁴, which a
 * float32 holds exactly, so the CPU and the GPU place every feature point and
 * pick every gradient alike; what is left to differ is float32 against
 * float64 in continuous arithmetic, a few parts in 10⁷ of a value in [0, 1].
 * Nothing here is canonical: the noise is presentation, regenerated at boot,
 * stored nowhere.
 */

/** Base-noise cells a period: the 128-texel texture holds eight, 16 texels a cell. */
export const BASE_NOISE_PERIOD = 8
/** Detail-noise cells a period: the 32-texel texture holds four, 8 texels a cell. */
export const DETAIL_NOISE_PERIOD = 4

/**
 * pcg4d's fourth input, one per octave, so no two octaves share a lattice.
 * The cell's three coordinates are the first three; a 2D lattice passes 0
 * for the third.
 */
export const NOISE_LANES = {
  perlin: [0x434c_0001, 0x434c_0002, 0x434c_0003],
  worley: [0x434c_0011, 0x434c_0012, 0x434c_0013],
  detail: [0x434c_0021, 0x434c_0022, 0x434c_0023],
  curl: [0x434c_0031, 0x434c_0032],
} as const

/**
 * The curl's scale into [−1, 1]: two octaves of 2D gradient noise have
 * slopes of about one in their lattice's units, and reach four or so where
 * corners agree, which the clamp holds at one.
 */
export const CURL_GAIN = 0.5
/** The base shape's displacement by the curl, in base cells: a quarter at the curl's full swing. */
export const CURL_REACH = 0.25

const TWO_24 = 16_777_216

/** A hash lane's top 24 bits as a fraction in [0, 1), exact in float32. */
const fraction24 = (lane: number): number => (lane >>> 8) / TWO_24

/** An integer cell reduced into [0, period). */
const wrap = (cell: number, period: number): number =>
  (((cell % period) + period) % period) | 0

/**
 * The jittered feature point of a Worley cell, in [0, 1)³ of the cell: the
 * hash of the cell taken modulo the period, so the cell `period` over draws
 * the same point and the lattice tiles.
 */
export function worleyFeature(
  i: number,
  j: number,
  k: number,
  period: number,
  lane: number,
): Vec3 {
  const h = pcg4d(wrap(i, period), wrap(j, period), wrap(k, period), lane)
  return { x: fraction24(h.x), y: fraction24(h.y), z: fraction24(h.z) }
}

/**
 * One minus the distance to the nearest feature point, in cells, clamped to
 * [0, 1]: bright at a feature, dark between them, which is a cloud's billow
 * and not its gaps. Continuous everywhere, because a minimum of continuous
 * distances is; the 27 cells around the point's own are enough, since a
 * feature point lies inside its own cell.
 */
function worley(x: number, y: number, z: number, period: number, lane: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  let nearest = 8
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const f = worleyFeature(ix + dx, iy + dy, iz + dz, period, lane)
        const px = dx + f.x - fx
        const py = dy + f.y - fy
        const pz = dz + f.z - fz
        nearest = Math.min(nearest, px * px + py * py + pz * pz)
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(nearest))
}

/** Perlin's quintic fade, 6t⁵ − 15t⁴ + 10t³. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
/** Its derivative, 30t²(t − 1)². */
const fadeSlope = (t: number): number => 30 * t * t * (t * (t - 2) + 1)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Perlin's improved-noise gradient (2002): the hash's low four bits pick one
 * of the twelve cube-edge directions (four of them twice) and dot it with
 * the corner's offset, by selects alone, so the GPU takes the same branch.
 */
function gradient3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15
  const u = h < 8 ? x : y
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
}

/** 3D gradient noise with `period` cells a period, in about [−1, 1]. */
function perlin(x: number, y: number, z: number, period: number, lane: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const corner = (cx: number, cy: number, cz: number): number =>
    gradient3(
      pcg4d(
        wrap(ix + cx, period),
        wrap(iy + cy, period),
        wrap(iz + cz, period),
        lane,
      ).x,
      fx - cx,
      fy - cy,
      fz - cz,
    )
  const u = fade(fx)
  const v = fade(fy)
  const w = fade(fz)
  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), u)
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), u)
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), u)
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), u)
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w)
}

/**
 * A 2D lattice gradient from the hash's low three bits: the four diagonals
 * (±1, ±1) and the four axes, unnormalized so both sides hold them exactly.
 */
function gradient2(hash: number): readonly [number, number] {
  const h = hash & 7
  const sx = (h & 1) === 0 ? 1 : -1
  const sy = (h & 2) === 0 ? 1 : -1
  if (h < 4) return [sx, sy]
  return h < 6 ? [sx, 0] : [0, sx]
}

/**
 * 2D gradient noise with its analytic slope, [value, ∂/∂x, ∂/∂y] in the
 * lattice's own units (Quilez's form): the slope from the fade's derivative
 * and the corners' gradients, never a difference of two samples.
 */
function perlin2(
  x: number,
  y: number,
  period: number,
  lane: number,
): readonly [number, number, number] {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const g = (cx: number, cy: number) =>
    gradient2(pcg4d(wrap(ix + cx, period), wrap(iy + cy, period), 0, lane).x)
  const g00 = g(0, 0)
  const g10 = g(1, 0)
  const g01 = g(0, 1)
  const g11 = g(1, 1)
  const v00 = g00[0] * fx + g00[1] * fy
  const v10 = g10[0] * (fx - 1) + g10[1] * fy
  const v01 = g01[0] * fx + g01[1] * (fy - 1)
  const v11 = g11[0] * (fx - 1) + g11[1] * (fy - 1)
  const ux = fade(fx)
  const uy = fade(fy)
  const dux = fadeSlope(fx)
  const duy = fadeSlope(fy)
  const k1 = v10 - v00
  const k2 = v01 - v00
  const k3 = v00 - v10 - v01 + v11
  const value = v00 + k1 * ux + k2 * uy + k3 * ux * uy
  const dx =
    g00[0] +
    (g10[0] - g00[0]) * ux +
    (g01[0] - g00[0]) * uy +
    (g00[0] - g10[0] - g01[0] + g11[0]) * ux * uy +
    dux * (k1 + k3 * uy)
  const dy =
    g00[1] +
    (g10[1] - g00[1]) * ux +
    (g01[1] - g00[1]) * uy +
    (g00[1] - g10[1] - g01[1] + g11[1]) * ux * uy +
    duy * (k2 + k3 * ux)
  return [value, dx, dy]
}

const clamp = (x: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, x))

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Where the Perlin–Worley value lies: measured over 20,000 points of a
 * period, 1% under 0.523 and 1% over 0.803, a bell about 0.67. A smoothstep
 * over this span is close to that bell's distribution function, so the base
 * comes out near uniform on [0, 1], and a layer of coverage c at full
 * profile is cloudy over about c of its volume (§5.6's remap keeps
 * n_b > 1 − c): measured, 15% at a coverage of 0.2, 31% at 0.35 and 50% at
 * 0.5. Read unspread, the bell puts the same three at about 1%, 64% and
 * 99%, which no coverage lever could steer.
 */
export const BASE_NOISE_SPREAD = [0.52, 0.82] as const

/**
 * The curl of a tiling 2D potential at a point of the unit square, which is
 * one period: (∂ψ/∂v, −∂ψ/∂u), divergence-free, each component clamped to
 * [−1, 1]. ψ is gradient noise with four lattice cells a period plus half an
 * octave of eight; the second octave's slope in the first's units is its own
 * slope times its half amplitude times its double frequency, so the two add.
 */
export function curlNoise(u: number, v: number): readonly [number, number] {
  const [, ax, ay] = perlin2(4 * u, 4 * v, 4, NOISE_LANES.curl[0])
  const [, bx, by] = perlin2(8 * u, 8 * v, 8, NOISE_LANES.curl[1])
  const dx = ax + bx
  const dy = ay + by
  return [clamp(CURL_GAIN * dy, -1, 1), clamp(-CURL_GAIN * dx, -1, 1)]
}

/**
 * The base texture's four channels at a point in base cells (period
 * `BASE_NOISE_PERIOD`): the Perlin–Worley base shape, then the three Worley
 * octaves its dilation is made of. The bake stores the first; the octaves
 * are what `weatherNoise.test.ts` holds to their own tiling and range.
 *
 * The curl is folded in here, at the bake: the point is displaced across its
 * xz plane by up to `CURL_REACH` of a cell before any lattice is read, so the
 * tearing it gives an edge costs the march no read of its own, and every
 * medium that reads the base — the fine march, the volume's bake, the far
 * bakes — sees one field. The curl tiles at the base's period, so the base
 * still does.
 *
 * The shape is Hillaire's Perlin–Worley, remap(perlin, fbm − 1, 1, 0, 1): a
 * three-octave Perlin billow (four lattice cells a period, two base cells a
 * cell) dilated by a three-octave Worley FBM (8, 16 and 32 cells a period,
 * weighted 0.625, 0.25 and 0.125), then spread over [0, 1] (`BASE_NOISE_SPREAD`).
 */
export function baseNoiseWide(
  cells: Vec3,
): readonly [number, number, number, number] {
  const [cx, cz] = curlNoise(
    cells.x / BASE_NOISE_PERIOD,
    cells.z / BASE_NOISE_PERIOD,
  )
  const x = cells.x + cx * CURL_REACH
  const y = cells.y
  const z = cells.z + cz * CURL_REACH
  const [p0, p1, p2] = NOISE_LANES.perlin
  const billow =
    (perlin(x / 2, y / 2, z / 2, 4, p0) +
      0.5 * perlin(x, y, z, 8, p1) +
      0.25 * perlin(2 * x, 2 * y, 2 * z, 16, p2)) /
    1.75
  const perlin01 = clamp(0.5 + 0.5 * billow, 0, 1)
  const [w0, w1, w2] = NOISE_LANES.worley
  const near = worley(x, y, z, 8, w0)
  const mid = worley(2 * x, 2 * y, 2 * z, 16, w1)
  const far = worley(4 * x, 4 * y, 4 * z, 32, w2)
  const fbm = 0.625 * near + 0.25 * mid + 0.125 * far
  const low = fbm - 1
  const shape = clamp((perlin01 - low) / (1 - low), 0, 1)
  return [
    smoothstep(BASE_NOISE_SPREAD[0], BASE_NOISE_SPREAD[1], shape),
    near,
    mid,
    far,
  ]
}

/** The base shape at a point in base-cell units, in [0, 1]. */
export function baseNoise(cells: Vec3): number {
  return baseNoiseWide(cells)[0]
}

/**
 * The detail noise at a point in its own cell units (period
 * `DETAIL_NOISE_PERIOD`), in [0, 1]: a three-octave Worley FBM, 4, 8 and 16
 * cells a period, which erodes the base's edges where the footprint resolves
 * a quarter of a base cell.
 */
export function detailNoise(cells: Vec3): number {
  const [d0, d1, d2] = NOISE_LANES.detail
  const { x, y, z } = cells
  return (
    0.625 * worley(x, y, z, 4, d0) +
    0.25 * worley(2 * x, 2 * y, 2 * z, 8, d1) +
    0.125 * worley(4 * x, 4 * y, 4 * z, 16, d2)
  )
}
