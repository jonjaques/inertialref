import type { Node, Texture, WebGPURenderer } from 'three/webgpu'
import { dot, float, fract, uint, vec2 } from 'three/tsl'
import type { CloudJitterNodes, CloudResource } from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * The trace's jitter: two numbers in [0, 1) for a pixel on a frame, one that
 * places a ray's first step and one that places its sampling point inside
 * its pixel. Behind one function, so what draws them is the jitter's own
 * business: a hash, or a mask it uploads and reads.
 */

/*
 * The frame offsets as 32-bit fractions — round(α·2³²) for R1's golden-ratio
 * conjugate and the plastic number's reciprocal — so a frame's offset is a
 * u32 product, which wraps exactly. `frame·0.618034` in float32 loses the
 * fraction's low bits once the product passes 2²³: a 0.06 step after 1.6
 * million frames, seven hours at 60 Hz, and every texel's jitter on a
 * sixteenth of the pixel.
 */
const R1_FRACTION = 2654435769
const PLASTIC_FRACTION = 3242174889

/**
 * Interleaved gradient noise (Jimenez 2014) at the pixel plus an R1 step a
 * frame: two numbers in [0, 1), decorrelated by reading the second at the
 * transposed pixel with a step of its own. The cost is one hash a ray.
 *
 * `.x` places the first step along the ray. A texel's sampling point is
 * `.y`'s pair less ½: `traceScreen` takes an offset from the texel's center.
 */
export function traceJitter(
  pixel: Node<'uvec2'>,
  frame: Node<'uint'>,
): Node<'vec2'> {
  const p = vec2(pixel)
  const gradient = (q: Node<'vec2'>): Node<'float'> =>
    fract(float(52.9829189).mul(fract(dot(q, vec2(0.06711056, 0.00583715)))))
  const offset = (fraction: number): Node<'float'> =>
    float(frame.mul(uint(fraction)).shiftRight(uint(8))).mul(2 ** -24)
  return vec2(
    fract(gradient(p).add(offset(R1_FRACTION))),
    fract(gradient(p.yx.add(vec2(37, 17))).add(offset(PLASTIC_FRACTION))),
  )
}

export interface CloudJitterDeps {
  /** `trace.jitter` says which draw a frame takes. */
  readonly uniforms: CloudUniforms
}

/** The jitter as the field holds it: its nodes, and whatever it uploads to draw them. */
export interface CloudJitter extends CloudResource, CloudJitterNodes {}

/**
 * The jitter every trace of a field draws with: interleaved gradient noise,
 * whatever `trace.jitter` holds. It uploads nothing, so it holds no texture
 * and no bytes.
 */
export function createCloudJitter(_deps: CloudJitterDeps): CloudJitter {
  return {
    name: 'jitter',
    bytes: 0,
    pending: false,
    at: traceJitter,
    textures: (): readonly Texture[] => [],
    warm: (_renderer: WebGPURenderer): Promise<void> => Promise.resolve(),
    render: (): void => {},
    dispose: (): void => {},
  }
}
