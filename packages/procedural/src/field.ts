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

/*
 * The same hash `noise3` uses, written out rather than called.
 *
 * `pcg3d` was the obvious choice here and it was wrong twice over.
 * `lattice.ts` exists to give *feature placement* several decorrelated values
 * from one cell — does a crater exist, where in the cell, how wide — while a
 * gradient lattice wants one number per corner, which is what `hash3` is. So it
 * paid for three lanes to read one, eight times a sample and up to twelve
 * octaves deep.
 *
 * The correctness half matters more. A different hash is a different field, and
 * `bands.ts` picks between `ridged3` and `ridgedField` on whether the world
 * erodes, on the stated grounds that the two give "the same number" — they
 * differed by up to 1.25 on a band whose contract is [-1, 1], so two worlds a
 * pascal apart got unrelated mountain ranges rather than the same ones slightly
 * more worn. `field.test.ts` now holds `gradientNoise3` against `noise3` and
 * both fBm forms against theirs, which pins this table and the fade curve to
 * `noise.ts`'s at the same time and is why they are allowed to be spelled twice.
 *
 * Written out because *calling* `hash3` costs 14 ms a patch on an eroded world —
 * 51.8 against 37.1 — where the same call in `noise.ts` costs nothing
 * measurable. `hash3` composes with `mix32`, so it is two levels deep at eight
 * call sites, and V8's cumulative inlining budget runs out across them; this is
 * the trade `craters.ts` records for its imports, in the one other place the
 * measurement justifies it.
 */
const gradientAt = (seed: number, ix: number, iy: number, iz: number): number => {
  // `hash3` composed with `mix32`, written out. Calling it costs 14 ms a patch
  // on an eroded world — eight call sites two levels deep exhaust V8's inlining
  // budget, which is the same trade `craters.ts` records for its imports.
  let h =
    (Math.imul((ix ^ seed) | 0, 0x9e37_79b1) ^
      Math.imul(iy | 0, 0x85eb_ca6b) ^
      Math.imul(iz | 0, 0xc2b2_ae35)) |
    0
  h ^= h >>> 16
  h = Math.imul(h, 0x85eb_ca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2_ae35)
  h ^= h >>> 16
  return (h >>> 0) % GRADIENT_COUNT
}

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
 * **`norm` accumulates the raw amplitude, not the damped one**, because that is
 * the difference between attenuating detail and merely re-mixing it. Dividing by
 * the damped sum renormalizes every sample back to full range — the amplitude
 * the damping removed leaves the numerator *and* the divisor, so the octave
 * *ratios* barely move and the position-varying divisor injects structure of its
 * own. Measured as total variation along a 4,000-sample line at eight octaves,
 * that version got **rougher** as the damping rose: 29.3 undamped, 30.6 at
 * `damping: 1.2`, 41.7 at 24. Against the undamped norm it falls the way the
 * name says — 29.3, 11.9, 2.5 — and "roughly [-1, 1]" becomes an upper bound
 * rather than a target, which is what a worn landscape is.
 *
 * The bias that argued for the damped divisor is real and belongs to the ridge
 * fold rather than to the norm; `ridgedField` remaps per octave and the comment
 * there carries the arithmetic.
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
  /*
   * The slope the *field* has so far, in units of the input coordinate, which
   * is what the damping reads. Kept separate from the returned gradient because
   * the returned one is scaled by the damping and this one must not be.
   *
   * **The octave's amplitude belongs in here and the damping does not.** An
   * octave contributes `a·n(p·f)` to the field, so it contributes `a·f·∇n` to
   * the slope; dropping the `a` leaves a sum that grows as `lacunarity^i`
   * instead of `(lacunarity·gain)^i` — 1.015 per octave becomes 2.03, so by the
   * fifth octave the accumulator is seventy times the slope it is meant to be
   * and `damp` is a geometric decay on the octave index rather than a reading of
   * the ground. Measured before the fix: octave weights of 0.813/0.156/0.027 at
   * `damping` 1 against 0.850/0.128/0.019 at 24, so a dial with a 48× range
   * moved the fundamental's share by three points and every atmosphered world
   * was three octaves of fBm wearing the cost of twelve.
   */
  let sx = 0
  let sy = 0
  let sz = 0
  for (let i = 0; i < octaves; i += 1) {
    const n = gradientNoise3(seed, x * f, y * f, z * f)
    sx += amplitude * n.dx * f
    sy += amplitude * n.dy * f
    sz += amplitude * n.dz * f
    const damp =
      damping === 0 ? 1 : 1 / (1 + damping * (sx * sx + sy * sy + sz * sz))
    const a = amplitude * damp
    value += a * n.value
    dx += a * n.dx * f
    dy += a * n.dy * f
    dz += a * n.dz * f
    norm += amplitude
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
    /*
     * The *noise's* slope, not the fold's, and that is not an oversight.
     *
     * `(1 - |n|)²` has a kink exactly where the noise crosses zero — that kink
     * is the ridge line — so its derivative flips sign there. Feeding that to
     * the accumulator makes `sx` jump discontinuously at every crest of every
     * octave, and `damp` reads `sx² + sy² + sz²`, so the *value* jumps with it:
     * 14.9 m of step on a landing target, and `geology.test.ts`'s bisecting
     * continuity walk fails on Mars by three orders of magnitude. The damping
     * wants a measure of how contorted the field is around here, and the
     * underlying noise's slope is that measure without the fold's sign in it.
     */
    sx += amplitude * n.dx * f
    sy += amplitude * n.dy * f
    sz += amplitude * n.dz * f
    const damp =
      damping === 0 ? 1 : 1 / (1 + damping * (sx * sx + sy * sy + sz * sz))
    const a = amplitude * damp
    /*
     * `2r² − 1` per octave rather than `·2 − 1` on the sum at the end, and the
     * two are the same number undamped: `2·Σa·r²/Σa − 1 = Σa·(2r² − 1)/Σa`,
     * because `Σa/Σa` is one. `ridged3` agrees with this to twelve decimals and
     * `field.test.ts` holds it there.
     *
     * They stop being the same the moment `damp` is not one, and that is the
     * point. Remapping at the end, a damped sum shrinks toward zero and `·2 − 1`
     * carries it toward **−1**: the whole band slides off its own datum, which
     * is the bias measured at −0.644 for `damping: 1` and −0.890 at 6. Remapping
     * per octave, a damped octave contributes less of a quantity already
     * centred on zero, so attenuation lands on the band's midpoint where it
     * belongs.
     */
    value += a * (2 * r * r - 1)
    dx += a * 2 * outer * n.dx * f
    dy += a * 2 * outer * n.dy * f
    dz += a * 2 * outer * n.dz * f
    norm += amplitude
    amplitude *= gain
    f *= lacunarity
  }
  if (norm === 0) return ZERO_FIELD
  return { value: value / norm, dx: dx / norm, dy: dy / norm, dz: dz / norm }
}
