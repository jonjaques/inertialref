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
import { breathe } from './warmup.ts'

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
 *    bytes — so an 8-wide RGBA8 target, whose rows are 32 bytes, reads back
 *    with the second row starting at element 256. Only a width whose row is
 *    already a multiple of 256 escapes it, which the 64-wide default happens
 *    to be, so the default size is the one that proves nothing. `Pixels`
 *    unpacks the padding, and puts row 0 at the **top**, which is where
 *    WebGPU's texture origin is and the opposite of what `gl.readPixels`
 *    trained everyone to expect.
 *  - **A pipeline that will not build does not reject, on either path.** A
 *    draw builds pipelines synchronously inside the backend's own validation
 *    scope and reports the failure through three's console sink;
 *    `compileAsync` builds them with `createRenderPipelineAsync` after its
 *    walk, catches the rejection, marks the pipeline broken and reports that
 *    through the sink too — the promise it hands back resolves either way.
 *    The first draw with a broken pipeline draws nothing, which is the
 *    `[Invalid RenderPipeline]` a browser shows as a canvas that never
 *    presents. `warmCompile` in `warmup.ts` swallows even that. So every
 *    verb here runs inside a validation scope of its own, which catches the
 *    shader module Tint refused *before* the pipeline that would have used
 *    it, and listens on the sink as well; a failure on either channel is a
 *    red test with the compiler's message in it.
 *  - **`compileAsync` and `getShaderAsync` take their arguments in opposite
 *    orders** — `(object, camera, scene)` and `(scene, camera, object)`. Both
 *    verbs here take the `WarmRenderer` order, so one call site cannot mean
 *    two things.
 *  - **A compile that walked nothing still resolves.** `compileAsync` skips an
 *    invisible object, and it culls against the camera's frustum — so an
 *    object out of view builds no pipeline at all and resolves exactly like
 *    one that built everything. `compile` refuses an invisible object and
 *    turns culling off for the walk. A pipeline count cannot stand in for
 *    either, because three caches a pipeline across material instances: the
 *    second identical compile in a file legitimately builds none.
 *  - **The clear is the production clear, opaque black.** three's default
 *    clear alpha is 0, and r185's `renderOutput` premultiplies — so through
 *    the renderer's own output path an alpha-0 pixel comes out black however
 *    bright its rgb was, and a gate holding the chain to the renderer's own
 *    frame compared black sprites to lit ones until the two clears matched.
 *    `createRenderer` clears opaque, and so does the session. Two things
 *    follow: an empty pixel reads back as `(0, 0, 0, 255)` in an 8-bit
 *    target, so a claim that a frame drew nothing is a claim about the color
 *    channels; and a test about what a chain does with alpha sets its own
 *    clear and puts this one back.
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
   * Draw into this target rather than a fresh one, and leave it alone after —
   * undisposed, and still the renderer's target if it was before the call. A
   * pipeline is keyed on the attachment it draws into as well as on the
   * material, so a test about *which* pipeline a frame uses has to hold the
   * target still between a compile and a draw, and a verb that reset the
   * renderer to the swap chain on its way out would break exactly that.
   *
   * Only `RGBA8` and `RGBA32F` come back readable: `unpad` reads the element
   * type off the staging buffer and rejects anything else rather than
   * truncating it into a plausible-looking `Uint8Array`.
   */
  readonly into?: RenderTarget
}

export interface GpuSession {
  readonly renderer: WebGPURenderer
  /**
   * Draw `graph` as the fragment of a screen-filling quad and read it back.
   * The graph is written to the target verbatim — no tone curve, no color
   * space transform — so what comes back is the graph's own value, and `uv()`
   * runs 0 → 1 across it with `v` up.
   */
  drawGraph(graph: Node, options?: DrawOptions): Promise<Pixels>
  /** Render a scene into a target and read it back. */
  draw(scene: Scene, camera: Camera, options?: DrawOptions): Promise<Pixels>
  /**
   * Read a target something else drew into — the chain, the renderer's own
   * output path — with the same unpadding `draw` applies to its own.
   */
  read(target: RenderTarget): Promise<Pixels>
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
   * Everything three warned about since the last call, drained — and only the
   * warnings. A warning is not a failure here — the node builder warns about a
   * missing attribute and compiles anyway — but a test about attributes wants
   * to assert on exactly that, and an unread warning is a silent one. Errors
   * are left where they are, because the next verb is what fails on them.
   */
  warnings(): GpuMessage[]
  /**
   * Render pipelines built at the device since the session opened.
   *
   * The one observation that separates "compiled everything" from "walked
   * nothing", and the one place `backend.device` is reached for, so a test
   * about a warm-up does not have to reach for it too.
   */
  pipelinesBuilt(): number
  /**
   * Hold the next render pipeline the device is asked to build asynchronously.
   *
   * `compileAsync` registers a pipeline in the backend's cache when it asks
   * the device for it and fills in the GPU object when the promise resolves.
   * A frame drawn in between finds the entry without the object, and
   * `Renderer._renderObjectDirect` draws nothing for it — `Pipelines.isReady`
   * gates the backend's draw. The window is real and microseconds wide, so a
   * test that wants to draw inside it holds the promise open: `requested`
   * resolves once the constructor has been called — the cache entry exists,
   * the object does not — and `release()` lets the pipeline land.
   *
   * One hold at a time, and it is the session's. A second call while one is
   * armed throws rather than replacing it, and `release()` disarms a hold
   * nothing consumed: a compile that walked nothing, or hit the cache, asks
   * the device for no pipeline, and a hold left armed catches the next test's
   * first async build and holds it for that test's whole timeout — measured
   * as a 3,001 ms hang against a 3 ms control. So `release()` belongs in a
   * `finally`. After it, await the compile before the next verb: three pops
   * its own error scope around the pipeline over the next few microtasks, and
   * a verb's scope pushed inside that window nests under it.
   */
  holdNextPipeline(): { readonly requested: Promise<void>; release(): void }
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
  /*
   * Both assumptions are checked rather than trusted. `bytesPerTexel` is
   * four channels of whatever the staging buffer's element is, which is true
   * of `rgba8unorm` and `rgba32float` and of nothing else three can hand back:
   * a `HalfFloatType` target arrives as a `Uint16Array` and would be copied
   * element-wise into a `Uint8Array`, truncating every value mod 256 into
   * numbers that look like pixels. The length check catches the rest — a
   * single-channel target, where `bytesPerTexel` is four times the real row.
   */
  // Widened deliberately: the declared type says two, and the point of the
  // check is the third that three can actually hand back.
  const kind = (raw as ArrayBufferView).constructor.name
  if (!(raw instanceof Float32Array) && !(raw instanceof Uint8Array)) {
    throw new Error(
      `gpuHarness: a readback came back as ${kind} — only an UnsignedByteType or FloatType RGBA target reads back here`,
    )
  }
  const channels = 4
  const bytesPerTexel = raw.BYTES_PER_ELEMENT * channels
  const bytesPerRow = Math.ceil((width * bytesPerTexel) / 256) * 256
  const stride = bytesPerRow / raw.BYTES_PER_ELEMENT
  const tight = width * channels
  const expected = (height - 1) * stride + tight
  if (raw.length !== expected) {
    throw new Error(
      `gpuHarness: a ${width}×${height} readback is ${raw.length} elements where a padded RGBA one is ${expected} — the target is not RGBA`,
    )
  }
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
      /*
       * Bounds-checked, because the flat index wraps instead of failing:
       * `at(width, 0)` is `at(0, 1)`, a real and plausible RGBA tuple, so a
       * loop written `x <= width` or an assertion about the right-hand column
       * reads the next row's left edge and passes for the wrong reason. Past
       * the last row the reads are `undefined` behind an `as number` cast and
       * the arithmetic downstream quietly becomes NaN.
       */
      if (x < 0 || x >= width || y < 0 || y >= height) {
        throw new RangeError(
          `gpuHarness: (${x}, ${y}) is outside a ${width}×${height} readback`,
        )
      }
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
  /*
   * Before the renderer, because after it is too late. There is no
   * `forceWebGPU`: the renderer takes WebGPU when `navigator.gpu` answers and
   * WebGL 2 when it does not, and the WebGL backend dies inside `init()` on
   * the canvas stub — `Cannot read properties of null (reading
   * 'getSupportedExtensions')`, an error about extensions thrown by a call
   * about devices. A check after `init()` never runs. The only thing that
   * makes `navigator.gpu` absent here is `gpuSetup.ts` not having run before
   * `three/webgpu` was imported, so that is what the message says.
   */
  if (globalThis.navigator?.gpu === undefined) {
    throw new Error(
      'gpuHarness: navigator.gpu is absent, so gpuSetup.ts did not run before three/webgpu was imported — this file is reachable only from a *.gpu.test.ts under `pnpm test:gpu`',
    )
  }

  const messages: GpuMessage[] = []
  // Every argument, not just the first: three's sink is
  // `(type, 'THREE.' + head, ...rest)` and the backend routinely puts the
  // value in `rest` — `error('WebGPURenderer: Invalid blending: ', blending)`.
  // Keeping only `head` turns a failure that names a number into one that
  // names a category.
  setConsoleFunction((type, ...parts) => {
    messages.push({ type, message: parts.map(String).join(' ') })
  })

  const renderer = new WebGPURenderer({
    antialias: false,
    canvas: canvasStub(width, height),
    /*
     * The game's renderer sets this (`createRenderer.ts`), and it is not a
     * property of the frame: `NodeMaterial.setupDepth` writes
     * `viewZToLogarithmicDepth` into the fragment stage of every material
     * that declares no `depthNode`, so a harness without it compiles a
     * program with no `frag_depth` where the game compiles one with it.
     * Measured: `createStarMaterial`'s fragment shader carries `frag_depth`
     * only with this set. A suite that says "every production material
     * compiles" has to compile the production program.
     */
    logarithmicDepthBuffer: true,
  })
  renderer.setSize(width, height, false)
  await renderer.init()
  // Opaque black, the way `createRenderer` clears — see the file comment.
  renderer.setClearColor(0x000000, 1)
  const backend = renderer.backend as {
    isWebGPUBackend?: boolean
    device?: GPUDevice
  }
  // The belt to the brace above: `navigator.gpu` answering is not the same as
  // the backend having a device, and everything below reads one.
  if (backend.isWebGPUBackend !== true || backend.device === undefined) {
    throw new Error(
      'gpuHarness: the renderer did not come up on the WebGPU backend, so there is no device to run a verb against',
    )
  }
  // Not a public path, and it is read for two things nothing public exposes:
  // the error scope, which is the only place a refused shader module is
  // reported at all, and the pipeline constructors, which are the only place
  // "this compile built nothing" can be observed.
  const device = backend.device

  /*
   * Pipelines built since the session opened.
   *
   * Counted at the device because that is the one place a pipeline cannot be
   * built without passing through — and because a compile that walked nothing
   * resolves exactly like one that walked everything. The constructors are
   * replaced once, here, so no test has to reach for `backend.device` itself.
   */
  let pipelines = 0
  /*
   * An armed hold: the next async build resolves `requested` at call time
   * and hands three a promise that lands only after `release`. Three awaits
   * the pipeline inside its own validation scope, so a draw made while the
   * hold is on reports into that scope rather than into a verb's; the draw
   * the guard skips reports nothing, which is the claim being tested.
   */
  let hold: { requested: () => void; released: Promise<void> } | null = null
  const createSync = device.createRenderPipeline.bind(device)
  const createAsync = device.createRenderPipelineAsync.bind(device)
  device.createRenderPipeline = (descriptor) => {
    pipelines += 1
    return createSync(descriptor)
  }
  device.createRenderPipelineAsync = (descriptor) => {
    pipelines += 1
    const built = createAsync(descriptor)
    if (hold === null) return built
    const { requested, released } = hold
    hold = null
    requested()
    return built.then((pipeline) => released.then(() => pipeline))
  }

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

  /*
   * Let the reports that follow a failure land, and drop them.
   *
   * A pipeline that will not build is reported three times over, on three
   * different turns: the shader module, in the verb's own scope, at once; the
   * pipeline, from the `.then` on three's inner scope, a turn later; and the
   * compiler's diagnostics, once `getCompilationInfo()` has resolved, later
   * still. The verb throws on the first. The other two describe the same
   * failure and would arrive during whatever verb runs next, which would then
   * fail for a shader it never touched — so a verb that failed waits until
   * the sink has been quiet for three turns and discards what came in since
   * it began. Its own warnings go with them, which a test about a failure
   * has no use for.
   *
   * Three quiet turns is two more than the worst measured: the last report
   * lands on the turn after the pop, or the one after that. The fifty-turn
   * cap is for a sink that never goes quiet, which nothing here produces;
   * past it the verb stops waiting, silently, and whatever is still coming
   * lands in the next verb — the failure this reduces rather than removes.
   * Asking the device for the compilation info here, to await it instead of
   * waiting it out, does not work: the device answers in order, so the
   * harness's request resolves ahead of three's and says nothing about when
   * three's report lands. On the async `compile` path the wait is pure cost
   * — `compileAsync` awaits the diagnostics before it resolves — and it is
   * paid rather than special-cased, because a verb is not told which path
   * failed. The splice assumes verbs run one at a time, which every test
   * here does.
   */
  async function settleLateReports(from: number): Promise<void> {
    let quiet = 0
    for (let turn = 0; turn < 50 && quiet < 3; turn += 1) {
      const seen = messages.length
      await breathe()
      quiet = messages.length === seen ? quiet + 1 : 0
    }
    messages.splice(from)
  }

  /** The one exit every failing path takes: the late reports land, then the throw. */
  async function fail(from: number, failure: unknown): Promise<never> {
    await settleLateReports(from)
    throw failure
  }

  /**
   * Run a verb with the sink watched, and throw the first error it reported.
   *
   * What the sink holds when `work` settles is the shader module's refusal
   * and the pipeline's: the backend reports the pipeline from a `.then` on
   * `popErrorScope`, a turn after the call that built it, and every verb here
   * awaits GPU work — a readback, a compile — that resolves later still. What
   * it does not yet hold is the compiler's diagnostics, which follow
   * `getCompilationInfo()` later again; `settleLateReports` is for those.
   * Measured at the outer pop, seventeen times of seventeen: the pipeline
   * report is in the sink and none of the diagnostics are.
   */
  async function watched<T>(work: () => Promise<T>): Promise<T> {
    const from = messages.length
    /*
     * The scope is outermost: the backend pushes and pops its own inside
     * `createRenderPipeline`, and scopes nest, so what reaches this one is
     * everything the backend did not claim — `createShaderModule` above all,
     * which it never brackets.
     *
     * Popped on both paths and popped exactly once — which is why the two
     * pops are written out rather than shared in a `finally`: only the
     * succeeding one has an error worth reading, so a device that threw still
     * reports its own failure instead of the scope's. Skipping the pop on the
     * throwing path is what unbalances the stack: the scope outlives the verb,
     * sits under every later one, and quietly captures every error raised
     * *between* verbs — the silent channel this whole wrapper exists to close.
     */
    device.pushErrorScope('validation')
    let result: T
    try {
      result = await work()
    } catch (failure) {
      await device.popErrorScope().catch(() => null)
      return fail(from, failure)
    }
    const scoped = await device.popErrorScope()
    if (scoped !== null) {
      return fail(
        from,
        new Error(`gpuHarness: the device reported: ${scoped.message}`),
      )
    }
    /*
     * Since this verb began, and not since the last one looked. A refused
     * shader module is reported twice — once as the module, once as the
     * pipeline that would have used it, a turn later — so a window that
     * reached backwards would fail the *next* verb with the fallout of a
     * rejection a test already caught. The cost of the narrow window is that
     * work run outside a verb reports to nobody: `warmCompile` swallows its
     * rejection by design, so a test that warms through it asserts on the
     * frame instead (`warmup.gpu.test.ts`).
     */
    const failure = messages.slice(from).find((entry) => entry.type === 'error')
    if (failure !== undefined) {
      await settleLateReports(from)
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

  /**
   * Draw into a target and read it back, restoring what was there before.
   *
   * The restore and the dispose are in a `finally` because the alternative is
   * silent: a rejected readback would leave the renderer pointing at a target
   * it also leaked, and `compileAsync` and `getShaderAsync` both key their
   * render context — and therefore the pipeline — on `renderer._renderTarget`.
   * One failed draw would change what every later verb in the file measures,
   * and the file would still be green. The previous target is restored rather
   * than nulled so that `into` means what it says: a caller holding a target
   * still across a compile and a draw gets to keep it.
   */
  async function renderInto(
    scene: Scene,
    camera: Camera,
    options: DrawOptions,
  ): Promise<Pixels> {
    const previous = renderer.getRenderTarget()
    const rt = options.into ?? target(options)
    try {
      renderer.setRenderTarget(rt)
      renderer.render(scene, camera)
      return await readback(rt)
    } finally {
      renderer.setRenderTarget(previous)
      if (options.into === undefined) rt.dispose()
    }
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
        try {
          return await renderInto(quadScene, quadCamera, options)
        } finally {
          material.dispose()
        }
      })
    },

    draw(scene, camera, options = {}) {
      return watched(() => renderInto(scene, camera, options))
    },

    read(target) {
      return watched(() => readback(target))
    },

    compile(object, camera, scene) {
      return watched(async () => {
        /*
         * A compile that walked nothing resolves exactly like one that walked
         * everything, and there are two ways to walk nothing.
         *
         * **Invisible** is the one `warmCompile` exists to own, and here it is
         * a mistake rather than a state to toggle around: a test that means to
         * compile something says so.
         *
         * **Culled** is the one nothing warns about. `compileAsync` fills the
         * frustum from the camera and `_projectObject` tests every object
         * against it, so a sphere behind the camera builds no pipeline and
         * resolves as if it had. Culling is off for the walk and restored
         * after, because a compile is a question about the program and not
         * about where the object is standing.
         */
        if (!object.visible) {
          throw new Error(
            'gpuHarness: the object is invisible, and `compileAsync` walks straight past it — make it visible, the way `warmCompile` does',
          )
        }
        const restore: Object3D[] = []
        object.traverse((node) => {
          if (!node.frustumCulled) return
          node.frustumCulled = false
          restore.push(node)
        })
        try {
          await renderer.compileAsync(object, camera, scene)
        } finally {
          for (const node of restore) node.frustumCulled = true
        }
      })
    },

    shader(object, camera, scene) {
      return watched(async () => {
        const { vertexShader, fragmentShader } =
          await renderer.debug.getShaderAsync(scene, camera, object)
        /*
         * Emptiness as well as null, and emptiness is the one that happens.
         * `getShaderAsync` reaches past the render list —
         * `_objects.get(...).getNodeBuilderState()` builds the state whether
         * or not the object survived culling — so it answers for an invisible
         * object as readily as a drawn one, and the null the types allow is
         * not a case r185 produces. What it cannot do is answer for an object
         * whose material built no program.
         */
        if (!vertexShader || !fragmentShader) {
          throw new Error(
            'gpuHarness: the object built an empty program — does its material have a graph on it?',
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
      /*
       * Warnings only. Clearing the whole log took `error` entries with it,
       * including one the backend had just reported and no verb had read yet
       * — and the caller cannot tell, because a drained error looks exactly
       * like a compile that went well.
       */
      const drained: GpuMessage[] = []
      const kept: GpuMessage[] = []
      for (const entry of messages) {
        ;(entry.type === 'warn' ? drained : kept).push(entry)
      }
      messages.length = 0
      for (const entry of kept) messages.push(entry)
      return drained
    },

    pipelinesBuilt() {
      return pipelines
    },

    holdNextPipeline() {
      if (hold !== null) {
        throw new Error(
          'gpuHarness: a pipeline hold is already armed — release it before arming another',
        )
      }
      let requested: () => void = () => {}
      let release: () => void = () => {}
      const called = new Promise<void>((resolve) => {
        requested = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const armed = { requested, released }
      hold = armed
      return {
        requested: called,
        release() {
          // Still armed means nothing asked for a pipeline: disarm it, so
          // the next build is not the one held.
          if (hold === armed) hold = null
          release()
        },
      }
    },

    dispose() {
      // A hold a test left armed must not outlive the session that armed it.
      hold = null
      // The quad is the session's, so the session ends it: `renderer.dispose`
      // releases the backend and nothing else, and a geometry left undisposed
      // is a device buffer the fork carries to exit.
      quad.geometry.dispose()
      if (!Array.isArray(quad.material)) quad.material.dispose()
      renderer.dispose()
      setConsoleFunction(
        null as unknown as Parameters<typeof setConsoleFunction>[0],
      )
    },
  }
}
