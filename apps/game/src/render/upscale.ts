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
  #debug: PictureDebug = 'none'

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
      const start = performance.now()
      this.#kernel.init()
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
      this.#initMs = performance.now() - start
      this.#initialized = true
    }
    this.#renderer.getDrawingBufferSize(this.#size)
    const width = Math.max(1, Math.floor(this.#size.x / this.#ratio))
    const height = Math.max(1, Math.floor(this.#size.y / this.#ratio))
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
    // Count the library's raw allocations too; renderer.info cannot see them.
    device.createTexture = (descriptor) => {
      const gpu = create(descriptor)
      const formats: Partial<Record<GPUTextureFormat, number>> = {
        rgba16float: 8,
        r32float: 4,
        rgba8unorm: 4,
        r8unorm: 1,
      }
      const pixelBytes = formats[gpu.format]
      if (pixelBytes === undefined)
        throw new Error(`Unaccounted upscaler texture format: ${gpu.format}`)
      bytes += gpu.width * gpu.height * gpu.depthOrArrayLayers * pixelBytes
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
    this.#bytes = bytes
    this.outputTexture.value = this.#kernel.outputTexture
    this.#phase = 0
    this.#resets += 1
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
    this.#kernel.settings.exposure = Math.max(
      1e-4,
      Math.min(65504, conditioning),
    )
    if (this.#preData[0] !== Math.fround(preExposure)) {
      this.#preData[0] = preExposure
      this.#pre.needsUpdate = true
    }
    this.#renderer.initTexture(this.#pre)
    // Three normally sets these just before the scene draw, which is too late
    // for the first jitter-free projection captured here.
    this.#camera.coordinateSystem = this.#renderer.coordinateSystem
    ;(this.#camera as unknown as { _reversedDepth: boolean })._reversedDepth =
      this.#renderer.reversedDepthBuffer
    this.#kernel.beginFrame(this.#camera)
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

  override dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
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
