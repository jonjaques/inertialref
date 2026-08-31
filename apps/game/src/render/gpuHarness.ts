import {
  type Camera,
  type ComputeNode,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Object3D,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  setConsoleFunction,
  type StorageBufferAttribute,
  UnsignedByteType,
  WebGPURenderer,
} from 'three/webgpu'

/*
 * A `WebGPURenderer` on the real GPU, in Node — `pnpm test:gpu`.
 *
 * Imported only by `*.gpu.test.ts`, so it is tree-shaken out of the client.
 * The globals `three/webgpu` reads at import time are `gpuSetup.ts`, a vitest
 * setup file rather than an import from here, because a function cannot run
 * before its own module's imports.
 *
 * What this owns is the four things that cost a round trip each to learn, so
 * a test does not have to know them:
 *
 *  - **Nothing here waits for a frame.** The animation frame installed by the
 *    setup file never fires, and every draw is an explicit `render()` into a
 *    `RenderTarget`. A test that waits for a rAF tick is a test that hangs.
 *  - **A pixel readback is padded.** `readRenderTargetPixelsAsync` returns the
 *    mapped staging buffer as-is, and WebGPU aligns every row of it to 256
 *    bytes — so a 64-wide RGBA8 target reads back with the second row starting
 *    at element 256, not 256 bytes in. `Pixels` unpacks that, and puts row 0
 *    at the **top**, which is where WebGPU's texture origin is and the
 *    opposite of what `gl.readPixels` trained everyone to expect.
 *  - **A pipeline that will not build does not reject, on either path.** A
 *    draw builds pipelines synchronously inside the backend's own validation
 *    scope and reports the failure through three's console sink;
 *    `compileAsync` builds them with `createRenderPipelineAsync`, whose
 *    *rejection* carries the failure — and the backend catches that rejection
 *    and discards it, so its scope pops clean and the sink hears nothing.
 *    Either way the pipeline is marked broken and the first draw with it is
 *    what fails, which is the `[Invalid RenderPipeline]` a browser shows as a
 *    canvas that never presents. `warmCompile` in `warmup.ts` swallows even
 *    that. So every verb here runs inside a validation scope of its own,
 *    which catches the shader module Tint refused *before* the pipeline that
 *    would have used it, and listens on the sink as well; a failure on
 *    either channel is a red test with the compiler's message in it.
 *  - **`compileAsync` and `getShaderAsync` take their arguments in opposite
 *    orders** — `(object, camera, scene)` and `(scene, camera, object)`. Both
 *    are wrapped here in the `WarmRenderer` order, so a `GpuSession`'s
 *    `renderer` satisfies `warmup.ts` structurally and a warm-up can be
 *    exercised against the real backend.
 */

/** One line three routed through its console sink while a verb ran. */
export interface GpuMessage {
  readonly type: 'log' | 'warn' | 'error'
  readonly message: string
}

/** A readback, unpadded, with row 0 at the top of the image. */
export interface Pixels {
  readonly width: number
  readonly height: number
  /** RGBA, row-major, tightly packed. `Uint8Array` for an 8-bit target. */
  readonly data: Float32Array | Uint8Array
  /** The four channels at (x, y), y down from the top. */
  at(x: number, y: number): [number, number, number, number]
}

export interface DrawOptions {
  readonly width?: number
  readonly height?: number
  /**
   * `rgba32float` rather than `rgba8unorm`. The default quantizes to 1/255,
   * which is the floor on any assertion made against it; a claim about the
   * arithmetic wants a float target, where the honest bound is f32's.
   */
  readonly float?: boolean
  /**
   * Draw into this target rather than a fresh one, and leave it alone after.
   * A pipeline is keyed on the attachment it draws into as well as on the
   * material, so a test about *which* pipeline a frame uses has to hold the
   * target still between a compile and a draw.
   */
  readonly into?: RenderTarget
}

export interface GpuSession {
  readonly renderer: WebGPURenderer
  /**
   * Draw `graph` as the fragment of a screen-filling quad and read it back.
   * The graph is written to the target verbatim — no tone curve, no colour
   * space transform — so what comes back is the graph's own value, and `uv()`
   * runs 0 → 1 across it with `v` up.
   */
  drawGraph(graph: Node, options?: DrawOptions): Promise<Pixels>
  /** Render a scene into a target and read it back. */
  draw(scene: Scene, camera: Camera, options?: DrawOptions): Promise<Pixels>
  /**
   * Build every pipeline `object` needs, in `WarmRenderer` argument order, and
   * reject with the backend's message if one will not build.
   */
  compile(object: Object3D, camera: Camera, scene: Scene): Promise<void>
  /** The WGSL a draw of `object` in `scene` compiles. */
  shader(
    object: Object3D,
    camera: Camera,
    scene: Scene,
  ): Promise<{ vertexShader: string; fragmentShader: string }>
  /** Dispatch a compute node and wait for it. */
  compute(kernel: ComputeNode): Promise<void>
  /** Copy a storage buffer back; a fresh `ArrayBuffer`, not a mapped one. */
  readBuffer(buffer: StorageBufferAttribute): Promise<ArrayBuffer>
  /**
   * Everything three warned about since the last call, drained. A warning is
   * not a failure here — the node builder warns about a missing attribute and
   * compiles anyway — but a test about attributes wants to assert on exactly
   * that, and an unread warning is a silent one.
   */
  warnings(): GpuMessage[]
  dispose(): void
}

/**
 * The canvas the renderer insists on being handed.
 *
 * `getContext('webgpu')` has to answer with something `configure` can be called
 * on, because `init()` configures the swap chain unconditionally. What it must
 * not do is hand back a texture: a test that forgets `setRenderTarget` would
 * otherwise draw into a plausible-looking dummy and read back zeros from the
 * target it never rendered to. It throws instead, and the message names the
 * fix.
 */
function canvasStub(width: number, height: number): HTMLCanvasElement {
  const stub = {
    width,
    height,
    style: {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    getContext(kind: string) {
      if (kind !== 'webgpu') return null
      return {
        configure() {},
        unconfigure() {},
        getCurrentTexture(): never {
          throw new Error(
            'gpuHarness: there is no swap chain here — render into a RenderTarget (setRenderTarget) or use draw()/drawGraph()',
          )
        },
      }
    },
  }
  return stub as unknown as HTMLCanvasElement
}

/**
 * Unpack a padded readback.
 *
 * `readRenderTargetPixelsAsync` hands back the mapped staging buffer whole. Its
 * rows are `bytesPerRow` apart, where that is the tight row rounded up to 256
 * bytes, and only the last row is tight (three sizes the buffer to end there).
 * The stride is recomputed from the same rule rather than trusted from the
 * array's length, because the length alone cannot distinguish a padded 8-wide
 * target from a tight 64-wide one.
 */
function unpad(
  raw: Float32Array | Uint8Array,
  width: number,
  height: number,
): Pixels {
  const channels = 4
  const bytesPerTexel = raw.BYTES_PER_ELEMENT * channels
  const bytesPerRow = Math.ceil((width * bytesPerTexel) / 256) * 256
  const stride = bytesPerRow / raw.BYTES_PER_ELEMENT
  const tight = width * channels
  const data =
    raw instanceof Float32Array
      ? new Float32Array(tight * height)
      : new Uint8Array(tight * height)
  for (let row = 0; row < height; row += 1) {
    data.set(raw.subarray(row * stride, row * stride + tight), row * tight)
  }
  return {
    width,
    height,
    data,
    at(x, y) {
      const i = (y * width + x) * channels
      return [
        data[i] as number,
        data[i + 1] as number,
        data[i + 2] as number,
        data[i + 3] as number,
      ]
    },
  }
}

const DEFAULT_SIZE = 64

export async function openGpu(
  width = DEFAULT_SIZE,
  height = DEFAULT_SIZE,
): Promise<GpuSession> {
  const messages: GpuMessage[] = []
  setConsoleFunction((type, message) => {
    messages.push({ type, message: String(message) })
  })

  const renderer = new WebGPURenderer({
    antialias: false,
    canvas: canvasStub(width, height),
  })
  renderer.setSize(width, height, false)
  await renderer.init()
  /*
   * There is no `forceWebGPU`; the renderer takes WebGPU when `navigator.gpu`
   * answers and falls back to WebGL 2 when it does not. The fallback here
   * would mean the setup file did not run, and it would fail later and worse —
   * on a `document` this process deliberately does not have — so it is named
   * now instead.
   */
  const backend = renderer.backend as {
    isWebGPUBackend?: boolean
    device?: GPUDevice
  }
  if (backend.isWebGPUBackend !== true || backend.device === undefined) {
    throw new Error(
      'gpuHarness: the renderer took the WebGL fallback — navigator.gpu is absent, so gpuSetup.ts did not run before three/webgpu was imported',
    )
  }
  // Not a public path, and the one thing read off it is the error scope —
  // the only place a refused shader module is reported at all.
  const device = backend.device

  /*
   * The quad `drawGraph` fills the target with: a plane two units wide in
   * front of an orthographic camera one unit deep. Not `QuadMesh`, whose
   * geometry is built for post-processing and puts `v = 0` at the *top*; a
   * graph author reading `uv()` expects what the production geometries carry,
   * which is `v` up.
   */
  const quad = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial())
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  quadCamera.position.z = 0.5
  quadCamera.updateMatrixWorld()
  const quadScene = new Scene()
  quadScene.add(quad)
  // The loop the constructor bound never gets a second frame (the setup file's
  // `requestAnimationFrame` returns 0); this says so in the renderer's own
  // terms as well, so nothing reads `getAnimationLoop()` and expects one.
  renderer.setAnimationLoop(null)

  /**
   * Run a verb with the sink watched, and throw the first error it reported.
   *
   * The backend reports a broken pipeline from a `.then` on `popErrorScope`,
   * which lands on a later turn of the event loop than the call that built it.
   * Every verb here awaits GPU work — a readback, a compile — that resolves
   * later still, so by the time `work` settles the report has landed.
   */
  async function watched<T>(work: () => Promise<T>): Promise<T> {
    const from = messages.length
    /*
     * The scope is outermost: the backend pushes and pops its own inside
     * `createRenderPipeline`, and scopes nest, so what reaches this one is
     * everything the backend did not claim — `createShaderModule` above all,
     * which it never brackets. Popped after the work settles rather than in a
     * `finally`, because an unbalanced pop on a device that threw is a second
     * error hiding the first.
     */
    device.pushErrorScope('validation')
    const result = await work()
    const scoped = await device.popErrorScope()
    if (scoped !== null) {
      throw new Error(`gpuHarness: the device reported: ${scoped.message}`)
    }
    const failure = messages.slice(from).find((entry) => entry.type === 'error')
    if (failure !== undefined) {
      throw new Error(`gpuHarness: the backend reported: ${failure.message}`)
    }
    return result
  }

  function target(options: DrawOptions): RenderTarget {
    return new RenderTarget(options.width ?? width, options.height ?? height, {
      depthBuffer: false,
      type: options.float === true ? FloatType : UnsignedByteType,
    })
  }

  async function readback(rt: RenderTarget): Promise<Pixels> {
    const raw = (await renderer.readRenderTargetPixelsAsync(
      rt,
      0,
      0,
      rt.width,
      rt.height,
    )) as Float32Array | Uint8Array
    return unpad(raw, rt.width, rt.height)
  }

  return {
    renderer,

    drawGraph(graph, options = {}) {
      return watched(async () => {
        // A fresh material per graph, never a mutated one: the backend caches
        // shader source per material instance, and a `fragmentNode` swapped on
        // a compiled material draws with the pipeline it already had.
        const material = new MeshBasicNodeMaterial()
        material.fragmentNode = graph
        quad.material = material
        const rt = options.into ?? target(options)
        renderer.setRenderTarget(rt)
        renderer.render(quadScene, quadCamera)
        const pixels = await readback(rt)
        renderer.setRenderTarget(null)
        if (options.into === undefined) rt.dispose()
        material.dispose()
        return pixels
      })
    },

    draw(scene, camera, options = {}) {
      return watched(async () => {
        const rt = options.into ?? target(options)
        renderer.setRenderTarget(rt)
        renderer.render(scene, camera)
        const pixels = await readback(rt)
        renderer.setRenderTarget(null)
        if (options.into === undefined) rt.dispose()
        return pixels
      })
    },

    compile(object, camera, scene) {
      return watched(async () => {
        await renderer.compileAsync(object, camera, scene)
      })
    },

    shader(object, camera, scene) {
      return watched(async () => {
        const { vertexShader, fragmentShader } =
          await renderer.debug.getShaderAsync(scene, camera, object)
        // Null is "no program was built", which for a mesh in a scene means
        // the object was culled or invisible — a question, not a shader.
        if (vertexShader === null || fragmentShader === null) {
          throw new Error(
            'gpuHarness: no shader was built for the object — is it visible, in the scene, and in front of the camera?',
          )
        }
        return { vertexShader, fragmentShader }
      })
    },

    compute(kernel) {
      return watched(() => renderer.computeAsync(kernel))
    },

    readBuffer(buffer) {
      return watched(() => renderer.getArrayBufferAsync(buffer))
    },

    warnings() {
      const drained = messages.filter((entry) => entry.type === 'warn')
      messages.length = 0
      return drained
    },

    dispose() {
      renderer.dispose()
      setConsoleFunction(
        null as unknown as Parameters<typeof setConsoleFunction>[0],
      )
    },
  }
}
