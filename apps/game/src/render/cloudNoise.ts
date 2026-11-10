import { getLogger } from '@inertialref/shared'
import {
  type Data3DTexture,
  LinearFilter,
  type Node,
  NodeMaterial,
  QuadMesh,
  RedFormat,
  RenderTarget,
  RenderTarget3D,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  type Texture,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  screenCoordinate,
  texture,
  texture3D,
  uniform,
  vec3,
  vec4,
  wgslFn,
} from 'three/tsl'
import {
  BASE_NOISE_PERIOD,
  BASE_NOISE_SPREAD,
  CURL_GAIN,
  CURL_REACH,
  DETAIL_NOISE_PERIOD,
  NOISE_LANES,
} from '@inertialref/rendering'
import type { CloudFrame } from './cloudFrame.ts'
import type { CloudBudget, CloudResource } from './cloudNodes.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmSensorPass } from './warmup.ts'

/*
 * The noises the field reads every step: a tiling Perlin–Worley base shape, a
 * Worley detail and a 2D curl, baked once into one-level targets and read at
 * level 0. Held texel by texel to `weatherNoise.ts`, which every WGSL
 * function below ports line for line, in the same order of operations.
 *
 * **Fragment slices, not compute.** Each 3D noise is a `RenderTarget3D` drawn
 * one quad a slice: an `r8unorm` render attachment is core WebGPU, where an
 * `r8unorm` storage texture needs `texture-formats-tier1` (§3.8). A target's
 * textures have one level by default, so nothing allocates a chain the bake
 * never fills.
 *
 * **The sweep's RGBA8 base** (base, then the three Worley octaves) is the same
 * binding as the R8 one: `setFormat` is a value swap between two textures of
 * one binding type, `texture_3d<f32>`, so the program a kernel compiled with
 * either reads the other. It is 8.4 MB against 2.1, so it is held at 1 × 1 × 1
 * until a frame selects it, and baked the first render that does.
 */

const log = getLogger('game.clouds')

/** Perlin–Worley, R8 (and an RGBA8 sweep variant). */
export const CLOUD_BASE_TEXELS = 128
/** Worley cells a period: one cell = 16 texels. */
export const CLOUD_BASE_CELLS = BASE_NOISE_PERIOD
/** Worley, R8, 4 cells a period. */
export const CLOUD_DETAIL_TEXELS = 32
/** 2D curl, RG8. */
export const CLOUD_CURL_TEXELS = 128

/** The bake's pass on the timeline: every slice of every noise. */
export const CLOUD_NOISE_LABEL = 'cloud noise'

export interface CloudNoiseNodes {
  /** The base shape at a point in base-cell units (the period is CLOUD_BASE_CELLS). Level 0. */
  base(cells: Node<'vec3'>): Node<'float'>
  /** The same texel's four channels (base, and three octaves): the sweep's RGBA8 read. */
  baseWide(cells: Node<'vec3'>): Node<'vec4'>
  detail(cells: Node<'vec3'>): Node<'float'>
  curl(uv: Node<'vec2'>): Node<'vec2'>
}

/* ------------------------------------------------------------------------- */
/* The WGSL ports of weatherNoise.ts                                          */
/* ------------------------------------------------------------------------- */

/** The functions a WGSL function calls, as `wgslFn`'s second argument (see `terrainKernel.ts`). */
const uses = (...fns: readonly unknown[]): never[] => fns as never[]
const lane = (value: number): string => `${value >>> 0}u`

/**
 * lattice.ts `pcg4d`: Jarzynski & Olano, in the same lane order. The blob
 * pattern hashes its cells with this too (`cloudMaps.ts`), so it is named
 * apart from the terrain kernel's copy in case one program ever holds both.
 */
export const cloudPcg4d = /*@__PURE__*/ wgslFn(`
  fn cloudPcg4d(x: u32, y: u32, z: u32, w: u32) -> vec4<u32> {
    var v = vec4<u32>(x, y, z, w) * 1664525u + 1013904223u;
    v.x += v.y * v.w;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v.w += v.y * v.z;
    v ^= v >> vec4<u32>(16u);
    v.x += v.y * v.w;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v.w += v.y * v.z;
    return v;
  }
`)

const wrapCode = /*@__PURE__*/ wgslFn(`
  fn cloudWrap(cell: i32, period: i32) -> u32 {
    // weatherNoise.ts \`wrap\`: an integer cell into [0, period).
    return u32(((cell % period) + period) % period);
  }
`)

const fraction24Code = /*@__PURE__*/ wgslFn(`
  fn cloudFraction24(value: u32) -> f32 {
    // weatherNoise.ts \`fraction24\`: exact in f32.
    return f32(value >> 8u) * (1.0 / 16777216.0);
  }
`)

const worleyCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudWorley(p: vec3<f32>, period: i32, lane: u32) -> f32 {
    // weatherNoise.ts \`worley\`.
    let cell = floor(p);
    let f = p - cell;
    let c = vec3<i32>(cell);
    var nearest = 8.0;
    for (var dz = -1; dz <= 1; dz = dz + 1) {
      for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
          let h = cloudPcg4d(
            cloudWrap(c.x + dx, period),
            cloudWrap(c.y + dy, period),
            cloudWrap(c.z + dz, period),
            lane,
          );
          let px = f32(dx) + cloudFraction24(h.x) - f.x;
          let py = f32(dy) + cloudFraction24(h.y) - f.y;
          let pz = f32(dz) + cloudFraction24(h.z) - f.z;
          nearest = min(nearest, px * px + py * py + pz * pz);
        }
      }
    }
    return 1.0 - min(1.0, sqrt(nearest));
  }
`,
  uses(cloudPcg4d, wrapCode, fraction24Code),
)

const fadeCode = /*@__PURE__*/ wgslFn(`
  fn cloudFade(t: f32) -> f32 {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }
`)

const fadeSlopeCode = /*@__PURE__*/ wgslFn(`
  fn cloudFadeSlope(t: f32) -> f32 {
    return 30.0 * t * t * (t * (t - 2.0) + 1.0);
  }
`)

const lerpCode = /*@__PURE__*/ wgslFn(`
  fn cloudLerp(a: f32, b: f32, t: f32) -> f32 {
    // a + (b − a)t, as weatherNoise.ts writes it, not mix's a(1 − t) + bt.
    return a + (b - a) * t;
  }
`)

const gradient3Code = /*@__PURE__*/ wgslFn(`
  fn cloudGradient3(hash: u32, x: f32, y: f32, z: f32) -> f32 {
    // weatherNoise.ts \`gradient3\`: Perlin's improved-noise edge gradients.
    let h = hash & 15u;
    let u = select(y, x, h < 8u);
    let v = select(select(z, x, h == 12u || h == 14u), y, h < 4u);
    return select(-u, u, (h & 1u) == 0u) + select(-v, v, (h & 2u) == 0u);
  }
`)

const cornerCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudCorner(c: vec3<i32>, o: vec3<i32>, f: vec3<f32>, period: i32, lane: u32) -> f32 {
    let h = cloudPcg4d(
      cloudWrap(c.x + o.x, period),
      cloudWrap(c.y + o.y, period),
      cloudWrap(c.z + o.z, period),
      lane,
    ).x;
    return cloudGradient3(h, f.x - f32(o.x), f.y - f32(o.y), f.z - f32(o.z));
  }
`,
  uses(cloudPcg4d, wrapCode, gradient3Code),
)

const perlinCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudPerlin(p: vec3<f32>, period: i32, lane: u32) -> f32 {
    // weatherNoise.ts \`perlin\`.
    let cell = floor(p);
    let f = p - cell;
    let c = vec3<i32>(cell);
    let u = cloudFade(f.x);
    let v = cloudFade(f.y);
    let w = cloudFade(f.z);
    let x00 = cloudLerp(
      cloudCorner(c, vec3<i32>(0, 0, 0), f, period, lane),
      cloudCorner(c, vec3<i32>(1, 0, 0), f, period, lane),
      u,
    );
    let x10 = cloudLerp(
      cloudCorner(c, vec3<i32>(0, 1, 0), f, period, lane),
      cloudCorner(c, vec3<i32>(1, 1, 0), f, period, lane),
      u,
    );
    let x01 = cloudLerp(
      cloudCorner(c, vec3<i32>(0, 0, 1), f, period, lane),
      cloudCorner(c, vec3<i32>(1, 0, 1), f, period, lane),
      u,
    );
    let x11 = cloudLerp(
      cloudCorner(c, vec3<i32>(0, 1, 1), f, period, lane),
      cloudCorner(c, vec3<i32>(1, 1, 1), f, period, lane),
      u,
    );
    return cloudLerp(cloudLerp(x00, x10, v), cloudLerp(x01, x11, v), w);
  }
`,
  uses(fadeCode, lerpCode, cornerCode),
)

const gradient2Code = /*@__PURE__*/ wgslFn(`
  fn cloudGradient2(hash: u32) -> vec2<f32> {
    // weatherNoise.ts \`gradient2\`.
    let h = hash & 7u;
    let sx = select(-1.0, 1.0, (h & 1u) == 0u);
    let sy = select(-1.0, 1.0, (h & 2u) == 0u);
    if (h < 4u) {
      return vec2<f32>(sx, sy);
    }
    if (h < 6u) {
      return vec2<f32>(sx, 0.0);
    }
    return vec2<f32>(0.0, sx);
  }
`)

const perlin2Code = /*@__PURE__*/ wgslFn(
  `
  fn cloudPerlin2(p: vec2<f32>, period: i32, lane: u32) -> vec3<f32> {
    // weatherNoise.ts \`perlin2\`: (value, d/dx, d/dy).
    let cell = floor(p);
    let f = p - cell;
    let c = vec2<i32>(cell);
    let g00 = cloudGradient2(cloudPcg4d(cloudWrap(c.x, period), cloudWrap(c.y, period), 0u, lane).x);
    let g10 = cloudGradient2(cloudPcg4d(cloudWrap(c.x + 1, period), cloudWrap(c.y, period), 0u, lane).x);
    let g01 = cloudGradient2(cloudPcg4d(cloudWrap(c.x, period), cloudWrap(c.y + 1, period), 0u, lane).x);
    let g11 = cloudGradient2(cloudPcg4d(cloudWrap(c.x + 1, period), cloudWrap(c.y + 1, period), 0u, lane).x);
    let v00 = g00.x * f.x + g00.y * f.y;
    let v10 = g10.x * (f.x - 1.0) + g10.y * f.y;
    let v01 = g01.x * f.x + g01.y * (f.y - 1.0);
    let v11 = g11.x * (f.x - 1.0) + g11.y * (f.y - 1.0);
    let ux = cloudFade(f.x);
    let uy = cloudFade(f.y);
    let dux = cloudFadeSlope(f.x);
    let duy = cloudFadeSlope(f.y);
    let k1 = v10 - v00;
    let k2 = v01 - v00;
    let k3 = v00 - v10 - v01 + v11;
    let value = v00 + k1 * ux + k2 * uy + k3 * ux * uy;
    let dx = g00.x + (g10.x - g00.x) * ux + (g01.x - g00.x) * uy
      + (g00.x - g10.x - g01.x + g11.x) * ux * uy + dux * (k1 + k3 * uy);
    let dy = g00.y + (g10.y - g00.y) * ux + (g01.y - g00.y) * uy
      + (g00.y - g10.y - g01.y + g11.y) * ux * uy + duy * (k2 + k3 * ux);
    return vec3<f32>(value, dx, dy);
  }
`,
  uses(cloudPcg4d, wrapCode, gradient2Code, fadeCode, fadeSlopeCode),
)

const curlCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudCurl(uv: vec2<f32>) -> vec2<f32> {
    // weatherNoise.ts \`curlNoise\`.
    let a = cloudPerlin2(uv * 4.0, 4, ${lane(NOISE_LANES.curl[0])});
    let b = cloudPerlin2(uv * 8.0, 8, ${lane(NOISE_LANES.curl[1])});
    let dx = a.y + b.y;
    let dy = a.z + b.z;
    return vec2<f32>(
      clamp(${CURL_GAIN} * dy, -1.0, 1.0),
      clamp(-${CURL_GAIN} * dx, -1.0, 1.0),
    );
  }
`,
  uses(perlin2Code),
)

const [P0, P1, P2] = NOISE_LANES.perlin.map(lane)
const [W0, W1, W2] = NOISE_LANES.worley.map(lane)
const [D0, D1, D2] = NOISE_LANES.detail.map(lane)

const baseCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudBaseNoise(p: vec3<f32>) -> vec4<f32> {
    // weatherNoise.ts \`baseNoiseWide\`.
    let c = cloudCurl(vec2<f32>(p.x / ${BASE_NOISE_PERIOD}.0, p.z / ${BASE_NOISE_PERIOD}.0));
    let q = vec3<f32>(p.x + c.x * ${CURL_REACH}, p.y, p.z + c.y * ${CURL_REACH});
    let billow = (cloudPerlin(q / 2.0, 4, ${P0})
      + 0.5 * cloudPerlin(q, 8, ${P1})
      + 0.25 * cloudPerlin(2.0 * q, 16, ${P2})) / 1.75;
    let perlin01 = clamp(0.5 + 0.5 * billow, 0.0, 1.0);
    let near = cloudWorley(q, 8, ${W0});
    let mid = cloudWorley(2.0 * q, 16, ${W1});
    let far = cloudWorley(4.0 * q, 32, ${W2});
    let fbm = 0.625 * near + 0.25 * mid + 0.125 * far;
    let low = fbm - 1.0;
    let shape = clamp((perlin01 - low) / (1.0 - low), 0.0, 1.0);
    return vec4<f32>(smoothstep(${BASE_NOISE_SPREAD[0]}, ${BASE_NOISE_SPREAD[1]}, shape), near, mid, far);
  }
`,
  uses(curlCode, perlinCode, worleyCode),
)

const detailCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudDetailNoise(p: vec3<f32>) -> f32 {
    // weatherNoise.ts \`detailNoise\`.
    return 0.625 * cloudWorley(p, 4, ${D0})
      + 0.25 * cloudWorley(2.0 * p, 8, ${D1})
      + 0.125 * cloudWorley(4.0 * p, 16, ${D2});
  }
`,
  uses(worleyCode),
)

/* ------------------------------------------------------------------------- */
/* The resource                                                               */
/* ------------------------------------------------------------------------- */

/** A one-level, repeat-wrapped, linearly filtered 3D noise of `size`³ texels. */
function noiseVolume(
  size: number,
  format: typeof RedFormat | typeof RGBAFormat,
): RenderTarget3D {
  const volume = new RenderTarget3D(size, size, size, {
    format,
    type: UnsignedByteType,
    depthBuffer: false,
    // A `Data3DTexture` magnifies with `NearestFilter` unless told otherwise,
    // and a level-0 read is a magnification: the builder then emits a
    // `textureLoad` with no sampler, which is neither the filtered read the
    // field wants nor the program the stand-ins compile.
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
  })
  // On the texture, not in the options: the base constructor applies them
  // to a plain `Texture` first, which has no R axis and warns.
  ;(volume.texture as Data3DTexture).wrapR = RepeatWrapping
  return volume
}

const LEVEL0 = /*@__PURE__*/ float(0)

/** Bytes a texel of each target holds. */
const BASE_BYTES = 1
const WIDE_BYTES = 4
const DETAIL_BYTES = 1
const CURL_BYTES = 2

type Bake = 'base' | 'wide' | 'detail' | 'curl'

export class CloudNoise implements CloudResource {
  readonly name = 'noise'
  readonly nodes: CloudNoiseNodes

  readonly #base = noiseVolume(CLOUD_BASE_TEXELS, RedFormat)
  /** The sweep's RGBA8 base: 1 × 1 × 1 until a frame selects it. */
  readonly #wide = noiseVolume(1, RGBAFormat)
  readonly #detail = noiseVolume(CLOUD_DETAIL_TEXELS, RedFormat)
  readonly #curl = new RenderTarget(CLOUD_CURL_TEXELS, CLOUD_CURL_TEXELS, {
    format: RGFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
  })
  /** The one node both base reads go through, so `setFormat` swaps one binding's value. */
  readonly #baseRead = texture3D(this.#base.texture)
  /** The slice a 3D bake's quad draws, as its texel center. */
  readonly #slice = uniform(0.5)
  readonly #quad = new QuadMesh()
  readonly #materials: Readonly<Record<Bake, NodeMaterial>>
  readonly #baked = new Set<Bake>()
  /** What exists on the GPU: a warm-up or a bake has bound it. */
  readonly #allocated = new Set<Bake>()
  #format: 'r8' | 'rgba8' = 'r8'
  #warm: Promise<void> | null = null
  #disposed = false

  constructor() {
    this.#base.texture.name = 'cloud base noise'
    this.#wide.texture.name = 'cloud base noise, sweep'
    this.#detail.texture.name = 'cloud detail noise'
    this.#curl.texture.name = 'cloud curl'
    const detailRead = texture3D(this.#detail.texture)
    const curlRead = texture(this.#curl.texture)
    const base = this.#baseRead
    this.nodes = {
      base: (cells) => base.sample(cells.div(CLOUD_BASE_CELLS)).level(LEVEL0).x,
      baseWide: (cells) =>
        vec4(base.sample(cells.div(CLOUD_BASE_CELLS)).level(LEVEL0)),
      detail: (cells) =>
        detailRead.sample(cells.div(DETAIL_NOISE_PERIOD)).level(LEVEL0).x,
      curl: (uv) => curlRead.sample(uv).level(LEVEL0).xy.mul(2).sub(1),
    }
    this.#materials = {
      base: this.#bakeMaterial('base', CLOUD_BASE_TEXELS / CLOUD_BASE_CELLS),
      wide: this.#bakeMaterial('wide', CLOUD_BASE_TEXELS / CLOUD_BASE_CELLS),
      detail: this.#bakeMaterial(
        'detail',
        CLOUD_DETAIL_TEXELS / DETAIL_NOISE_PERIOD,
      ),
      curl: this.#bakeMaterial('curl', CLOUD_CURL_TEXELS),
    }
  }

  /**
   * One noise's bake: the fragment's texel center in the noise's own units
   * (base or detail cells, or the curl's unit square), `perUnit` texels a
   * unit. A fragment coordinate is a texel center already, (i + ½, j + ½).
   */
  #bakeMaterial(bake: Bake, perUnit: number): NodeMaterial {
    const material = new NodeMaterial()
    material.name = `cloud noise ${bake}`
    const at = screenCoordinate.xy.div(perUnit)
    if (bake === 'curl') {
      const curl = curlCode({ uv: at }) as unknown as Node<'vec2'>
      material.fragmentNode = vec4(curl.mul(0.5).add(0.5), 0, 1)
      return material
    }
    const p = vec3(at, this.#slice.div(perUnit))
    if (bake === 'detail') {
      const value = detailCode({ p }) as unknown as Node<'float'>
      material.fragmentNode = vec4(value, 0, 0, 1)
      return material
    }
    const wide = baseCode({ p }) as unknown as Node<'vec4'>
    material.fragmentNode = bake === 'wide' ? wide : vec4(wide.x, 0, 0, 1)
    return material
  }

  #target(bake: Bake): RenderTarget {
    return bake === 'base'
      ? this.#base
      : bake === 'wide'
        ? this.#wide
        : bake === 'detail'
          ? this.#detail
          : this.#curl
  }

  /** A value swap between two textures of one binding type; the RGBA8 one reads from the render after it is baked. */
  setFormat(format: 'r8' | 'rgba8'): void {
    this.#format = format
    this.#baseRead.value =
      format === 'rgba8' && this.#baked.has('wide')
        ? this.#wide.texture
        : this.#base.texture
  }

  /** The selected sweep variant, until the render that bakes it. */
  get pending(): boolean {
    return (
      !this.#disposed && this.#format === 'rgba8' && !this.#baked.has('wide')
    )
  }

  get bytes(): number {
    if (this.#disposed) return 0
    let bytes = 0
    if (this.#allocated.has('base'))
      bytes += CLOUD_BASE_TEXELS ** 3 * BASE_BYTES
    if (this.#allocated.has('wide')) bytes += this.#wide.width ** 3 * WIDE_BYTES
    if (this.#allocated.has('detail'))
      bytes += CLOUD_DETAIL_TEXELS ** 3 * DETAIL_BYTES
    if (this.#allocated.has('curl'))
      bytes += CLOUD_CURL_TEXELS ** 2 * CURL_BYTES
    return bytes
  }

  textures(): readonly Texture[] {
    if (this.#disposed) return []
    const held: Texture[] = []
    for (const bake of ['base', 'wide', 'detail', 'curl'] as const)
      if (this.#allocated.has(bake)) held.push(this.#target(bake).texture)
    return held
  }

  /**
   * Compile every bake's pipeline, then bake the noise the field reads, so
   * the first frame reads baked noise (§4.5). The sweep variant is compiled
   * against its 1 × 1 × 1 target and baked only if it is already selected.
   * A failure is logged and swallowed, as `warmCompile`'s is: the next
   * render bakes whatever is missing.
   */
  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#warm ??= this.#compileAndBake(renderer).catch((cause: unknown) => {
      log.warn('the cloud noise did not warm', { cause: String(cause) })
    })
    return this.#warm
  }

  async #compileAndBake(renderer: WebGPURenderer): Promise<void> {
    const bakes = ['base', 'wide', 'detail', 'curl'] as const
    await warmSensorPass(
      renderer,
      this.#quad,
      bakes.map((bake) => ({
        target: this.#target(bake),
        material: this.#materials[bake],
      })),
    )
    // Disposed while the pipelines compiled: a bake now would draw into
    // targets already disposed, and three makes a disposed target's texture
    // again at its next draw, with nothing left to dispose it.
    if (this.#disposed) return
    for (const bake of bakes) this.#allocated.add(bake)
    this.#bake(renderer)
  }

  /** Bake what the frame's levers need and the noise does not yet hold; nothing else. */
  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    _budget?: CloudBudget,
  ): void {
    if (this.#disposed) return
    this.setFormat(frame.levers.noiseFormat)
    this.#bake(renderer)
  }

  /** Draw every noise that is due, a quad a slice, under one label. */
  #bake(renderer: WebGPURenderer): void {
    const due = (['base', 'detail', 'curl'] as const).filter(
      (bake) => !this.#baked.has(bake),
    ) as Bake[]
    if (this.#format === 'rgba8' && !this.#baked.has('wide')) {
      this.#wide.setSize(
        CLOUD_BASE_TEXELS,
        CLOUD_BASE_TEXELS,
        CLOUD_BASE_TEXELS,
      )
      due.push('wide')
    }
    if (due.length === 0) return
    const slice = this.#slice
    runQuadPasses(renderer, this.#quad, { linear: true }, (draw) => {
      for (const bake of due) {
        const target = this.#target(bake)
        const material = this.#materials[bake]
        if (bake === 'curl') {
          draw(CLOUD_NOISE_LABEL, target, material)
          continue
        }
        for (let z = 0; z < target.depth; z += 1) {
          slice.value = z + 0.5
          draw(CLOUD_NOISE_LABEL, target, material, z)
        }
      }
    })
    for (const bake of due) {
      this.#baked.add(bake)
      this.#allocated.add(bake)
    }
    this.setFormat(this.#format)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const bake of ['base', 'wide', 'detail', 'curl'] as const) {
      this.#target(bake).dispose()
      this.#materials[bake].dispose()
    }
  }
}
