import { invariant } from '@inertialref/shared'
import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
  type StorageTexture,
  type Texture,
  type TextureNode,
  type UniformNode,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  atomicAdd,
  atomicMax,
  atomicStore,
  Fn,
  globalId,
  If,
  instanceIndex,
  max,
  min,
  select,
  storage,
  texture,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl'
import type { Extent } from '@inertialref/rendering'
import { airEye, depthUnits, skyClass } from './cloudCompositeAir.ts'
import { CLOUD_DEPTH_CLAMP_KM } from './cloudDepth.ts'
import type { CloudFrame } from './cloudFrame.ts'
import {
  cloudRay,
  screenTexel,
  traceScreen,
  viewDirection,
} from './cloudGeometry.ts'
import { cloudKnotWriter } from './cloudKnots.ts'
import {
  CLOUD_CACHES,
  CLOUD_SUN_DEPTHS,
  type CloudCache,
  type CloudLevers,
  type CloudSunDepth,
} from './cloudLevers.ts'
import {
  type CloudAirFn,
  cloudMarch,
  type CloudMarchResult,
  cloudSweepMarch,
  marchFar,
} from './cloudMarch.ts'
import {
  type CloudBudget,
  type CloudFarFn,
  type CloudMediumFn,
  type CloudPhaseNodes,
  type CloudRay,
  type CloudResource,
  type CloudSample,
  cloudStorageTexture,
  type CloudSunFn,
  traceJitter,
} from './cloudNodes.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'
import { warmCompute } from './warmup.ts'

/*
 * The trace: one compute kernel a (cache, sun depth) pair, and the
 * sweep's, each named `cloud trace`, at a quarter of the display's axes. A
 * converging frame dispatches once at this frame's interleave phase; the
 * immediate regime dispatches four times at the same extent, a quarter of
 * the step budget each, so every store stays inside its texture (§5.14).
 *
 * A sun depth is its own variant because the cascades (a 2D array) and the
 * grid (a 3D texture) are two binding types, and binding both would put the
 * volume's kernels at 16 of the stage's 16 sampled textures. A kernel binds
 * the field (7), one sun depth, the served air (2), the phase, the far atlas
 * and the depth copy: 13, and 15 with the volume. It writes the four outputs,
 * which is the stage's limit of storage textures, so the trace has no room
 * for a fifth.
 *
 * Texel (i, j) traces history pixel (2i + φx, 2j + φy) at a point jittered
 * inside it, and every depth it writes is in true kilometers, the depth
 * copy's render kilometers divided by the served body's compression.
 */

export interface CloudTraceTextures {
  /** (L_c.rgb, T_c): the cloud's light reaching t₀ per unit sun irradiance, and its transmittance over the span. w × h. */
  readonly light: StorageTexture
  /** 2w × h. [2i, j]: (B.rgb, d_reproj km). [2i+1, j]: (d_end km, d_front km, deviation km, knots). */
  readonly aux: StorageTexture
  /** 2w × h. [2i, j]: (entry₀, exit₀, entry₁, exit₁) km. [2i+1, j]: (entry₂, exit₂, entry₃, exit₃) km. */
  readonly knotDepth: StorageTexture
  /** 2w × 2h. Knot k of texel (i, j) at (2i + (k & 1), 2j + (k >> 1)): (L.rgb, T) at the knot's exit. */
  readonly knotLight: StorageTexture
  /** The trace's extent, which every dispatch writes within, the immediate regime's included. */
  readonly extent: Extent
}

export interface CloudTraceDeps {
  readonly uniforms: CloudUniforms
  readonly media: {
    readonly field: CloudMediumFn
    readonly volume: CloudMediumFn | null
    readonly bound:
      ((s: CloudSample, b: CloudBodyUniforms) => Node<'float'>) | null
    readonly brickExit:
      | ((s: CloudSample, r: CloudRay, b: CloudBodyUniforms) => Node<'float'>)
      | null
    readonly sweep: CloudMediumFn
  }
  readonly sun: Readonly<Record<CloudSunDepth, CloudSunFn>>
  readonly phase: CloudPhaseNodes
  /** The served body's far atlas. */
  readonly far: CloudFarFn
  /** The render-resolution scene distance, km (R16F), from the depth copy. */
  readonly depth: () => Texture
  /** The air's per-sample terms; `airMediumAt` when absent. */
  readonly air?: CloudAirFn
}

/** Every kernel's name on the timeline: one label, one row. */
export const CLOUD_TRACE_LABEL = 'cloud trace'
/** The kernel that clears the step counters under `stats`. */
export const CLOUD_STATS_LABEL = 'cloud stats'

/** The interleave, stride 2 in Bayer order (§5.14). */
export const CLOUD_TRACE_PHASES = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
] as const

const WORKGROUP = 8

/** Bytes a trace texel holds: its light (8), aux (2 × 8), knot depths (2 × 8) and knot lights (4 × 8). */
const TEXEL_BYTES = 72

/** Sum of steps, the largest, rays, rays whose budget ran out. */
const STAT_SLOTS = 4

interface KernelChoice {
  readonly cache: CloudCache
  readonly sunDepth: CloudSunDepth
}

const keyOf = (choice: KernelChoice): string =>
  `${choice.cache} ${choice.sunDepth}`

const SWEEP = 'sweep'

/** Meters → the textures' kilometers, held under the clamp a half float carries. */
const kilometers = (meters: Node<'float'>): Node<'float'> =>
  min(max(meters, 0).mul(1e-3), CLOUD_DEPTH_CLAMP_KM)

/** The step counters every kernel adds to under `stats`, and their switch. */
interface Stats {
  readonly buffer: StorageBufferAttribute
  readonly counts: ReturnType<typeof countsOf>
  readonly on: UniformNode<'float', number>
}

const countsOf = (buffer: StorageBufferAttribute) =>
  storage(buffer, 'uint', STAT_SLOTS).toAtomic()

/**
 * Where texel `texel` looks this dispatch: its history pixel's direction,
 * the scene's distance there, the ray's span inside the shell union clipped
 * to it, and the texel's class (§5.11), which the composite decides for its
 * own pixel by the same test.
 */
function traceView(
  uniforms: CloudUniforms,
  depth: TextureNode,
  texel: Node<'uvec2'>,
) {
  const body = uniforms.served
  const trace = uniforms.trace
  const pixel = texel.mul(uint(2)).add(uvec2(trace.phase))
  // An offset from the history pixel's center, drawn at the history pixel
  // rather than at the texel, so the point inside the pixel and the share of
  // the first step (the texel's draw) are not one number.
  const within = traceJitter(pixel, trace.frame).sub(0.5)
  const screen = traceScreen(pixel, within, trace.history)
  const direction = viewDirection(uniforms.camera, screen).toVar()
  const distanceKm = depth.load(screenTexel(screen, trace.render)).x.toVar()
  const stop = distanceKm.mul(1000).div(body.compression).toVar()
  const ray = cloudRay(direction, body, stop)
  const sky = skyClass(
    body.air,
    airEye(body),
    direction,
    distanceKm,
    depthUnits(body),
  ).toVar()
  // A ray that meets no span ends where the scene does: the history rejects
  // an old cloud that a ridge now stands in front of by this end.
  const traced: CloudRay = {
    direction,
    mu: ray.mu.toVar(),
    nu: ray.nu.toVar(),
    start: select(ray.hit, ray.start, stop).toVar(),
    end: select(ray.hit, ray.end, stop).toVar(),
  }
  return { ray: traced, sky }
}

function store(
  outputs: CloudTraceTextures,
  texel: Node<'uvec2'>,
  result: CloudMarchResult,
  knots: Node<'float'>,
): void {
  const x = texel.x.mul(uint(2))
  textureStore(outputs.light, texel, vec4(result.light, result.transmittance))
  textureStore(
    outputs.aux,
    uvec2(x, texel.y),
    vec4(result.air, kilometers(result.reproject)),
  )
  textureStore(
    outputs.aux,
    uvec2(x.add(uint(1)), texel.y),
    vec4(
      kilometers(result.end),
      kilometers(result.front),
      kilometers(result.deviation),
      knots,
    ),
  )
}

function count(stats: Stats, result: CloudMarchResult): void {
  If(stats.on.greaterThan(0), () => {
    const steps = uint(result.steps)
    atomicAdd(stats.counts.element(0), steps)
    atomicMax(stats.counts.element(1), steps)
    atomicAdd(stats.counts.element(2), uint(1))
    atomicAdd(stats.counts.element(3), uint(result.exhausted))
  })
}

function traceKernel(
  deps: CloudTraceDeps,
  outputs: CloudTraceTextures,
  depth: TextureNode,
  stats: Stats,
  choice: KernelChoice | typeof SWEEP,
): ComputeNode {
  const { uniforms } = deps
  const body = uniforms.served
  return Fn(() => {
    const texel = globalId.xy
    const size = uvec2(uniforms.trace.size)
    // Every dispatch is at the trace's extent, so this guard is what keeps a
    // workgroup's spare invocations from storing outside the textures.
    If(texel.x.lessThan(size.x).and(texel.y.lessThan(size.y)), () => {
      const { ray, sky } = traceView(uniforms, depth, texel)
      const knots = cloudKnotWriter(outputs)
      const jitter = traceJitter(texel, uniforms.trace.frame).x
      let result: CloudMarchResult
      if (choice === SWEEP)
        result = cloudSweepMarch(ray, jitter, {
          uniforms,
          medium: deps.media.sweep,
        })
      else {
        const medium =
          choice.cache === 'volume' ? deps.media.volume! : deps.media.field
        const fine = cloudMarch(
          ray,
          jitter,
          sky,
          { ...deps, medium, sun: deps.sun[choice.sunDepth] },
          knots,
        )
        result = marchFar(
          fine,
          ray,
          (from) => deps.far(ray, from, body, sky),
          knots,
        )
      }
      store(outputs, texel, result, knots.count)
      knots.flush(texel)
      count(stats, result)
    })
  })()
    .computeKernel([WORKGROUP, WORKGROUP, 1])
    .setName(CLOUD_TRACE_LABEL)
}

/** Every (cache, sun depth) pair the media allow. */
function choices(deps: CloudTraceDeps): KernelChoice[] {
  const volume =
    deps.media.volume !== null &&
    deps.media.bound !== null &&
    deps.media.brickExit !== null
  return CLOUD_CACHES.filter((cache) => cache === 'field' || volume).flatMap(
    (cache) => CLOUD_SUN_DEPTHS.map((sunDepth) => ({ cache, sunDepth })),
  )
}

export class CloudTrace implements CloudResource {
  readonly name = 'trace'
  readonly pending = false
  readonly #deps: CloudTraceDeps
  readonly #stats: Stats
  #outputs: CloudTraceTextures
  #kernels: Map<string, ComputeNode> | null = null
  #clear: ComputeNode | null = null
  #depth: TextureNode | null = null
  #steps: CloudTrace['steps'] = null
  #counting = false
  #reading = false
  #wanted = false
  /** Whether the outputs exist on the GPU: a warm-up or a dispatch has bound them. */
  #allocated = false
  #warm: Promise<void> | null = null
  #disposed = false

  constructor(deps: CloudTraceDeps) {
    this.#deps = deps
    const buffer = new StorageBufferAttribute(new Uint32Array(STAT_SLOTS), 1)
    this.#stats = { buffer, counts: countsOf(buffer), on: uniform(0) }
    this.#outputs = {
      light: cloudStorageTexture(1, 1, 'rgba16float', 'cloud trace light'),
      aux: cloudStorageTexture(2, 1, 'rgba16float', 'cloud trace aux'),
      knotDepth: cloudStorageTexture(2, 1, 'rgba16float', 'cloud knot depth'),
      knotLight: cloudStorageTexture(2, 2, 'rgba16float', 'cloud knot light'),
      extent: { width: 1, height: 1 },
    }
  }

  /**
   * What the trace writes. `outputs` and not `textures`, which every resource
   * answers with what it holds for the census.
   */
  get outputs(): CloudTraceTextures {
    return this.#outputs
  }

  /** Mean and largest steps a ray when `levers.stats`, read back a few frames late; null otherwise. */
  get steps(): {
    readonly mean: number
    readonly max: number
    readonly exhausted: number
  } | null {
    return this.#steps
  }

  /** Nothing until the outputs exist on the GPU: 72 B a texel of the extent after. */
  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    const { width, height } = this.#outputs.extent
    return width * height * TEXEL_BYTES
  }

  textures(): readonly Texture[] {
    if (this.#disposed || !this.#allocated) return []
    const { light, aux, knotDepth, knotLight } = this.#outputs
    return [light, aux, knotDepth, knotLight]
  }

  /**
   * Every kernel the trace dispatches, the counters' clear included: the
   * warm-up's subject. Built on first ask, so constructing a trace reads
   * nothing of its deps, the depth copy's texture among them.
   */
  kernels(): readonly ComputeNode[] {
    if (this.#kernels === null) {
      const depth = texture(this.#deps.depth())
      const kernels = new Map<string, ComputeNode>()
      for (const choice of choices(this.#deps))
        kernels.set(
          keyOf(choice),
          traceKernel(this.#deps, this.#outputs, depth, this.#stats, choice),
        )
      kernels.set(
        SWEEP,
        traceKernel(this.#deps, this.#outputs, depth, this.#stats, SWEEP),
      )
      const { counts } = this.#stats
      this.#clear = Fn(() => {
        If(instanceIndex.lessThan(uint(STAT_SLOTS)), () => {
          atomicStore(counts.element(instanceIndex), uint(0))
        })
      })()
        .compute(STAT_SLOTS)
        .setName(CLOUD_STATS_LABEL)
      this.#depth = depth
      this.#kernels = kernels
    }
    return [...this.#kernels.values(), this.#clear!]
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#allocated = true
    this.#warm ??= warmCompute(renderer, this.kernels())
    return this.#warm
  }

  /** The converging regime: one dispatch of the selected kernel at this frame's interleave phase. */
  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    _budget: CloudBudget,
  ): void {
    const phase = CLOUD_TRACE_PHASES[frame.frameIndex % 4]!
    this.#dispatch(renderer, frame, phase, true, true)
  }

  /**
   * The immediate regime's k-th dispatch (k = 0…3, Bayer order), at
   * maxSteps/4; the system follows each with the history's immediate kernel
   * (§5.14).
   */
  dispatchPhase(renderer: WebGPURenderer, frame: CloudFrame, k: number): void {
    const phase = CLOUD_TRACE_PHASES[k]
    invariant(phase !== undefined, 'the immediate regime has four phases')
    this.#dispatch(renderer, frame, phase, k === 0, k === 3)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const kernel of this.#kernels?.values() ?? []) kernel.dispose()
    this.#clear?.dispose()
    const { light, aux, knotDepth, knotLight } = this.#outputs
    for (const map of [light, aux, knotDepth, knotLight]) map.dispose()
    this.#stats.buffer.dispose()
  }

  #dispatch(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    phase: readonly [number, number],
    first: boolean,
    last: boolean,
  ): void {
    if (this.#disposed) return
    const kernel = this.#kernel(frame.levers)
    const { width, height } = frame.extents.trace
    this.#size(width, height)
    const depth = this.#deps.depth()
    if (this.#depth!.value !== depth) this.#depth!.value = depth
    if (first) {
      this.#wanted = frame.levers.stats
      if (!this.#wanted) this.#steps = null
      // One readback outstanding at a time, as the meter's; a frame that
      // cannot read its counts back does not count them.
      this.#counting = this.#wanted && !this.#reading
      if (this.#counting) renderer.compute(this.#clear!)
      this.#stats.on.value = this.#counting ? 1 : 0
    }
    this.#deps.uniforms.trace.phase.value.set(phase[0], phase[1])
    renderer.compute(kernel, [
      Math.ceil(width / WORKGROUP),
      Math.ceil(height / WORKGROUP),
      1,
    ])
    if (last && this.#counting) this.#read(renderer)
  }

  #kernel(levers: CloudLevers): ComputeNode {
    this.kernels()
    const key = levers.fixedSteps > 0 ? SWEEP : keyOf(levers)
    const kernel = this.#kernels!.get(key)
    invariant(
      kernel !== undefined,
      `the trace has no ${key} kernel: the volume cache needs its medium, bound and brick exit`,
    )
    return kernel
  }

  /** The outputs at the frame's extent, reallocated only when it changes. */
  #size(width: number, height: number): void {
    const { light, aux, knotDepth, knotLight, extent } = this.#outputs
    if (extent.width !== width || extent.height !== height) {
      // `@types/three` declares a depth that r185's 2D storage texture ignores.
      light.setSize(width, height, 1)
      aux.setSize(2 * width, height, 1)
      knotDepth.setSize(2 * width, height, 1)
      knotLight.setSize(2 * width, 2 * height, 1)
      this.#outputs = { ...this.#outputs, extent: { width, height } }
    }
    this.#allocated = true
  }

  #read(renderer: WebGPURenderer): void {
    this.#reading = true
    void renderer
      .getArrayBufferAsync(this.#stats.buffer)
      .then((buffer) => {
        if (this.#disposed || !this.#wanted) return
        const [sum = 0, largest = 0, rays = 0, exhausted = 0] = new Uint32Array(
          buffer,
        )
        this.#steps =
          rays > 0 ? { mean: sum / rays, max: largest, exhausted } : null
      })
      .catch(() => {
        // A device being replaced reads nothing back; the next frame counts again.
      })
      .finally(() => {
        this.#reading = false
      })
  }
}
