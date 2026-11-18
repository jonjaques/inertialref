import {
  Data3DTexture,
  NearestFilter,
  type Node,
  RedFormat,
  type Texture,
  type TextureNode,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  dot,
  float,
  fract,
  int,
  ivec3,
  select,
  texture3D,
  uint,
  uvec2,
  vec2,
  vec4,
} from 'three/tsl'
import { BLUE_NOISE } from '@inertialref/rendering'
import { CLOUD_JITTERS } from './cloudLevers.ts'
import type { CloudJitterNodes, CloudResource } from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * The trace's jitter: the numbers a ray is placed by on a frame — the share
 * of its first step, the point inside its history pixel, and the handover's
 * ξ. Behind one module, so what draws them is the jitter's own business:
 * interleaved gradient noise, or the spatiotemporal blue-noise mask
 * (phase 1 design §5.10), as the `jitter` lever says.
 */

/*
 * The frame offsets as 32-bit fractions — round(α·2³²) for R1's golden-ratio
 * conjugate, the plastic number's reciprocal and its square — so a frame's
 * offset is a u32 product, which wraps exactly. `frame·0.618034` in float32
 * loses the fraction's low bits once the product passes 2²³: a 0.06 step
 * after 1.6 million frames, seven hours at 60 Hz, and every texel's jitter
 * on a sixteenth of the pixel.
 */
const R1_FRACTION = 2654435769
const PLASTIC_FRACTION = 3242174889
const PLASTIC_SQUARED_FRACTION = 2447445414

/** Jimenez's gradient at a point: one hash, in [0, 1). */
const gradient = (q: Node<'vec2'>): Node<'float'> =>
  fract(float(52.9829189).mul(fract(dot(q, vec2(0.06711056, 0.00583715)))))

/** A frame's step along a sequence of fraction `fraction`, in [0, 1). */
const step = (frame: Node<'uint'>, fraction: number): Node<'float'> =>
  float(frame.mul(uint(fraction)).shiftRight(uint(8))).mul(2 ** -24)

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
  return vec2(
    fract(gradient(p).add(step(frame, R1_FRACTION))),
    fract(gradient(p.yx.add(vec2(37, 17))).add(step(frame, PLASTIC_FRACTION))),
  )
}

/**
 * The gradient's third number at a texel: read along the diagonals. A third
 * read transposed or shifted from the first two is the same hash plus a
 * constant over a frame, so it correlates with whichever read shares its
 * orientation; on the diagonals it holds under 0.005 against the other three
 * on the frames cloudJitter.gpu.test.ts reads, which holds it to 0.05.
 */
function gradientThird(
  texel: Node<'uvec2'>,
  frame: Node<'uint'>,
): Node<'float'> {
  const p = vec2(texel)
  const diagonal = vec2(p.x.add(p.y), p.x.sub(p.y).add(97))
  return fract(gradient(diagonal).add(step(frame, PLASTIC_SQUARED_FRACTION)))
}

/** The mask's texels, [slice][y][x], one byte each. */
export function blueNoiseTexels(): Uint8Array {
  const text = atob(BLUE_NOISE.bytes)
  return Uint8Array.from(text, (c) => c.charCodeAt(0))
}

/**
 * Where a ray's numbers are read in the mask, from its trace texel: `.x`,
 * `.y`, `.z` and `.w` at these offsets, each phase of the interleave a
 * further `PHASE_STRIDE` times the phase. The sixteen reads of a 2 × 2
 * block of history pixels sit on a lattice sixteen texels apart, eight σ of
 * the mask's kernel, so no two of a ray's numbers, and no two of a block's
 * rays, share a neighborhood the generator ordered together.
 *
 * Without the phase's offset a texel would read one texel for all four
 * pixels it traces in a cycle, and the history would hold the same first
 * step in every 2 × 2 block.
 */
export const MASK_READS = [
  [0, 0],
  [16, 0],
  [0, 16],
  [16, 16],
] as const
export const PHASE_STRIDE = 32

/**
 * The slice a frame reads: a history pixel takes a fresh sample every fourth
 * frame, so its eight samples are eight consecutive slices, and the mask's
 * property in time is over consecutive ones. It wraps with no shift: the
 * mask is toroidal in time, and a restarted or shifted sequence puts an
 * error spike in an exponential average (Wolfe et al., arXiv 2112.09629).
 */
const sliceOf = (frame: Node<'uint'>): Node<'uint'> =>
  frame.shiftRight(uint(2)).mod(uint(BLUE_NOISE.slices))

const STBN = CLOUD_JITTERS.indexOf('stbn')
const MASK_BYTES = BLUE_NOISE.width * BLUE_NOISE.height * BLUE_NOISE.slices

export interface CloudJitterDeps {
  /** `trace.jitter` says which draw a frame takes; `trace.phase` is the interleave's. */
  readonly uniforms: CloudUniforms
}

/** The jitter as the field holds it: its nodes, and the mask it uploads to draw them. */
export interface CloudJitter extends CloudResource, CloudJitterNodes {
  /**
   * Four numbers in [0, 1) for a trace texel on a frame, by the draw
   * `trace.jitter` selects: `.x` the first step's share, `.yz` the point
   * inside the texel's history pixel (less ½, the offset `traceScreen`
   * takes), `.w` the handover's ξ.
   *
   * Under `'ign'` `.x` and `.yz` are bit for bit what the trace draws today,
   * `at(texel).x` and `at(2·texel + phase).xy`, so a trace that reads this
   * draws phase 0's picture under the default lever. Under `'stbn'` all four
   * are the mask's, at `MASK_READS` in the slice of the pixel's sample count.
   *
   * The first call builds the mask and its node, and from then on the
   * module holds the mask's bytes: a module whose draw no graph reads
   * uploads nothing.
   */
  draw(texel: Node<'uvec2'>, frame: Node<'uint'>): Node<'vec4'>
}

/**
 * The jitter every trace of a field draws with. `at` is interleaved gradient
 * noise whatever `trace.jitter` holds; `draw` is the lever's, with the mask
 * bound and the choice a branch on the uniform (§4.5).
 */
export function createCloudJitter(deps: CloudJitterDeps): CloudJitter {
  const { trace } = deps.uniforms
  let map: Data3DTexture | null = null
  let node: TextureNode | null = null
  let disposed = false

  // One node over one texture: two nodes over it would compile to one
  // binding (rule 57).
  const mask = (): TextureNode => {
    if (node !== null) return node
    map = new Data3DTexture(
      blueNoiseTexels(),
      BLUE_NOISE.width,
      BLUE_NOISE.height,
      BLUE_NOISE.slices,
    )
    map.name = 'cloud blue noise'
    map.format = RedFormat
    map.type = UnsignedByteType
    // Nearest, so the builder reads it by `textureLoad` and binds no sampler.
    map.magFilter = NearestFilter
    map.minFilter = NearestFilter
    map.generateMipmaps = false
    map.needsUpdate = true
    node = texture3D(map)
    return node
  }

  /** A texel's byte b as (b + ½)/256: the unorm read is b/255, which reaches 1. */
  const read = (at: Node<'uvec2'>, slice: Node<'uint'>): Node<'float'> => {
    const wrapped = at.mod(uvec2(BLUE_NOISE.width, BLUE_NOISE.height))
    const texel = ivec3(int(wrapped.x), int(wrapped.y), int(slice))
    return mask()
      .load(texel)
      .x.mul(255)
      .round()
      .add(0.5)
      .mul(1 / 256)
  }

  return {
    name: 'jitter',
    get bytes(): number {
      return map === null || disposed ? 0 : MASK_BYTES
    },
    pending: false,
    at: traceJitter,
    draw(texel, frame) {
      const phase = uvec2(trace.phase)
      const pixel = texel.mul(uint(2)).add(phase)
      const gradientDraw = vec4(
        traceJitter(texel, frame).x,
        traceJitter(pixel, frame),
        gradientThird(texel, frame),
      )
      const slice = sliceOf(frame)
      const from = texel.add(phase.mul(uint(PHASE_STRIDE)))
      const [x, y, z, w] = MASK_READS.map(([dx, dy]) =>
        read(from.add(uvec2(dx, dy)), slice),
      )
      const maskDraw = vec4(x!, y!, z!, w!)
      return select(trace.jitter.equal(uint(STBN)), maskDraw, gradientDraw)
    },
    textures: (): readonly Texture[] => (map === null || disposed ? [] : [map]),
    warm: (_renderer: WebGPURenderer): Promise<void> => Promise.resolve(),
    render: (): void => {},
    dispose: (): void => {
      disposed = true
      map?.dispose()
    },
  }
}
