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
  floatBitsToUint,
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
import { CLOUD_PHASE_MODES } from './cloudLevers.ts'
import {
  type CloudAirFn,
  cloudMarch,
  type CloudMarchResult,
  type CloudPhaseMode,
  KIND_GAP,
  KIND_SUN,
  marchFar,
} from './cloudMarch.ts'
import {
  type CloudBudget,
  type CloudFarFn,
  type CloudJitterNodes,
  type CloudMediumFn,
  type CloudPhaseNodes,
  type CloudRay,
  type CloudResource,
  type CloudSkyNodes,
  type CloudSourceNodes,
  cloudStorageTexture,
  type CloudSunFn,
} from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import { warmCompute } from './warmup.ts'

/*
 * The trace: a compute kernel that marches the field, named `cloud trace`,
 * at a quarter of the display's axes. A
 * converging frame dispatches once at this frame's interleave phase; the
 * immediate regime dispatches four times at the same extent, a quarter of
 * the step budget each, so every store stays inside its texture (§5.14).
 *
 * **It is three kernels while the phase's radius is a measured choice**
 * (§4.5): how first order takes its radius changes the march's registers,
 * so `mean`, `bins` and `sample` are three programs under one name, and the
 * `phaseMode` lever says which a frame dispatches. All three are warmed, so
 * no frame of any lever set compiles one.
 *
 * The kernel binds the field (4: the clipmap's cover, the two noises and the
 * profile), the sun grid, the served air (2), the phase, the far atlas, the
 * depth copy and the jitter's mask: 11 of the stage's 16 sampled textures, which
 * `cloudTrace.gpu.test.ts` counts in the system's own kernel. It writes the
 * four outputs, which is the stage's limit of storage textures, so the trace
 * has no room for a fifth.
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
  /** What the fine march reads: the field (§5.6). */
  readonly medium: CloudMediumFn
  /** The light a cloud sample sees: the taps, then the sun grid. */
  readonly sun: CloudSunFn
  readonly phase: CloudPhaseNodes
  /** The served body's far atlas. */
  readonly far: CloudFarFn
  /** The render-resolution scene distance, km (R16F), from the depth copy. */
  readonly depth: () => Texture
  /** The air's per-sample terms; `airMediumAt` when absent. */
  readonly air?: CloudAirFn
  /** The sky's light at a sample, from the served body's own table. */
  readonly sky: CloudSkyNodes
  /** The higher orders' source at a sample's two depths. */
  readonly source: CloudSourceNodes
  /** The four numbers a ray is placed by. */
  readonly jitter: CloudJitterNodes
  /** `CloudMarchOptions.unstrided`: the march a test holds the strides to. */
  readonly unstrided?: boolean
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

/**
 * Sum of steps, the largest, rays, rays whose budget's floor lengthened a
 * step in cloud; then the sum of the rays' opacity in `OPACITY_UNIT`s, and
 * the center texel's range as a float's bits with the count of dispatches
 * that wrote it; then the rays' work by kind: steps in cloud, steps outside
 * every level, suns taken, taps read and taps the early out left unread.
 */
const STAT_SLOTS = 12
/**
 * The GPU's batch, trace texels wide and tall. A workgroup of 8 × 8 runs as
 * two batches of 32 rays, its top four rows and its bottom four, and a batch
 * costs its longest ray: half the rays at 8 reads and half at 40 cost what
 * every ray at 40 costs when the two share batches (measured on the Mac
 * mini's M6). So the mean over batches of each batch's longest ray is the
 * step count the trace's time follows, and it has a buffer of its own: a
 * maximum a batch cannot be held in a slot.
 */
const BATCH = [8, 4] as const
/** Batches a row of the maxima's buffer holds, and its rows: a trace of 1,024 × 512. */
const BATCH_STRIDE = 128
const BATCH_SLOTS = BATCH_STRIDE * BATCH_STRIDE
/** A ray's opacity is summed in 1,024ths: four dispatches of a Retina trace's 324,000 rays stay under 2³². */
const OPACITY_UNIT = 1024

/** Meters → the textures' kilometers, held under the clamp a half float carries. */
const kilometers = (meters: Node<'float'>): Node<'float'> =>
  min(max(meters, 0).mul(1e-3), CLOUD_DEPTH_CLAMP_KM)

/** What the trace counts of its rays under `stats`. */
export interface CloudTraceSteps {
  /** Steps a ray, the mean and the most. */
  readonly mean: number
  readonly max: number
  /** Rays whose budget's floor lengthened a step in cloud past the schedule's. */
  readonly exhausted: number
  /** The mean of 1 − T_c over the rays: the served opacity. */
  readonly opacity: number
  /**
   * Meters from the eye at which the cloud's optical depth along the
   * frame's central ray reaches ln 50; null where it never does.
   */
  readonly range: number | null
  /**
   * A ray's work by kind, means over the rays: its steps in cloud, its
   * steps inside a level that found none, its steps outside every level,
   * the suns it took, the taps those read, and the taps the sun's early out
   * left unread.
   */
  readonly kinds: {
    readonly cloud: number
    readonly clear: number
    readonly gap: number
    readonly suns: number
    readonly taps: number
    readonly skipped: number
  }
  /**
   * The mean over the GPU's batches of 32 rays of each batch's longest ray,
   * steps: what the trace's time follows where the rays' mean does not.
   * Null for a trace of more batches than the buffer holds.
   */
  readonly batchLongest: number | null
}

/** The mean of the batches' maxima over a trace's extent; null where it outruns the buffer. */
function batchLongestOf(buffer: ArrayBuffer, extent: Extent): number | null {
  const columns = Math.ceil(extent.width / BATCH[0])
  const rows = Math.ceil(extent.height / BATCH[1])
  if (columns > BATCH_STRIDE || rows > BATCH_STRIDE) return null
  const longest = new Uint32Array(buffer)
  let sum = 0
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1)
      sum += longest[row * BATCH_STRIDE + column] ?? 0
  return sum / (columns * rows)
}

/** The counters' buffers as a report; null where no ray was counted. */
function stepsOf(
  buffer: ArrayBuffer,
  batches: ArrayBuffer,
  extent: Extent,
): CloudTraceSteps | null {
  const counts = new Uint32Array(buffer)
  const [sum = 0, largest = 0, rays = 0, exhausted = 0, opacity = 0] = counts
  if (rays === 0) return null
  const range = new Float32Array(buffer)[5] ?? -1
  const written = (counts[6] ?? 0) > 0
  const of = (slot: number): number => (counts[slot] ?? 0) / rays
  return {
    mean: sum / rays,
    max: largest,
    exhausted,
    opacity: opacity / OPACITY_UNIT / rays,
    range: written && range >= 0 ? range : null,
    kinds: {
      cloud: of(7),
      clear: (sum - (counts[7] ?? 0) - (counts[8] ?? 0)) / rays,
      gap: of(8),
      suns: of(9),
      taps: of(10),
      skipped: of(11),
    },
    batchLongest: batchLongestOf(batches, extent),
  }
}

/** The step counters every kernel adds to under `stats`, and their switch. */
interface Stats {
  readonly buffer: StorageBufferAttribute
  readonly counts: ReturnType<typeof countsOf>
  /** Each batch's longest ray, steps: `BATCH_STRIDE` batches a row. */
  readonly batchBuffer: StorageBufferAttribute
  readonly batches: ReturnType<typeof countsOf>
  readonly on: UniformNode<'float', number>
}

const countsOf = (buffer: StorageBufferAttribute, slots = STAT_SLOTS) =>
  storage(buffer, 'uint', slots).toAtomic()

/**
 * Where texel `texel` looks this dispatch: its history pixel's direction,
 * the scene's distance there, the ray's span inside the shell union clipped
 * to it, and the texel's class (§5.11), which the composite decides for its
 * own pixel by the same test.
 */
function traceView(
  uniforms: CloudUniforms,
  within: Node<'vec2'>,
  depth: TextureNode,
  texel: Node<'uvec2'>,
) {
  const body = uniforms.served
  const trace = uniforms.trace
  const pixel = texel.mul(uint(2)).add(uvec2(trace.phase))
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

/**
 * A ray's share of the counters, and the center texel's range: the distance
 * along the frame's central ray at which the cloud's optical depth reaches
 * ln 50, from the fine march's own steps (§8.5).
 */
function count(
  stats: Stats,
  result: CloudMarchResult,
  fine: CloudMarchResult,
  texel: Node<'uvec2'>,
  center: Node<'bool'>,
): void {
  If(stats.on.greaterThan(0), () => {
    const steps = uint(result.steps)
    atomicAdd(stats.counts.element(0), steps)
    atomicMax(stats.counts.element(1), steps)
    // The ray's kinds, unpacked: its steps in cloud, its steps outside
    // every level, and its suns.
    const kinds = uint(fine.kinds).toVar()
    atomicAdd(stats.counts.element(7), kinds.mod(uint(KIND_GAP)))
    atomicAdd(
      stats.counts.element(8),
      kinds.div(uint(KIND_GAP)).mod(uint(KIND_SUN / KIND_GAP)),
    )
    atomicAdd(stats.counts.element(9), kinds.div(uint(KIND_SUN)))
    atomicAdd(stats.counts.element(10), uint(fine.taps.x))
    atomicAdd(stats.counts.element(11), uint(fine.taps.y))
    // A trace wider or taller than the buffer's batches counts none of
    // them, and the report answers null.
    const column = texel.x.div(uint(BATCH[0]))
    const row = texel.y.div(uint(BATCH[1]))
    If(
      column.lessThan(uint(BATCH_STRIDE)).and(row.lessThan(uint(BATCH_STRIDE))),
      () => {
        atomicMax(
          stats.batches.element(row.mul(uint(BATCH_STRIDE)).add(column)),
          steps,
        )
      },
    )
    atomicAdd(stats.counts.element(2), uint(1))
    atomicAdd(stats.counts.element(3), uint(result.exhausted))
    const opacity = min(max(result.transmittance.oneMinus(), 0), 1)
    atomicAdd(stats.counts.element(4), uint(opacity.mul(OPACITY_UNIT).add(0.5)))
    If(center, () => {
      // `@types/three` declares no node type on a bitcast; it is a u32.
      const bits = floatBitsToUint(fine.range) as unknown as Node<'uint'>
      atomicStore(stats.counts.element(5), bits)
      atomicAdd(stats.counts.element(6), uint(1))
    })
  })
}

function traceKernel(
  deps: CloudTraceDeps,
  outputs: CloudTraceTextures,
  depth: TextureNode,
  stats: Stats,
  phaseMode: CloudPhaseMode,
): ComputeNode {
  const { uniforms } = deps
  const body = uniforms.served
  return Fn(() => {
    const texel = globalId.xy
    const size = uvec2(uniforms.trace.size)
    // Every dispatch is at the trace's extent, so this guard is what keeps a
    // workgroup's spare invocations from storing outside the textures.
    If(texel.x.lessThan(size.x).and(texel.y.lessThan(size.y)), () => {
      // One draw a ray, at its texel: the first step's share, the point
      // inside the texel's history pixel as an offset from its center, and
      // the handover's ξ.
      const draw = deps.jitter.draw(texel, uniforms.trace.frame).toVar()
      const { ray, sky } = traceView(uniforms, draw.yz.sub(0.5), depth, texel)
      const knots = cloudKnotWriter(outputs)
      // The switch to a level's statistics is dithered by the first
      // coordinate of the ray's point inside its pixel, not by the
      // handover's ξ: a ray whose switch and whose handover moved together
      // would be coarse in both or fine in both, and a pixel's samples would
      // differ by the two at once. The point's coordinate is uncorrelated
      // with ξ under either draw, and it spreads the two representations
      // across the pixel's own width.
      const fine = cloudMarch(ray, draw.x, sky, deps, knots, {
        handover: draw.w,
        dither: draw.y,
        phaseMode,
        ...(deps.unstrided === undefined ? {} : { unstrided: deps.unstrided }),
      })
      const result = marchFar(
        fine,
        ray,
        (from) => deps.far(ray, from, body, sky),
        knots,
      )
      store(outputs, texel, result, knots.count)
      knots.flush(texel)
      const middle = size.div(uint(2))
      const center = texel.x.equal(middle.x).and(texel.y.equal(middle.y))
      count(stats, result, fine, texel, center)
    })
  })()
    .computeKernel([WORKGROUP, WORKGROUP, 1])
    .setName(CLOUD_TRACE_LABEL)
}

export class CloudTrace implements CloudResource {
  readonly name = 'trace'
  readonly pending = false
  readonly #deps: CloudTraceDeps
  readonly #stats: Stats
  #outputs: CloudTraceTextures
  /** The march's kernels, in `CLOUD_PHASE_MODES`' order. */
  #kernels: readonly ComputeNode[] | null = null
  #clear: ComputeNode | null = null
  #depth: TextureNode | null = null
  #steps: CloudTraceSteps | null = null
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
    const batchBuffer = new StorageBufferAttribute(
      new Uint32Array(BATCH_SLOTS),
      1,
    )
    this.#stats = {
      buffer,
      counts: countsOf(buffer),
      batchBuffer,
      batches: countsOf(batchBuffer, BATCH_SLOTS),
      on: uniform(0),
    }
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

  /** The rays' counters when `levers.stats`, read back a few frames late; null otherwise. */
  get steps(): CloudTraceSteps | null {
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
   * Every kernel the trace dispatches, the march's three and then the
   * counters' clear: the warm-up's subject. Built on first ask, so
   * constructing a trace reads nothing of its deps, the depth copy's texture
   * among them.
   */
  kernels(): readonly ComputeNode[] {
    if (this.#kernels === null) {
      const depth = texture(this.#deps.depth())
      const kernels = CLOUD_PHASE_MODES.map((mode) =>
        traceKernel(this.#deps, this.#outputs, depth, this.#stats, mode),
      )
      const { counts, batches } = this.#stats
      this.#clear = Fn(() => {
        If(instanceIndex.lessThan(uint(BATCH_SLOTS)), () => {
          atomicStore(batches.element(instanceIndex), uint(0))
        })
        If(instanceIndex.lessThan(uint(STAT_SLOTS)), () => {
          atomicStore(counts.element(instanceIndex), uint(0))
        })
      })()
        .compute(BATCH_SLOTS)
        .setName(CLOUD_STATS_LABEL)
      this.#depth = depth
      this.#kernels = kernels
    }
    return [...this.#kernels, this.#clear!]
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#allocated = true
    this.#warm ??= warmCompute(renderer, this.kernels())
    return this.#warm
  }

  /** The converging regime: one dispatch at this frame's interleave phase. */
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
    for (const kernel of this.#kernels ?? []) kernel.dispose()
    this.#clear?.dispose()
    const { light, aux, knotDepth, knotLight } = this.#outputs
    for (const map of [light, aux, knotDepth, knotLight]) map.dispose()
    this.#stats.buffer.dispose()
    this.#stats.batchBuffer.dispose()
  }

  #dispatch(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    phase: readonly [number, number],
    first: boolean,
    last: boolean,
  ): void {
    if (this.#disposed) return
    const kernel =
      this.kernels()[CLOUD_PHASE_MODES.indexOf(frame.levers.phaseMode)]
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
    renderer.compute(kernel!, [
      Math.ceil(width / WORKGROUP),
      Math.ceil(height / WORKGROUP),
      1,
    ])
    if (last && this.#counting) this.#read(renderer)
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
    const { extent } = this.#outputs
    void Promise.all([
      renderer.getArrayBufferAsync(this.#stats.buffer),
      renderer.getArrayBufferAsync(this.#stats.batchBuffer),
    ])
      .then(([buffer, batches]) => {
        if (this.#disposed || !this.#wanted) return
        this.#steps = stepsOf(buffer, batches, extent)
      })
      .catch(() => {
        // A device being replaced reads nothing back; the next frame counts again.
      })
      .finally(() => {
        this.#reading = false
      })
  }
}
