import type { Data3DTexture } from 'three/webgpu'
import { dot, float, normalize, texture3D, vec3, vec4 } from 'three/tsl'
import { NOISE_CELLS, NOISE_GRADIENT_SCALE } from './noiseTexture.ts'

/*
 * Noise as node graphs, shared by the ground and the sea.
 *
 * Every octave either material spends is a fetch of the noise baked into
 * `noiseTexture()`: one trilinear read where a lattice evaluation was eight
 * hashes and eight dot products, on a field that is periodic by
 * construction. The sub-meter bands need the periodicity — their domain is
 * a patch-local position offset by an origin reduced modulo the period on
 * the CPU, and two patches agree where they overlap only because the field
 * closes on it (`render/terrain.ts` § `GRAIN_PERIOD`) — and the coarse bands
 * get it for free.
 */

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
/** A value and its gradient, as one `vec4`: `x` the value, `yzw` the slope. */
export type Field = ReturnType<typeof vec4>
export const asVector = (node: unknown): Vector => node as Vector
export const asScalar = (node: unknown): Scalar => node as Scalar
export const asField = (node: unknown): Field => node as Field

/**
 * The baked noise as a node: one `texture3D` over `noiseTexture()`, made per
 * material because a texture node is a binding and a binding belongs to the
 * graph that reads it.
 */
export type NoiseSampler = ReturnType<typeof texture3D>
export const noiseSampler = (map: Data3DTexture): NoiseSampler => texture3D(map)

/**
 * One octave of the baked noise at `point`, in lattice cells: the value in
 * [-1, 1] in `x`, and its gradient with respect to `point` in `yzw`.
 *
 * The sampler wraps, so the division by the period is the whole of the
 * addressing: a coordinate of 40 cells is the same texel as one of 8.
 */
export function noiseFetch(sampler: NoiseSampler, point: Vector): Field {
  const uvw = asVector(point.mul(float(1 / NOISE_CELLS)))
  const texel = asField(sampler.sample(uvw))
  const unpacked = asField(texel.mul(2).sub(1))
  return asField(
    vec4(
      unpacked.x,
      unpacked.y.mul(NOISE_GRADIENT_SCALE),
      unpacked.z.mul(NOISE_GRADIENT_SCALE),
      unpacked.w.mul(NOISE_GRADIENT_SCALE),
    ),
  )
}

/**
 * Fractal noise from the baked texture: `octaves` fetches at doubling
 * frequency and halving amplitude, normalized to [-1, 1] — the value in `x`
 * and the gradient with respect to `point` in `yzw`, each octave's gradient
 * scaled by its frequency as the chain rule says. The replacement for
 * `mx_fractal_noise_float` and for a lattice fBm alike: eight hashes and
 * eight dot products an octave against one trilinear fetch, and a gradient
 * that costs nothing more.
 */
export function fbmFetch(
  sampler: NoiseSampler,
  point: Vector,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): Field {
  let sum: Field = asField(vec4(0))
  let norm = 0
  let amplitude = 1
  let scale = 1
  for (let i = 0; i < octaves; i += 1) {
    const octave = noiseFetch(sampler, asVector(point.mul(float(scale))))
    sum = asField(
      sum.add(vec4(octave.x.mul(amplitude), octave.yzw.mul(amplitude * scale))),
    )
    norm += amplitude
    amplitude *= gain
    scale *= lacunarity
  }
  return asField(sum.mul(float(1 / norm)))
}

/**
 * A normal perturbed by a height field's gradient: the surface normal, less
 * the part of the gradient that lies in the tangent plane, renormalized.
 *
 * `gradient` is the slope of the height in meters per meter along each
 * body-fixed axis. Its tangential part is the slope of the height across
 * the surface, which is exactly what tilts the normal; its radial part is
 * the field changing with altitude, which a surface cannot see and which
 * the projection discards.
 */
export function bumped(normal: Vector, gradient: Vector): Vector {
  const along = asVector(gradient.sub(normal.mul(dot(gradient, normal))))
  return asVector(normalize(normal.sub(along)))
}
