import { pcg3d } from './lattice.ts'
import type { Seed } from './seed.ts'

/*
 * Gradient noise that returns its own gradient.
 *
 * `noise3` in `noise.ts` returns a number. Everything a terrain field wants to
 * do with slope then has to recover one by finite differences — three extra
 * evaluations per sample for a normal, and a patch's edge row cannot take a
 * central difference at all without a border. Perlin noise is a closed-form
 * expression in the fractional coordinate, so its derivative is closed-form
 * too: the same eight corner gradients, interpolated with the same weights,
 * plus the fade curve's own derivative
 * ([Quilez](https://iquilezles.org/articles/morenoise/)). One evaluation, four
 * numbers, no border required.
 *
 * That buys three things this milestone needs. Analytic normals, so a patch's
 * shading cannot disagree with its neighbor's. Derivative-damped fBm — the
 * `eroded` variant below, where each octave is attenuated by how steep the sum
 * already is, which is what makes a range read as worn rather than as louder
 * noise. And a slope term the band stack can ask for directly, which is how a
 * scarp knows where a plate boundary faces.
 *
 * **Nothing here changes an existing output.** `noise3`, `fbm3` and `ridged3`
 * are untouched and still generate v1 terrain sample-for-sample; these are new
 * functions beside them, and the world only moves when the band stack that
 * calls them ships behind `TERRAIN_ALGORITHM` v2.
 */

/** A field's value and its gradient with respect to (x, y, z). */
export interface FieldSample {
  readonly value: number
  readonly dx: number
  readonly dy: number
  readonly dz: number
}

export const ZERO_FIELD: FieldSample = { value: 0, dx: 0, dy: 0, dz: 0 }

/**
 * The twelve cube-edge gradients, in three flat lanes as in `noise.ts`.
 *
 * Not a random direction per cell: the edge set has no zero-length or nearly
 * parallel pairs, so the lattice cannot produce a cell whose eight corners all
 * point the same way and read as a flat spot. Ken Perlin's 2002 improvement,
 * and it costs a table lookup instead of a normalize.
 */
const GRADIENT_COUNT = 12
const GRADIENT_X = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0])
const GRADIENT_Y = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1])
const GRADIENT_Z = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1])

const gradientAt = (seed: number, ix: number, iy: number, iz: number): number =>
  pcg3d(ix ^ seed, iy, iz).x % GRADIENT_COUNT

/** Quintic fade and its derivative, `30 t²(t-1)²`. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
const fadeSlope = (t: number): number => 30 * t * t * (t * (t - 2) + 1)

/**
 * Perlin gradient noise in roughly [-1, 1], with its analytic gradient.
 *
 * The eight corner dot products give the value the ordinary way; the eight
 * corner *gradients*, interpolated with the same weights, give the part of the
 * derivative that comes from the gradients themselves, and the fade curve's
 * slope gives the part that comes from the interpolation. Adding them is the
 * whole derivation.
 */
export function gradientNoise3(
  seed: Seed,
  x: number,
  y: number,
  z: number,
): FieldSample {
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
  const du = fadeSlope(fx)
  const dv = fadeSlope(fy)
  const dw = fadeSlope(fz)

  const g000 = gradientAt(s, ix, iy, iz)
  const g100 = gradientAt(s, ix + 1, iy, iz)
  const g010 = gradientAt(s, ix, iy + 1, iz)
  const g110 = gradientAt(s, ix + 1, iy + 1, iz)
  const g001 = gradientAt(s, ix, iy, iz + 1)
  const g101 = gradientAt(s, ix + 1, iy, iz + 1)
  const g011 = gradientAt(s, ix, iy + 1, iz + 1)
  const g111 = gradientAt(s, ix + 1, iy + 1, iz + 1)

  const x1 = fx - 1
  const y1 = fy - 1
  const z1 = fz - 1

  const gx000 = GRADIENT_X[g000] as number
  const gy000 = GRADIENT_Y[g000] as number
  const gz000 = GRADIENT_Z[g000] as number
  const gx100 = GRADIENT_X[g100] as number
  const gy100 = GRADIENT_Y[g100] as number
  const gz100 = GRADIENT_Z[g100] as number
  const gx010 = GRADIENT_X[g010] as number
  const gy010 = GRADIENT_Y[g010] as number
  const gz010 = GRADIENT_Z[g010] as number
  const gx110 = GRADIENT_X[g110] as number
  const gy110 = GRADIENT_Y[g110] as number
  const gz110 = GRADIENT_Z[g110] as number
  const gx001 = GRADIENT_X[g001] as number
  const gy001 = GRADIENT_Y[g001] as number
  const gz001 = GRADIENT_Z[g001] as number
  const gx101 = GRADIENT_X[g101] as number
  const gy101 = GRADIENT_Y[g101] as number
  const gz101 = GRADIENT_Z[g101] as number
  const gx011 = GRADIENT_X[g011] as number
  const gy011 = GRADIENT_Y[g011] as number
  const gz011 = GRADIENT_Z[g011] as number
  const gx111 = GRADIENT_X[g111] as number
  const gy111 = GRADIENT_Y[g111] as number
  const gz111 = GRADIENT_Z[g111] as number

  const a = gx000 * fx + gy000 * fy + gz000 * fz
  const b = gx100 * x1 + gy100 * fy + gz100 * fz
  const c = gx010 * fx + gy010 * y1 + gz010 * fz
  const d = gx110 * x1 + gy110 * y1 + gz110 * fz
  const e = gx001 * fx + gy001 * fy + gz001 * z1
  const f = gx101 * x1 + gy101 * fy + gz101 * z1
  const g = gx011 * fx + gy011 * y1 + gz011 * z1
  const h = gx111 * x1 + gy111 * y1 + gz111 * z1

  // The trilinear form, factored so the same coefficients serve the value and
  // the fade-curve half of the derivative.
  const k1 = b - a
  const k2 = c - a
  const k3 = e - a
  const k4 = a - b - c + d
  const k5 = a - b - e + f
  const k6 = a - c - e + g
  const k7 = -a + b + c - d + e - f - g + h

  /*
   * The interpolated corner gradients, one lane at a time, written out three
   * times rather than through a helper.
   *
   * A local closure taking eight numbers reads better and costs 200 ns a call —
   * five times the whole rest of this function — because it is allocated per
   * sample and the engine will not inline it at three call sites with eight
   * arguments each. The eight weights are hoisted, so what is repeated is nine
   * multiply-adds, and the shape of the expression is identical in all three.
   */
  const uv = u * v
  const uw = u * w
  const vw = v * w
  const uvw = uv * w

  return {
    value:
      a + k1 * u + k2 * v + k3 * w + k4 * uv + k5 * uw + k6 * vw + k7 * uvw,
    dx:
      gx000 +
      (gx100 - gx000) * u +
      (gx010 - gx000) * v +
      (gx001 - gx000) * w +
      (gx000 - gx100 - gx010 + gx110) * uv +
      (gx000 - gx100 - gx001 + gx101) * uw +
      (gx000 - gx010 - gx001 + gx011) * vw +
      (-gx000 + gx100 + gx010 - gx110 + gx001 - gx101 - gx011 + gx111) * uvw +
      du * (k1 + k4 * v + k5 * w + k7 * vw),
    dy:
      gy000 +
      (gy100 - gy000) * u +
      (gy010 - gy000) * v +
      (gy001 - gy000) * w +
      (gy000 - gy100 - gy010 + gy110) * uv +
      (gy000 - gy100 - gy001 + gy101) * uw +
      (gy000 - gy010 - gy001 + gy011) * vw +
      (-gy000 + gy100 + gy010 - gy110 + gy001 - gy101 - gy011 + gy111) * uvw +
      dv * (k2 + k4 * u + k6 * w + k7 * uw),
    dz:
      gz000 +
      (gz100 - gz000) * u +
      (gz010 - gz000) * v +
      (gz001 - gz000) * w +
      (gz000 - gz100 - gz010 + gz110) * uv +
      (gz000 - gz100 - gz001 + gz101) * uw +
      (gz000 - gz010 - gz001 + gz011) * vw +
      (-gz000 + gz100 + gz010 - gz110 + gz001 - gz101 - gz011 + gz111) * uvw +
      dw * (k3 + k5 * u + k6 * v + k7 * uv),
  }
}

export interface FieldOptions {
  readonly octaves: number
  readonly frequency: number
  readonly lacunarity: number
  readonly gain: number
  /**
   * How hard the accumulated slope attenuates later octaves. 0 is plain fBm.
   *
   * The analytic stand-in for erosion. Steep ground gets less fine detail than
   * flat ground, which is what running water and mass wasting actually do to a
   * landscape, and it is bought here with one divide per octave instead of an
   * iterative simulation that would be resolution- and order-dependent and
   * therefore uncomputable at a patch boundary.
   */
  readonly damping: number
}

export const DEFAULT_FIELD: FieldOptions = {
  octaves: 6,
  frequency: 1,
  // Not exactly 2, for the reason `DEFAULT_FBM` gives: integer lacunarity makes
  // successive octave lattices share their cell walls and streak.
  lacunarity: 2.03,
  gain: 0.5,
  damping: 0,
}

/**
 * Fractional Brownian motion with its gradient, normalized to roughly [-1, 1].
 *
 * With `damping > 0` this is Quilez's derivative-damped fBm. **The returned
 * gradient then treats the damping factor as locally constant**: differentiating
 * it properly needs the second derivatives of every earlier octave, which the
 * noise does not return. The error is second order in the damping and shows up
 * as a slightly under-stated slope on the steepest ground — which is exactly
 * where the damping has already flattened the detail that slope would come
 * from. Undamped, the gradient is exact.
 *
 * **`norm` accumulates the damped amplitude, not the raw one**, and that is
 * what keeps "roughly [-1, 1]" true rather than aspirational. Dividing a damped
 * sum by an undamped norm does not attenuate detail, it subtracts a bias: the
 * amplitude the damping removed never reaches the numerator and never leaves
 * the divisor, so the mean walks toward zero — and `ridgedField`'s `·2 - 1`
 * remap then walks it toward -1. Measured over 20,000 directions at seven
 * octaves, `ridgedField` reported a mean of -0.644 at `damping: 1` and -0.890
 * at 6, against +0.255 undamped. Damping is meant to move weight between
 * octaves, not to move the whole band off its own zero.
 */
export function fbmField(
  seed: Seed,
  x: number,
  y: number,
  z: number,
  options: Partial<FieldOptions> = {},
): FieldSample {
  const { octaves, frequency, lacunarity, gain, damping } = {
    ...DEFAULT_FIELD,
    ...options,
  }
  let value = 0
  let dx = 0
  let dy = 0
  let dz = 0
  let amplitude = 1
  let norm = 0
  let f = frequency
  // The slope the *field* has so far, in units of the input coordinate, which
  // is what the damping reads. Kept separate from the returned gradient because
  // the returned one is scaled by the damping and this one must not be.
  let sx = 0
  let sy = 0
  let sz = 0
  for (let i = 0; i < octaves; i += 1) {
    const n = gradientNoise3(seed, x * f, y * f, z * f)
    sx += n.dx * f
    sy += n.dy * f
    sz += n.dz * f
    const damp =
      damping === 0 ? 1 : 1 / (1 + damping * (sx * sx + sy * sy + sz * sz))
    const a = amplitude * damp
    value += a * n.value
    dx += a * n.dx * f
    dy += a * n.dy * f
    dz += a * n.dz * f
    norm += amplitude * damp
    amplitude *= gain
    f *= lacunarity
  }
  if (norm === 0) return ZERO_FIELD
  return { value: value / norm, dx: dx / norm, dy: dy / norm, dz: dz / norm }
}

/**
 * Ridged multifractal with its gradient, in roughly [-1, 1].
 *
 * `(1 - |n|)²` per octave, which is the fold that turns a smooth maximum into a
 * crest. The derivative follows through the fold: `d/dp (1-|n|)² =
 * -2(1-|n|)·sign(n)·∇n`, so a ridge line reports the slope of the face it is on
 * rather than the slope of the noise underneath it.
 */
export function ridgedField(
  seed: Seed,
  x: number,
  y: number,
  z: number,
  options: Partial<FieldOptions> = {},
): FieldSample {
  const { octaves, frequency, lacunarity, gain, damping } = {
    ...DEFAULT_FIELD,
    ...options,
  }
  let value = 0
  let dx = 0
  let dy = 0
  let dz = 0
  let amplitude = 1
  let norm = 0
  let f = frequency
  let sx = 0
  let sy = 0
  let sz = 0
  for (let i = 0; i < octaves; i += 1) {
    const n = gradientNoise3(seed, x * f, y * f, z * f)
    const sign = n.value < 0 ? -1 : 1
    const r = 1 - sign * n.value
    const outer = -2 * r * sign
    sx += n.dx * f
    sy += n.dy * f
    sz += n.dz * f
    const damp =
      damping === 0 ? 1 : 1 / (1 + damping * (sx * sx + sy * sy + sz * sz))
    const a = amplitude * damp
    value += a * r * r
    dx += a * outer * n.dx * f
    dy += a * outer * n.dy * f
    dz += a * outer * n.dz * f
    norm += amplitude * damp
    amplitude *= gain
    f *= lacunarity
  }
  if (norm === 0) return ZERO_FIELD
  // Remapped to [-1, 1] like `ridged3`, so the two are interchangeable as band
  // inputs and an amplitude tuned against one reads the same against the other.
  return {
    value: (value / norm) * 2 - 1,
    dx: (dx / norm) * 2,
    dy: (dy / norm) * 2,
    dz: (dz / norm) * 2,
  }
}
