import {
  Data3DTexture,
  DataArrayTexture,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  type Node,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  Storage3DTexture,
  StorageTexture,
  type Texture,
  type TextureNode,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  dot,
  float,
  floatBitsToUint,
  fract,
  int,
  ivec3,
  select,
  texture,
  texture3D,
  uint,
  vec2,
  vec3,
} from 'three/tsl'
import type { CloudFrame } from './cloudFrame.ts'
import type { CloudBodyUniforms } from './cloudUniforms.ts'

/*
 * The shapes every cloud module exchanges, and the helpers they share.
 *
 * The march takes its medium, its sun and its phase as parameters, and every
 * bake takes the medium it bakes from, so a package tests its own module with
 * an analytic medium — a slab, two slabs, a vacuum — built from the sample
 * alone. The stand-ins below bind each real module's textures as 1 × 1
 * textures of the real format and kind beside that analytic medium, so a
 * kernel compiled in a test binds what the real one binds: WebGPU's default
 * device allows 16 sampled and 4 storage textures a stage, the trace sits at
 * 13 of 16 (15 with the volume) and writes 4 of 4, and a count that only
 * integration could see would be a format change after every package had
 * built on the old one.
 */

/** A ray through the shell union, body-fixed, from the eye. */
export interface CloudRay {
  /** Unit, body-fixed. */
  readonly direction: Node<'vec3'>
  /** dot(direction, the eye's up). */
  readonly mu: Node<'float'>
  /** dot(direction, sun): fixed along the ray, the phase's argument. */
  readonly nu: Node<'float'>
  /** t₀, meters. */
  readonly start: Node<'float'>
  /** t₁, meters. */
  readonly end: Node<'float'>
}

export interface CloudSample {
  /** Sample − eye, body-fixed meters (rule 58: never eye + offset). */
  readonly offset: Node<'vec3'>
  /** t. */
  readonly distance: Node<'float'>
  /** Over the datum, from heights (§5.3). */
  readonly altitude: Node<'float'>
  /** The sun's cosine over the sample's horizontal. */
  readonly sunMu: Node<'float'>
  /** Meters a trace texel spans at t. */
  readonly footprint: Node<'float'>
}

export interface CloudMedium {
  /** The cloudy share of the column the sample stands for; 1 when resolved. */
  readonly fraction: Node<'float'>
  /** In-cloud extinction, 1/m. */
  readonly sigma: Node<'float'>
  /** −1 outside every layer. */
  readonly layer: Node<'int'>
  /** Horizontal meters one segment may span here. */
  readonly column: Node<'float'>
  /** Effective radius, µm. */
  readonly radius: Node<'float'>
}

export type CloudMediumFn = (
  sample: CloudSample,
  body: CloudBodyUniforms,
) => CloudMedium

export interface CloudSun {
  /** The cloud's transmittance to the sun. */
  readonly cloud: Node<'float'>
  /** `sunThroughAt`: the beam through the air. */
  readonly air: Node<'vec3'>
}

export type CloudSunFn = (
  sample: CloudSample,
  medium: CloudMedium,
  body: CloudBodyUniforms,
) => CloudSun

export interface CloudSunDepthNodes {
  /** Optical depth from an eye-relative body-fixed point to the sun. */
  opticalDepth(offset: Node<'vec3'>): Node<'float'>
}

export interface CloudPhaseNodes {
  /** Droplet phase per band, sr⁻¹, at cos θ = nu, for an effective radius in µm. */
  droplets(nu: Node<'float'>, radius: Node<'float'>): Node<'vec3'>
}

export interface CloudFarResult {
  /** L_c over [from, end], relative to `from`. */
  readonly light: Node<'vec3'>
  /** B over [from, end], with the class's beam (§5.11), against the far march's own cloud alone. */
  readonly air: Node<'vec3'>
  /**
   * L_a over [from, end], relative to `from`, with the class's beam: the air
   * light the march samples whatever cloud is in front of it. What lets the
   * caller hide it behind the cloud the fine march already crossed, which
   * `air`, taken from `from` on, cannot see.
   */
  readonly airLight: Node<'vec3'>
  readonly transmittance: Node<'float'>
  /** Meters. */
  readonly depthMean: Node<'float'>
  readonly depthDeviation: Node<'float'>
}

export type CloudFarFn = (
  ray: CloudRay,
  from: Node<'float'>,
  body: CloudBodyUniforms,
  /** The texel's class: the beam B is accumulated with. */
  sky: Node<'bool'>,
) => CloudFarResult

/** What a frame allows a progressive resource to do, and why it must do more. */
export interface CloudBudget {
  readonly slices: number
  readonly tiles: number
  readonly jump: boolean
  /** Texel-steps a sun-depth candidate may spend this frame: one cap for both (§3.12). */
  readonly sunTexelSteps: number
}

/**
 * The shape every cloud GPU module has. A module allocates at its real size
 * only when the levers select it; before that it holds 1 × 1 targets of the
 * real format, so warming builds the real pipelines — a pipeline depends on
 * the format, not the size — and `bytes` counts only what it holds.
 */
export interface CloudResource {
  /** 'maps', 'clipmap', 'volume', …; the report's key. */
  readonly name: string
  /** Declared bytes of what it holds now, from dimensions × texel size × levels; 0 once disposed (rule 65). */
  readonly bytes: number
  /** Every GPU texture it holds now: the census's and the mip test's subject. */
  textures(): readonly Texture[]
  /** Work due at this frame's state that it has not done: a face, a level, a slice, a tile. */
  readonly pending: boolean
  /** Compile every pipeline it will ever draw with, through render/warmup.ts (rule 61). Idempotent. */
  warm(renderer: WebGPURenderer): Promise<void>
  /** Draw this frame's share: quads through `runQuadPasses` with constant labels, kernels named. */
  render(renderer: WebGPURenderer, frame: CloudFrame, budget: CloudBudget): void
  dispose(): void
}

/* ------------------------------------------------------------------------- */
/* Jitter and the NaN guard                                                   */
/* ------------------------------------------------------------------------- */

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
 * transposed pixel with a step of its own. Standing in for spatiotemporal
 * blue noise behind one function; the cost is one hash a ray either way.
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

/** A float32's exponent field: all ones is an infinity or a NaN. */
const EXPONENT = 0x7f800000

/**
 * `x` where every component is finite, else `fallback`: an exponent test
 * through a bitcast, because WGSL has no `isnan` and a compiler may fold
 * `x != x` away as always false. A single NaN in a history blacks out the
 * frame, and the stationary path copies history verbatim.
 */
export function finiteOr(
  x: Node<'vec4'>,
  fallback: Node<'vec4'>,
): Node<'vec4'> {
  const nonFinite = (component: Node<'float'>): Node<'bool'> =>
    // `@types/three` declares no operators on a bitcast; the node is a u32.
    (floatBitsToUint(component) as unknown as Node<'uint'>)
      .bitAnd(uint(EXPONENT))
      .equal(uint(EXPONENT))
  return select(
    nonFinite(x.x).or(nonFinite(x.y), nonFinite(x.z), nonFinite(x.w)),
    fallback,
    x,
  )
}

/* ------------------------------------------------------------------------- */
/* Storage textures                                                           */
/* ------------------------------------------------------------------------- */

/*
 * One level, always. Left at three's defaults a `StorageTexture` is allocated
 * with its whole chain — nine or ten levels — and the next sampled binding
 * after each compute write regenerates that chain with raw render passes the
 * pass timeline cannot name while `ir.gpu` counts them: about forty a frame
 * across the trace and the history, biasing the very figures the clouds are
 * measured by, and the declared bytes a third short. A `Storage3DTexture`
 * allocates its chain and nothing fills it. `generateMipmaps` off is all
 * either needs: three allocates a chain, and regenerates one after a store,
 * only where `Textures.needsMipmaps` holds, so a `StorageTexture`'s own
 * `mipmapsAutoUpdate` is left as it comes. Every storage texture the cloud
 * system holds is made here.
 */

/** A 2D storage texture with one level, which no compute write regenerates a chain behind. */
export function cloudStorageTexture(
  width: number,
  height: number,
  format: 'rgba16float' | 'rgba8unorm',
  name: string,
): StorageTexture {
  const storage = new StorageTexture(width, height)
  storage.format = RGBAFormat
  storage.type = format === 'rgba16float' ? HalfFloatType : UnsignedByteType
  storage.generateMipmaps = false
  storage.name = name
  return storage
}

const STORAGE_3D_TYPES = { rgba8unorm: UnsignedByteType } as const

/** The same for a 3D storage texture: RGBA8, the one 3D storage format core WebGPU writes. */
export function cloudStorage3DTexture(
  width: number,
  height: number,
  depth: number,
  format: 'rgba8unorm',
  name: string,
): Storage3DTexture {
  const storage = new Storage3DTexture(width, height, depth)
  storage.format = RGBAFormat
  storage.type = STORAGE_3D_TYPES[format]
  storage.generateMipmaps = false
  storage.name = name
  return storage
}

/* ------------------------------------------------------------------------- */
/* Analytic media                                                             */
/* ------------------------------------------------------------------------- */

type Scalar = number | Node<'float'>

const scalar = (value: Scalar): Node<'float'> =>
  typeof value === 'number' ? float(value) : value

/** A slab with no horizontal edge: one segment crosses it whole. */
const UNBOUNDED_COLUMN = 1e9

/**
 * A layer of constant cloud between two heights over the datum, meters: the
 * analytic medium a module's tests drive it with. A number is a constant of
 * the program; a uniform node lets a test move the slab without a rebuild.
 */
export interface CloudSlab {
  readonly base: Scalar
  readonly top: Scalar
  /** 1/m. */
  readonly sigma: Scalar
  /** The cloudy share of a column, 1 by default: a resolved slab. */
  readonly fraction?: Scalar
  /** µm, 10 by default. */
  readonly radius?: Scalar
  /** Horizontal meters a segment may span, unbounded by default. */
  readonly column?: Scalar
}

/**
 * Slabs by altitude, the first that holds the sample winning, each its own
 * layer by its index; a vacuum outside every slab. Built from the sample
 * alone, so it reads no texture.
 */
export function slabMedium(slabs: readonly CloudSlab[]): CloudMediumFn {
  return (sample) => {
    const h = sample.altitude
    let sigma: Node<'float'> = float(0)
    let fraction: Node<'float'> = float(0)
    let layer: Node<'int'> = int(-1)
    let radius: Node<'float'> = float(10)
    let column: Node<'float'> = float(UNBOUNDED_COLUMN)
    // Last to first, so the first slab holding the sample is the last select.
    for (let k = slabs.length - 1; k >= 0; k -= 1) {
      const slab = slabs[k]!
      const inside = h
        .greaterThanEqual(scalar(slab.base))
        .and(h.lessThan(scalar(slab.top)))
      sigma = select(inside, scalar(slab.sigma), sigma)
      fraction = select(inside, scalar(slab.fraction ?? 1), fraction)
      layer = select(inside, int(k), layer)
      radius = select(inside, scalar(slab.radius ?? 10), radius)
      column = select(inside, scalar(slab.column ?? UNBOUNDED_COLUMN), column)
    }
    return { sigma, fraction, layer, radius, column }
  }
}

/** No cloud anywhere. */
export const CLOUD_VACUUM: CloudMediumFn = /*@__PURE__*/ slabMedium([])

/* ------------------------------------------------------------------------- */
/* Stand-ins                                                                  */
/* ------------------------------------------------------------------------- */

/*
 * Each stand-in is a fresh 1 × 1 texture per call, filtered like the map it
 * stands in for (rule 56: a nearest `DataTexture` compiles `textureLoad` with
 * no sampler, a different program from the linear one it stands in for), and
 * its node is built once and read through `.sample()`, so its reads share one
 * binding and no two stand-ins ever share an object (rule 57). Every read
 * names level 0, so a stand-in compiles in a fragment's non-uniform control
 * flow as it does in compute.
 */

export type CloudStandInKind = '2d' | '2d-array' | '3d'
export type CloudStandInFormat = 'r8' | 'rg8' | 'rgba8' | 'r16f' | 'rgba16f'

const FORMATS = {
  r8: { channels: 1, format: RedFormat, type: UnsignedByteType },
  rg8: { channels: 2, format: RGFormat, type: UnsignedByteType },
  rgba8: { channels: 4, format: RGBAFormat, type: UnsignedByteType },
  r16f: { channels: 1, format: RedFormat, type: HalfFloatType },
  rgba16f: { channels: 4, format: RGBAFormat, type: HalfFloatType },
} as const

/**
 * A 1 × 1 texture of a cloud map's kind and format, every texel `value`
 * (normalized for the byte formats), filtered linearly as every cloud map
 * is: what a stand-in binds, and what a module reads before it allocates.
 * A 2D array holds `layers` layers.
 */
export function cloudStandInTexture(
  kind: CloudStandInKind,
  format: CloudStandInFormat,
  options: { readonly layers?: number; readonly value?: number } = {},
): Texture {
  const { channels, format: layout, type } = FORMATS[format]
  const layers = kind === '2d-array' ? (options.layers ?? 1) : 1
  const value = options.value ?? 0
  const count = channels * layers
  const data =
    type === HalfFloatType
      ? new Uint16Array(count).fill(DataUtils.toHalfFloat(value))
      : new Uint8Array(count).fill(Math.round(value * 255))
  const map =
    kind === '2d'
      ? new DataTexture(data, 1, 1, layout, type)
      : kind === '2d-array'
        ? new DataArrayTexture(data, 1, 1, layers)
        : new Data3DTexture(data, 1, 1, 1)
  map.format = layout
  map.type = type
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.generateMipmaps = false
  if (kind !== '2d') {
    map.wrapS = RepeatWrapping
    map.wrapT = RepeatWrapping
  }
  if (map instanceof Data3DTexture) map.wrapR = RepeatWrapping
  map.needsUpdate = true
  return map
}

const ISOTROPIC = 1 / (4 * Math.PI)
const CENTER2 = /*@__PURE__*/ vec2(0.5)
const CENTER3 = /*@__PURE__*/ vec3(0.5)
const LEVEL0 = /*@__PURE__*/ float(0)

/**
 * A stand-in's read at level 0, times nothing: a binding kept in the program
 * that adds nothing to the value it is added to.
 */
export function cloudStandInBinding(
  map: TextureNode,
  kind: CloudStandInKind,
): Node<'float'> {
  const read =
    kind === '3d'
      ? map.sample(CENTER3).level(LEVEL0)
      : kind === '2d-array'
        ? map.sample(CENTER2).depth(int(0)).level(LEVEL0)
        : map.sample(CENTER2).level(LEVEL0)
  return read.x.mul(0)
}

/** Reads that must stay in the program and add nothing to the value. */
function nothing(reads: readonly Node<'float'>[]): Node<'float'> {
  return reads.reduce<Node<'float'>>((sum, read) => sum.add(read), float(0))
}

function withReads(medium: CloudMedium, reads: Node<'float'>): CloudMedium {
  return { ...medium, sigma: medium.sigma.add(reads) }
}

/**
 * Stand-in node sets for a package's own tests and for the contracts' stubs,
 * each binding 1 × 1 textures in its real module's number and kind (§3.7):
 *
 * - `field`: the clipmap's textures 0–2 (2D arrays), the base and detail
 *   noises (3D), the curl and the profile (2D): 7;
 * - `volume`: the volume and its bound (3D): 2;
 * - `sunDepth`: the cascades (a 2D array) or the grid (3D): 1;
 * - `phase`: the Mie table (2D): 1;
 * - `far`: its atlas (2D): 1.
 *
 * A medium passed in is what the stand-in draws; its reads add nothing to it.
 */
export const CLOUD_STAND_INS = {
  field(medium: CloudMediumFn = CLOUD_VACUUM): CloudMediumFn {
    const layered = (): TextureNode =>
      texture(cloudStandInTexture('2d-array', 'rgba8', { layers: 6 }))
    const clipmap = [layered(), layered(), layered()]
    const base = texture3D(cloudStandInTexture('3d', 'r8'))
    const detail = texture3D(cloudStandInTexture('3d', 'r8'))
    const curl = texture(cloudStandInTexture('2d', 'rg8'))
    const profile = texture(cloudStandInTexture('2d', 'rgba8'))
    return (sample, body) =>
      withReads(
        medium(sample, body),
        nothing([
          ...clipmap.map((map) => cloudStandInBinding(map, '2d-array')),
          cloudStandInBinding(base, '3d'),
          cloudStandInBinding(detail, '3d'),
          cloudStandInBinding(curl, '2d'),
          cloudStandInBinding(profile, '2d'),
        ]),
      )
  },

  volume(medium: CloudMediumFn = CLOUD_VACUUM): {
    readonly medium: CloudMediumFn
    readonly bound: (s: CloudSample, b: CloudBodyUniforms) => Node<'float'>
    readonly brickExit: (
      s: CloudSample,
      r: CloudRay,
      b: CloudBodyUniforms,
    ) => Node<'float'>
  } {
    const cache = texture3D(cloudStandInTexture('3d', 'rg8'))
    const bound = texture3D(cloudStandInTexture('3d', 'rgba8'))
    return {
      medium: (sample, body) =>
        withReads(medium(sample, body), cloudStandInBinding(cache, '3d')),
      // Never zero: no brick is skipped, so the medium is read every step. A
      // brick's bound is a texel load, as its brick index is an integer.
      bound: () => float(1).add(bound.load(ivec3(0, 0, 0)).x.mul(0)),
      // A step past the sample, the least a skip advances.
      brickExit: (sample) => sample.distance.add(0.5),
    }
  },

  sunDepth(kind: 'cascades' | 'grid'): CloudSunDepthNodes {
    const map =
      kind === 'cascades'
        ? texture(cloudStandInTexture('2d-array', 'rgba16f', { layers: 3 }))
        : texture3D(cloudStandInTexture('3d', 'r16f'))
    const shape = kind === 'cascades' ? '2d-array' : '3d'
    return { opticalDepth: () => cloudStandInBinding(map, shape) }
  },

  /** An isotropic phase, `value` sr⁻¹ in every band; 1/(4π) is normalized. */
  phase(value: Scalar = ISOTROPIC): CloudPhaseNodes {
    const table = texture(
      cloudStandInTexture('2d', 'rgba16f', { value: ISOTROPIC }),
    )
    return {
      droplets: () => vec3(scalar(value).add(cloudStandInBinding(table, '2d'))),
    }
  },

  /** A far field that holds nothing: clear, unlit, its depth where it began. */
  far(): CloudFarFn {
    const atlas = texture(cloudStandInTexture('2d', 'rgba8'))
    return (_ray, from) => ({
      light: vec3(cloudStandInBinding(atlas, '2d')),
      air: vec3(0),
      airLight: vec3(0),
      transmittance: float(1),
      depthMean: from,
      depthDeviation: float(0),
    })
  },
}
