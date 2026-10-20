import { DebugView, Upscaler, type UpscalePath } from '@pmndrs/upscaler'
import {
  DataTexture,
  FloatType,
  LinearFilter,
  NodeUpdateType,
  RGBAFormat,
  TempNode,
  Vector2,
  type Camera,
  type NodeBuilder,
  type PassNode,
  type PerspectiveCamera,
  type Texture,
  type TextureNode,
  type WebGPURenderer,
} from 'three/webgpu'
import { passTexture, velocity } from 'three/tsl'
import { getLogger } from '@inertialref/shared'
import { onTimingLevel } from '../engine/browserTiming.ts'
import { renderSize } from './picture.ts'
import { type OwnedSample, passTimelineOf } from './passTimeline.ts'

const log = getLogger('game.upscale')

export type PictureDebug =
  | 'none'
  | 'motion'
  | 'disocclusion'
  | 'depth'
  | 'age'
  | 'locks'
  | 'exposure'
  | 'shading'
  | 'reactivity'

const DEBUG_VALUES: Readonly<Record<PictureDebug, DebugView>> = {
  none: DebugView.None,
  motion: DebugView.MotionVectors,
  disocclusion: DebugView.Disocclusion,
  depth: DebugView.Depth,
  age: DebugView.AccumulationAge,
  locks: DebugView.Locks,
  exposure: DebugView.Exposure,
  shading: DebugView.ShadingChange,
  reactivity: DebugView.Reactivity,
}

export const PICTURE_DEBUG_VIEWS = Object.freeze(
  Object.keys(DEBUG_VALUES) as PictureDebug[],
)
export const isPictureDebug = (value: unknown): value is PictureDebug =>
  typeof value === 'string' && Object.hasOwn(DEBUG_VALUES, value)

export interface UpscaleDiagnostics {
  readonly path: 'native' | Exclude<UpscalePath, 'guides'>
  readonly renderWidth: number
  readonly renderHeight: number
  readonly displayWidth: number
  readonly displayHeight: number
  readonly phase: number
  readonly phaseCount: number
  readonly frames: number
  readonly resets: number
  /** Actual texture descriptors allocated by the device, excluding scene/optical targets. */
  readonly workingTextureBytes: number
  readonly initMs: number
  readonly gpuTimings: Readonly<Record<string, number>>
  readonly debug: PictureDebug
}

export interface UpscaleInputs {
  readonly color: TextureNode
  readonly depth: TextureNode
  readonly velocity: TextureNode | null
  readonly reactive: TextureNode | null
}

interface RawBackend {
  readonly device: GPUDevice
  get(texture: Texture): { texture?: GPUTexture }
}

/**
 * Verified against pinned 0.5.0. `gpuTiming` is the public switch and
 * `gpuTimings` holds only the latest frame; the per-frame sample queue a pass
 * timeline needs is private. The timer exists only while `gpuTiming` is on,
 * and turning it on after `init` allocates a new one, so it is looked up at
 * each use rather than held.
 */
interface RawTimer {
  /** Settles once the device has confirmed the query sets; never rejects. */
  readonly ready: Promise<void>
  takeSamples(): unknown[]
  /** The queue, then every readback in flight. */
  drain(): Promise<void>
  reset(): void
}

/*
 * A sample is `{ frameTag, sequence, passes: [{ label, milliseconds }] }` in
 * 0.5.0: `readback` subtracts each begin from its end and unmaps the buffer,
 * so a duration is all that leaves the timer. Read defensively, because the
 * shape is the package's private business.
 */
function durations(samples: readonly unknown[]): OwnedSample[] {
  const out: OwnedSample[] = []
  for (const sample of samples) {
    const passes = (sample as { passes?: unknown } | null)?.passes
    if (!Array.isArray(passes)) continue
    for (const pass of passes as {
      label?: unknown
      milliseconds?: unknown
    }[]) {
      if (
        typeof pass?.label === 'string' &&
        typeof pass.milliseconds === 'number'
      )
        out.push({ label: pass.label, ms: pass.milliseconds })
    }
  }
  return out
}

/**
 * The sensor schedules the library's raw kernels once per render call. Keeping
 * jitter outside the graph lets the sensor restore the camera after a throw.
 */
export class UpscaleNode extends TempNode<'vec4'> {
  static get type() {
    return 'UpscaleNode'
  }
  readonly #renderer: WebGPURenderer
  readonly #camera: PerspectiveCamera
  readonly #inputs: UpscaleInputs
  readonly #path: Exclude<UpscalePath, 'guides'>
  readonly #ratio: number
  readonly #kernel: Upscaler
  readonly #size = new Vector2()
  readonly #preData = new Float32Array([1, 0, 0, 1])
  readonly #pre = new DataTexture(this.#preData, 1, 1, RGBAFormat, FloatType)
  readonly #standIn = new DataTexture(
    new Float32Array([0, 0, 0, 1]),
    1,
    1,
    RGBAFormat,
    FloatType,
  )
  readonly outputTexture = passTexture(
    this as unknown as PassNode,
    this.#standIn,
  )
  #initialized = false
  #disposed = false
  #delta = 1 / 60
  #phase = 0
  #frames = 0
  #resets = 0
  #bytes = 0
  #initMs = 0
  #started = 0
  #ready: Promise<void> = Promise.resolve()
  #debug: PictureDebug = 'none'
  #stopTiming: (() => void) | null = null
  #detach: (() => void) | null = null
  /** Durations kept for a pass timeline's run; null when none is measuring. */
  #collected: OwnedSample[] | null = null

  constructor(
    renderer: WebGPURenderer,
    inputs: UpscaleInputs,
    camera: Camera,
    options: {
      path: Exclude<UpscalePath, 'guides'>
      ratio: number
      sharpness: number
    },
  ) {
    super('vec4')
    this.updateBeforeType = NodeUpdateType.RENDER
    this.#renderer = renderer
    this.#inputs = inputs
    this.#camera = camera as PerspectiveCamera
    this.#path = options.path
    this.#ratio = options.ratio
    this.#kernel = new Upscaler({ renderer })
    this.#kernel.settings.sharpness = options.sharpness
    // The camera meters its own radiance. FSR's exposure only conditions its
    // invertible accumulation domain and is divided out before the output.
    this.#kernel.settings.autoExposure = false
    this.#kernel.settings.exposure = 1
    this.#standIn.minFilter = LinearFilter
    this.#standIn.magFilter = LinearFilter
    this.#standIn.needsUpdate = true
    this.#pre.name = 'sensor-pre-exposure'
    this.#pre.needsUpdate = true
    if (options.path === 'temporal')
      velocity.setProjectionMatrix(this.#kernel.unjitteredProjectionMatrix)
  }

  prepare(): void {
    if (this.#disposed) return
    if (!this.#initialized) {
      this.#started = performance.now()
      // compileAsync executes update-before dependencies too. The host input
      // must be backed before warming can dispatch the temporal kernel.
      this.#renderer.initTexture(this.#pre)
      this.#camera.coordinateSystem = this.#renderer.coordinateSystem
      ;(this.#camera as unknown as { _reversedDepth: boolean })._reversedDepth =
        this.#renderer.reversedDepthBuffer
      this.#camera.updateProjectionMatrix()
      this.#kernel.unjitteredProjectionMatrix.copy(
        this.#camera.projectionMatrix,
      )
      // Timestamps cost a query set and a readback per pass, so they run only
      // at the `full` timing level or for a pass timeline's run. Last in the
      // first prepare, because a throw above leaves `#initialized` false and
      // the next prepare attaches again: attached before that, the timeline
      // would hold two sources sharing `#collected`, and `dispose` would take
      // back only the second.
      const kernel = this.#kernel
      const supported = (
        this.#renderer.backend as unknown as RawBackend
      ).device.features.has('timestamp-query')
      let level = 'off'
      this.#stopTiming = onTimingLevel((next) => {
        level = next
        if (!supported || this.#collected !== null) return
        kernel.gpuTiming = level === 'full'
      })
      /*
       * The pass timeline is the renderer's one GPU instrument, and these
       * compute passes are encoded outside three where its hooks cannot
       * reach. So the timer is lent to it for a run: armed whatever the level,
       * drained after the frames, and handed back as begin-to-end durations
       * the timeline reports beside its own passes rather than among them.
       */
      const timeline = passTimelineOf(this.#renderer)
      if (supported && timeline !== null) {
        this.#detach = timeline.attach({
          name: 'upscaler',
          arm: async () => {
            kernel.gpuTiming = true
            // A timer allocated just now times nothing until its query sets
            // are confirmed, and a run is a handful of synchronous frames.
            const timer = this.#timer()
            await timer?.ready
            // A reset, not a take: a take empties what has landed, and the
            // readbacks of frames drawn before the run land during its first
            // drain and would be counted as its own. The epoch drops them.
            timer?.reset()
            this.#collected = []
          },
          disarm: async () => {
            try {
              const timer = this.#timer()
              await timer?.drain()
              this.#collected?.push(...durations(timer?.takeSamples() ?? []))
              return this.#collected ?? []
            } finally {
              this.#collected = null
              kernel.gpuTiming = level === 'full'
            }
          },
        })
      }
      this.#initialized = true
    }
    this.#renderer.getDrawingBufferSize(this.#size)
    // The pass's own extent, by the pass's own arithmetic: see `renderSize`.
    const width = renderSize(this.#size.x, this.#ratio)
    const height = renderSize(this.#size.y, this.#ratio)
    if (
      this.#kernel.displayWidth === this.#size.x &&
      this.#kernel.displayHeight === this.#size.y &&
      this.#kernel.renderWidth === width &&
      this.#kernel.renderHeight === height
    )
      return
    const device = (this.#renderer.backend as unknown as RawBackend).device
    const create = device.createTexture.bind(device)
    let bytes = 0
    let unaccounted = 0
    // Count the library's raw allocations too; renderer.info cannot see them.
    // A format the table does not know is over-counted at the widest format
    // the library uses and reported, never thrown: this hook wraps the
    // device's own `createTexture`, so a throw abandons `configure` with the
    // kernel half-allocated and every later frame throws with it. Accounting
    // is a readout, and a readout may not decide whether the scene draws.
    device.createTexture = (descriptor) => {
      const gpu = create(descriptor)
      const formats: Partial<Record<GPUTextureFormat, number>> = {
        rgba16float: 8,
        r32float: 4,
        rgba8unorm: 4,
        r8unorm: 1,
      }
      const pixelBytes = formats[gpu.format]
      if (pixelBytes === undefined) unaccounted += 1
      bytes +=
        gpu.width * gpu.height * gpu.depthOrArrayLayers * (pixelBytes ?? 8)
      return gpu
    }
    try {
      this.#kernel.configure({
        displayWidth: this.#size.x,
        displayHeight: this.#size.y,
        renderWidth: width,
        renderHeight: height,
        path: this.#path,
        jitter: this.#path === 'temporal',
      })
    } finally {
      device.createTexture = create
    }
    if (unaccounted > 0)
      log.warn('upscaler textures in an unaccounted format', {
        textures: unaccounted,
        path: this.#path,
      })
    /*
     * The library compiles the configured path's pipelines off the frame and
     * refuses a dispatch until they exist, and `configure` is what names the
     * path — preparing before it warms the default path, not this one. The
     * boot awaits this through `ready`; a frame drawn sooner skips the
     * dispatch and presents the output WebGPU zero-initialized, rather than
     * throwing inside a render.
     */
    this.#ready = this.#kernel.prepare().then(() => {
      if (this.#initMs === 0) this.#initMs = performance.now() - this.#started
    })
    this.#ready.catch((cause: unknown) => {
      log.error('upscaler pipelines failed to prepare', { cause })
    })
    this.#bytes = bytes
    this.outputTexture.value = this.#kernel.outputTexture
    this.#phase = 0
    this.#resets += 1
  }

  /** Settles once the kernel's pipelines exist; rejects if they cannot. */
  ready(): Promise<void> {
    this.prepare()
    return this.#ready
  }

  beginFrame(
    delta: number,
    preExposure: number,
    conditioning: number,
    debug: PictureDebug,
  ): void {
    this.prepare()
    this.#delta = Number.isFinite(delta)
      ? Math.max(0, Math.min(0.1, delta))
      : 1 / 60
    this.#debug = debug
    this.#kernel.settings.debugView = DEBUG_VALUES[debug]
    // Both scalars come from the meter, and both divide back out of the
    // output, so a non-finite one does not darken a frame — it writes NaN
    // into the accumulation domain, where history carries it forward for
    // good. Clamp them the way the delta above is clamped.
    this.#kernel.settings.exposure = Number.isFinite(conditioning)
      ? Math.max(1e-4, Math.min(65504, conditioning))
      : 1
    const pre = Number.isFinite(preExposure) ? preExposure : 1
    if (this.#preData[0] !== Math.fround(pre)) {
      this.#preData[0] = pre
      this.#pre.needsUpdate = true
    }
    this.#renderer.initTexture(this.#pre)
    // Three normally sets these just before the scene draw, which is too late
    // for the first jitter-free projection captured here.
    this.#camera.coordinateSystem = this.#renderer.coordinateSystem
    ;(this.#camera as unknown as { _reversedDepth: boolean })._reversedDepth =
      this.#renderer.reversedDepthBuffer
    const aspect = this.#camera.aspect
    this.#kernel.beginFrame(this.#camera)
    // setViewOffset assigns the render buffer's aspect. Independent integer
    // rounding must not change the display lens or survive the jitter window.
    if (this.#camera.isPerspectiveCamera && this.#camera.aspect !== aspect) {
      this.#camera.aspect = aspect
      this.#camera.updateProjectionMatrix()
    }
    if (this.#path === 'temporal')
      this.#phase = (this.#phase + 1) % this.#kernel.jitterPhaseCount
  }

  endFrame(): void {
    this.#kernel.endFrame(this.#camera)
  }

  resetHistory(): void {
    if (this.#initialized) this.#kernel.resetHistory()
    this.#phase = 0
    this.#resets += 1
  }

  override setup(builder: NodeBuilder) {
    this.prepare()
    const properties = (
      builder as NodeBuilder & {
        getNodeProperties(node: UpscaleNode): Record<string, unknown>
      }
    ).getNodeProperties(this)
    properties.color = this.#inputs.color
    if (this.#path === 'temporal') {
      properties.depth = this.#inputs.depth
      properties.velocity = this.#inputs.velocity
      properties.reactive = this.#inputs.reactive
    }
    return this.outputTexture
  }

  override updateBefore(): undefined {
    if (this.#disposed) return
    // The library retains a fresh-sample queue separately from its latest
    // timings map. The interactive readout needs only the latter; drain the
    // former each submission so a long flight cannot grow it indefinitely,
    // and keep what it held while a pass timeline is measuring.
    const samples = this.#timer()?.takeSamples() ?? []
    this.#collected?.push(...durations(samples))
    if (!this.#kernel.isReady) return
    this.#kernel.dispatch(
      {
        color: this.#inputs.color.value,
        ...(this.#path === 'temporal'
          ? {
              depth: this.#inputs.depth.value,
              velocity: this.#inputs.velocity!.value,
              reactive: this.#inputs.reactive!.value,
              preExposureTexture: this.#pre,
            }
          : {}),
        deltaTime: this.#delta,
      },
      this.#camera,
    )
    this.#frames += 1
  }

  get diagnostics(): UpscaleDiagnostics {
    return {
      path: this.#path,
      renderWidth: this.#initialized ? this.#kernel.renderWidth : 0,
      renderHeight: this.#initialized ? this.#kernel.renderHeight : 0,
      displayWidth: this.#initialized ? this.#kernel.displayWidth : 0,
      displayHeight: this.#initialized ? this.#kernel.displayHeight : 0,
      phase: this.#phase,
      phaseCount:
        this.#initialized && this.#path === 'temporal'
          ? this.#kernel.jitterPhaseCount
          : 1,
      frames: this.#frames,
      resets: this.#resets,
      workingTextureBytes: this.#bytes,
      initMs: this.#initMs,
      gpuTimings: this.#initialized
        ? Object.fromEntries(this.#kernel.gpuTimings)
        : {},
      debug: this.#debug,
    }
  }

  #timer(): RawTimer | null {
    return (
      (this.#kernel as unknown as { _timer?: RawTimer | null })._timer ?? null
    )
  }

  override dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stopTiming?.()
    this.#detach?.()
    if (this.#initialized) this.#kernel.dispose()
    this.#pre.dispose()
    this.#standIn.dispose()
    if (this.#path === 'temporal') velocity.setProjectionMatrix(null)
    super.dispose()
  }
}

export const createUpscale = (
  renderer: WebGPURenderer,
  inputs: UpscaleInputs,
  camera: Camera,
  options: {
    path: Exclude<UpscalePath, 'guides'>
    ratio: number
    sharpness: number
  },
): UpscaleNode => new UpscaleNode(renderer, inputs, camera, options)
