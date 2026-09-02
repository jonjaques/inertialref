import { floor, fract, mod, mix, dot, float, sin, vec3 } from 'three/tsl'

/*
 * Noise as node graphs, shared by the ground and the sea.
 *
 * `mx_fractal_noise_float` is what TSL ships and it is what the ground's
 * detail field reads; what it lacks is the one property the sub-meter bands
 * need, which is periodicity. Both materials evaluate a fine octave on a
 * patch-local position offset by an origin reduced modulo a period on the
 * CPU, and two patches agree where they overlap only if the field closes on
 * that period. `render/terrain.ts` § `GRAIN_PERIOD` carries the argument.
 */

/**
 * Value noise on a wrapped integer lattice, in [-1, 1].
 *
 * Written out rather than taken from `mx_*`, because the one property this band
 * needs is the one none of the built-ins has: **periodicity**. The domain is a
 * patch-local position offset by an origin already reduced modulo the period, so
 * two patches agree wherever they overlap only if the field itself closes on
 * that period — otherwise the reduction is the seam it was added to remove.
 *
 * The hash is the classic `fract(sin(dot))`, which is a poor hash at large
 * coordinates and a perfectly good one here: `wrap` keeps every lattice index
 * under `period`, so the argument to `sin` never leaves the range float32
 * resolves finely. Eight corners, smoothstep interpolation, three octaves —
 * twenty-four hashes a fragment, on a band that has already faded out by a meter
 * of footprint.
 */
export function periodicFbm(
  point: Vector,
  octaves: number,
  period: number,
): Scalar {
  let sum: Scalar = asScalar(float(0))
  let norm = 0
  let amplitude = 1
  for (let i = 0; i < octaves; i += 1) {
    const scale = 2 ** i
    sum = asScalar(
      sum.add(
        periodicNoise(asVector(point.mul(float(scale))), period * scale).mul(
          amplitude,
        ),
      ),
    )
    norm += amplitude
    amplitude *= 0.5
  }
  return asScalar(sum.mul(float(1 / norm)))
}

/** One octave of it: eight wrapped corners, trilinear through a Hermite step. */
function periodicNoise(point: Vector, period: number): Scalar {
  const cell = asVector(floor(point))
  const inside = asVector(point.sub(cell))
  // The same Hermite `smoothstep` uses, spelled out because the endpoints are 0
  // and 1 and a `smoothstep(0, 1, x)` would be two more constants to read.
  const t = asVector(inside.mul(inside).mul(inside.mul(-2).add(3)))
  const corner = (dx: number, dy: number, dz: number): Scalar =>
    latticeValue(asVector(cell.add(vec3(dx, dy, dz))), period)
  const x00 = mix(corner(0, 0, 0), corner(1, 0, 0), t.x)
  const x10 = mix(corner(0, 1, 0), corner(1, 1, 0), t.x)
  const x01 = mix(corner(0, 0, 1), corner(1, 0, 1), t.x)
  const x11 = mix(corner(0, 1, 1), corner(1, 1, 1), t.x)
  return mix(mix(x00, x10, t.y), mix(x01, x11, t.y), t.z)
    .mul(2)
    .sub(1)
}

/** One lattice cell's value in [0, 1), wrapped so the field is periodic. */
function latticeValue(cell: Vector, period: number): Scalar {
  const wrapped = asVector(mod(cell, float(period)))
  return asScalar(
    fract(sin(dot(wrapped, vec3(127.1, 311.7, 74.7))).mul(float(43758.5453))),
  )
}

/**
 * The two node shapes the noise above passes around, and the two re-narrowings
 * that keep it readable.
 *
 * TSL's builders each return their own node class — `vec3()` a join, `.mul()` an
 * operator, `mix()` a math node — so an arithmetic chain changes type at every
 * step and a helper typed against one of them cannot be called with the result
 * of another. Every one of them is the same thing at runtime and generates the
 * same WGSL; the cast is a re-narrowing rather than a lie, and it is the same
 * one `sampled` above makes for the same reason.
 */
export type Vector = ReturnType<typeof vec3>
export type Scalar = ReturnType<typeof float>
export const asVector = (node: unknown): Vector => node as Vector
export const asScalar = (node: unknown): Scalar => node as Scalar
