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
  StorageTexture,
  type Texture,
  type TextureNode,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  exp,
  float,
  floatBitsToUint,
  int,
  ivec3,
  max,
  min,
  select,
  texture,
  texture3D,
  uint,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { sunThroughAt } from './air.ts'
import type { CloudFrame } from './cloudFrame.ts'
import type { CloudBodyUniforms, CloudLayerUniforms } from './cloudUniforms.ts'

/*
 * The shapes every cloud module exchanges, and the helpers they share.
 *
 * The march takes its medium, its sun and its phase as parameters, and every
 * bake takes the medium it bakes from, so a package tests its own module with
 * an analytic medium — a slab, two slabs, a vacuum — built from the sample
 * alone. The stand-ins below bind each real module's textures as 1 × 1
 * textures of the real format and kind beside that analytic medium, so a
 * kernel compiled in a test binds what the real one binds: WebGPU's default
 * device allows 16 sampled and 4 storage textures a stage, the system's
 * trace binds 10 of the 16 and writes 4 of 4
 * (`cloudTrace.gpu.test.ts` counts it), and a count that only integration
 * could see would be a format change after every package had built on the
 * old one.
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
  /** In-cloud extinction, 1/m: what every transmittance is formed from. */
  readonly sigma: Node<'float'>
  /** −1 outside every layer. */
  readonly layer: Node<'int'>
  /** Horizontal meters one segment may span here. */
  readonly column: Node<'float'>
  /** Effective radius at the sample, µm. */
  readonly radius: Node<'float'>
  /**
   * In-cloud optical depth of the level's column above the sample, and of
   * the whole column: what the sky's two sides and the layers' own
   * statistics are weighed by. Zero outside every level.
   */
  readonly depth: Node<'vec2'>
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
  /** Optical depth through cloud toward the sun, and the whole of that ray's. */
  readonly depth: Node<'vec2'>
  /** The cloud's transmittance to the sun with its depth scaled by `a`. */
  octave(a: number): Node<'float'>
}

export type CloudSunFn = (
  sample: CloudSample,
  medium: CloudMedium,
  body: CloudBodyUniforms,
) => CloudSun

/** What the sun's cache holds of a point: two depths toward the sun, and how far to trust them. */
export interface CloudSunDepths {
  /** Optical depth through cloud from the point to the sun. */
  readonly toSun: Node<'float'>
  /** The whole of that ray's, from where it enters the cloud to where it leaves. */
  readonly whole: Node<'float'>
  /**
   * The cache's weight at the point, 0..1: how far `toSun` and `whole`
   * replace the layers' own statistics. Zero where the cache holds nothing
   * of the point.
   */
  readonly weight: Node<'float'>
  /**
   * The cache's share of the depth behind the point, 0..1: `whole` is
   * `toSun` plus this share of what lies between the point and the ray's far
   * end. One where the cache holds the whole ray; it falls to zero as the far
   * end leaves the cache's reach while the point stays inside it, and there
   * the part behind is the statistics' to give.
   */
  readonly behind: Node<'float'>
}

export interface CloudSunDepthNodes {
  /** The sun's depths at an eye-relative body-fixed point. */
  depths(offset: Node<'vec3'>): CloudSunDepths
}

export interface CloudPhaseNodes {
  /** Droplet phase per band, sr⁻¹, at cos θ = nu, for an effective radius in µm. */
  droplets(nu: Node<'float'>, radius: Node<'float'>): Node<'vec3'>
  /**
   * First-order phase per band, sr⁻¹, in rgb, and the row's gain,
   * 1/(1 − f_δ), in a, at cos θ = nu, for a level's class at an effective
   * radius, µm.
   */
  phase(
    nu: Node<'float'>,
    layers: CloudLayerUniforms,
    level: number,
    radius: Node<'float'>,
  ): Node<'vec4'>
}

export interface CloudSkyNodes {
  /**
   * The sky's light at a sample: its mean radiance per band, and the
   * difference of its two sides' irradiance over π times that mean, up
   * against down and sunward against away.
   */
  at(
    sample: CloudSample,
    body: CloudBodyUniforms,
  ): {
    readonly mean: Node<'vec3'>
    readonly up: Node<'vec3'>
    readonly sunward: Node<'vec3'>
  }
}

export interface CloudSourceNodes {
  /**
   * The higher orders' source, (J₀, J₁, J_f) per unit of the sun's
   * irradiance, from a sample's transport depths to its two faces and the
   * sun's cosine.
   */
  source(depth: Node<'vec2'>, sunMu: Node<'float'>): Node<'vec3'>
}

export interface CloudJitterNodes {
  /**
   * Two numbers in [0, 1) for a pixel on a frame: `.x` places the first
   * step along the ray, and `.y`'s pair less ½ is the sampling point inside
   * a pixel.
   */
  at(pixel: Node<'uvec2'>, frame: Node<'uint'>): Node<'vec2'>
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
  /** Slices of the sun grid this frame may bake. */
  readonly sunSlices: number
}

/**
 * The shape every cloud GPU module has. A module allocates at its real size
 * when a frame first draws it; before that it holds 1 × 1 targets of the
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
/* The NaN guard                                                              */
/* ------------------------------------------------------------------------- */

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
 * measured by, and the declared bytes a third short. `generateMipmaps` off
 * is all it needs: three allocates a chain, and regenerates one after a
 * store, only where `Textures.needsMipmaps` holds, so a `StorageTexture`'s
 * own `mipmapsAutoUpdate` is left as it comes. Every storage texture the cloud
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

/* ------------------------------------------------------------------------- */
/* Analytic media                                                             */
/* ------------------------------------------------------------------------- */

type Scalar = number | Node<'float'>

const scalar = (value: Scalar): Node<'float'> =>
  typeof value === 'number' ? float(value) : value

/** A slab with no horizontal edge: one segment crosses it whole. */
const UNBOUNDED_COLUMN = 1e9
/** µm where a slab names no radius, and outside every slab. */
const SLAB_RADIUS = 10

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
  /**
   * µm, 10 by default: one radius, or the radius at an altitude over the
   * datum, meters, for a slab whose droplets grow through it.
   */
  readonly radius?: Scalar | ((altitude: Node<'float'>) => Node<'float'>)
  /** Horizontal meters a segment may span, unbounded by default. */
  readonly column?: Scalar
}

const slabRadius = (slab: CloudSlab, altitude: Node<'float'>): Node<'float'> =>
  typeof slab.radius === 'function'
    ? slab.radius(altitude)
    : scalar(slab.radius ?? SLAB_RADIUS)

/**
 * Slabs by altitude, the first that holds the sample winning, each its own
 * layer by its index; a vacuum outside every slab. Built from the sample
 * alone, so it reads no texture. A slab's depths are its own: σ times the
 * height from the sample to its top, and times its whole thickness.
 */
export function slabMedium(slabs: readonly CloudSlab[]): CloudMediumFn {
  return (sample) => {
    const h = sample.altitude
    let sigma: Node<'float'> = float(0)
    let fraction: Node<'float'> = float(0)
    let layer: Node<'int'> = int(-1)
    let radius: Node<'float'> = float(SLAB_RADIUS)
    let column: Node<'float'> = float(UNBOUNDED_COLUMN)
    let depth: Node<'vec2'> = vec2(0)
    // Last to first, so the first slab holding the sample is the last select.
    for (let k = slabs.length - 1; k >= 0; k -= 1) {
      const slab = slabs[k]!
      const base = scalar(slab.base)
      const top = scalar(slab.top)
      const inside = h.greaterThanEqual(base).and(h.lessThan(top))
      sigma = select(inside, scalar(slab.sigma), sigma)
      fraction = select(inside, scalar(slab.fraction ?? 1), fraction)
      layer = select(inside, int(k), layer)
      radius = select(inside, slabRadius(slab, h), radius)
      column = select(inside, scalar(slab.column ?? UNBOUNDED_COLUMN), column)
      depth = select(
        inside,
        vec2(top.sub(h), top.sub(base)).mul(scalar(slab.sigma)),
        depth,
      )
    }
    return { sigma, fraction, layer, radius, column, depth }
  }
}

/** The least a sun's cosine is taken as: a slab's path under a grazing sun stays finite. */
const GRAZING = 1e-3

/**
 * The sun a sample in plane slabs sees, exactly: the slabs' own depth along
 * the sun, with no cache and no tap between the sample and it. A sun over
 * the sample's horizon comes down through what stands above the sample, and
 * one under it up through what lies below. Each slab is one column, so a
 * half-clear slab passes half the sun however deep it is.
 *
 * What a gate runs beside the shipped `cloudSunFn`, so a figure can be told
 * the march's from the sun's cache's.
 */
export function exactSlabSun(slabs: readonly CloudSlab[]): CloudSunFn {
  return (sample, _medium, body) => {
    const h = sample.altitude
    const above = sample.sunMu.greaterThanEqual(0)
    const slant = float(1).div(max(abs(sample.sunMu), GRAZING))
    let toSun: Node<'float'> = float(0)
    let whole: Node<'float'> = float(0)
    let through: Node<'float'> = float(1)
    for (const slab of slabs) {
      const base = scalar(slab.base)
      const top = scalar(slab.top)
      const sigma = scalar(slab.sigma)
      // The slab's thickness on the sun's side of the sample, and all of it.
      const over = max(top.sub(max(h, base)), 0)
      const under = max(min(h, top).sub(base), 0)
      const depth = sigma.mul(select(above, over, under)).mul(slant)
      const share = scalar(slab.fraction ?? 1)
      toSun = toSun.add(depth)
      // The line through the sample crosses every slab, whichever side of
      // the sample it stands on.
      whole = whole.add(sigma.mul(top.sub(base)).mul(slant))
      through = through.mul(
        float(1)
          .sub(share)
          .add(share.mul(exp(depth.negate()))),
      )
    }
    // The air's height, true meters: its top is in sea-level units.
    const airHeight = body.datumRadius.mul(max(body.air.top.sub(1), 1e-6))
    return {
      cloud: through,
      air: sunThroughAt(
        body.air,
        sample.altitude.div(airHeight),
        sample.sunMu,
        body.cleared,
        { level: true },
      ),
      depth: vec2(toSun, whole),
      octave: (a) => exp(toSun.mul(-a)),
    }
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
 * each binding 1 × 1 textures in its real module's number and kind:
 *
 * - `field`: the clipmap's cover and kind (2D arrays), the base and detail
 *   noises (3D) and the profile (2D): 5;
 * - `volume`: the volume (3D): 1;
 * - `sunDepth`: the sun grid (3D): 1;
 * - `phase`: the phase atlas (2D): 1;
 * - `far`: its atlas (2D): 1;
 * - `sky`: the sky table (2D): 1;
 * - `source`: the slab source table (3D): 1;
 * - `jitter`: the blue-noise mask (3D): 1.
 *
 * A medium passed in is what the stand-in draws; its reads add nothing to it.
 */
export const CLOUD_STAND_INS = {
  field(medium: CloudMediumFn = CLOUD_VACUUM): CloudMediumFn {
    const layered = (): TextureNode =>
      texture(cloudStandInTexture('2d-array', 'rgba8', { layers: 6 }))
    const clipmap = [layered(), layered()]
    const base = texture3D(cloudStandInTexture('3d', 'r8'))
    const detail = texture3D(cloudStandInTexture('3d', 'r8'))
    const profile = texture(cloudStandInTexture('2d', 'rgba8'))
    return (sample, body) =>
      withReads(
        medium(sample, body),
        nothing([
          ...clipmap.map((map) => cloudStandInBinding(map, '2d-array')),
          cloudStandInBinding(base, '3d'),
          cloudStandInBinding(detail, '3d'),
          cloudStandInBinding(profile, '2d'),
        ]),
      )
  },

  volume(medium: CloudMediumFn = CLOUD_VACUUM): CloudMediumFn {
    const cache = texture3D(cloudStandInTexture('3d', 'rg8'))
    return (sample, body) =>
      withReads(medium(sample, body), cloudStandInBinding(cache, '3d'))
  },

  /** A sun's cache that holds no depth anywhere, at full weight: no cloud toward the sun. */
  sunDepth(): CloudSunDepthNodes {
    const map = texture3D(cloudStandInTexture('3d', 'r16f'))
    return {
      depths: () => {
        const none = cloudStandInBinding(map, '3d')
        return { toSun: none, whole: none, weight: float(1), behind: float(1) }
      },
    }
  },

  /**
   * An isotropic phase, `value` sr⁻¹ in every band, at a gain of `gain`;
   * 1/(4π) is normalized, and a gain of one is a medium with no diffraction
   * taken out of it.
   */
  phase(value: Scalar = ISOTROPIC, gain: Scalar = 1): CloudPhaseNodes {
    const table = texture(
      cloudStandInTexture('2d', 'rgba16f', { value: ISOTROPIC }),
    )
    const droplets = (): Node<'vec3'> =>
      vec3(scalar(value).add(cloudStandInBinding(table, '2d')))
    return {
      droplets,
      phase: () => vec4(droplets(), scalar(gain)),
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

  /** A sky of `mean` radiance in every band, alike on every side. */
  sky(mean: Scalar = 0): CloudSkyNodes {
    const table = texture(cloudStandInTexture('2d', 'rgba16f'))
    return {
      at: () => ({
        mean: vec3(scalar(mean).add(cloudStandInBinding(table, '2d'))),
        up: vec3(0),
        sunward: vec3(0),
      }),
    }
  },

  /** A source of `isotropic` in its first term and nothing in its other two. */
  source(isotropic: Scalar = 0): CloudSourceNodes {
    const table = texture3D(cloudStandInTexture('3d', 'rgba16f'))
    return {
      source: () =>
        vec3(scalar(isotropic).add(cloudStandInBinding(table, '3d')), 0, 0),
    }
  },

  /**
   * One draw for every pixel and frame: `value` in both numbers, ½ by
   * default. The mask is read as the real one is, by `textureLoad` from a
   * nearest texture, which binds no sampler.
   */
  jitter(value: Scalar = 0.5): CloudJitterNodes {
    const map = new Data3DTexture(new Uint8Array(1), 1, 1, 1)
    map.format = RedFormat
    map.type = UnsignedByteType
    map.generateMipmaps = false
    map.needsUpdate = true
    const mask = texture3D(map)
    return {
      at: () => vec2(scalar(value).add(mask.load(ivec3(0, 0, 0)).x.mul(0))),
    }
  },
}
