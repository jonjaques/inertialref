import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
  type StorageTexture,
  type Texture,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  computeKernel,
  dot,
  exp,
  float,
  Fn,
  globalId,
  If,
  instanceIndex,
  int,
  ivec2,
  length,
  max,
  select,
  storage,
  texture,
  textureStore,
  uint,
  uintBitsToFloat,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import {
  type Extent,
  lensForFov,
  type RenderBody,
  type RenderScene,
  textureBytes,
} from '@inertialref/rendering'
import {
  type Quat,
  Quaternion as Q,
  type Vec3,
  Vec,
} from '@inertialref/spatial'
import {
  type Body,
  formatAddress,
  galaxySeedOf,
  generateSystem,
  MILKY_WAY,
  resolveSystem,
  SOL_ONLY_CATALOG,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import {
  type CloudFrame,
  type CloudFrameInputs,
  cloudFrame,
} from './cloudFrame.ts'
import { traceScreen, viewDirection } from './cloudGeometry.ts'
import { CloudHistory } from './cloudHistory.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  type CloudBudget,
  cloudStorageTexture,
  traceJitter,
} from './cloudNodes.ts'
import type { CloudTraceTextures } from './cloudTrace.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'
import { warmCompute } from './warmup.ts'

/*
 * The history on the GPU, driven the way the system drives it: every frame
 * built by the real `cloudFrame` from a placed Earth and copied in by the
 * real uniform bundle, so the kernels are held to the CPU's own conventions
 * — the sign of the translation, the body-fixed basis, row 0 at the top —
 * rather than to this file's reading of them. The trace is a stand-in kernel
 * writing the trace's two textures at the interleave's texels from an
 * analytic deck: a level cloud layer fixed on the body 2 km over the eye,
 * with a bright patch on it the wind carries. The oracle is that deck,
 * evaluated in float64 at each history pixel's center.
 */

const TIMESTAMPS = await adapterOffers('timestamp-query')

let gpu: GpuSession
let renderer: WebGPURenderer
let device: GPUDevice

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  renderer = gpu.renderer
  device = (renderer.backend as unknown as { device: GPUDevice }).device
})

afterAll(() => {
  gpu.dispose()
})

/** A half float's relative step: what a texel read back from RGBA16F is held to, four of them. */
const HALF = 4 * 2 ** -11
/** A running mean's own rounding: eight updates, each stored as a half float, at most half a step each. */
const MEAN_ROUNDING = 8 * 2 ** -11
/** The design's Bayer order, written out here rather than read from the module under test. */
const PHASES = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
] as const

/* ------------------------------------------------------------------------- */
/* The world: Earth, its records from the universe, and a camera looking up   */
/* ------------------------------------------------------------------------- */

const ROOT = rootSeed('inertialref')

const SOL: ReadonlyMap<string, Body> = (() => {
  const stub = resolveSystem(
    galaxySeedOf(ROOT, MILKY_WAY),
    SOL_ONLY_CATALOG,
    systemId('SOL'),
  )!
  const system = generateSystem(ROOT, MILKY_WAY, stub)
  return new Map(
    [...walkBodies(system)].map((body) => [formatAddress(body.address), body]),
  )
})()
const EARTH = SOL.get('g:milky-way/s:SOL/b:2')!

/** The eye's vertical in render axes; the eye is the render origin. */
const UP = Vec.normalize({ x: 0.3, y: 0.8, z: -0.52 })
/**
 * Over the datum, meters: 900 m under the anvil's base, so cloudFrame's
 * motion rule (a tenth of the eye's height over the nearest boundary, 90 m)
 * stays clear of every step the turning body takes.
 */
const EYE_HEIGHT = 100
/** A turned body, so body-fixed and render axes differ in every component. */
const TURNED: Quat = Q.fromAxisAngle({ x: 0.3, y: -0.5, z: 0.8 }, 0.7)

function earth(orientation: Quat): RenderBody {
  return {
    sunlight: 0.85,
    address: formatAddress(EARTH.address),
    name: EARTH.name,
    kind: EARTH.kind,
    placement: {
      position: Vec.scale(UP, -(EARTH.radius + EYE_HEIGHT)),
      scale: EARTH.radius,
      compression: 1,
      distance: EARTH.radius + EYE_HEIGHT,
      tier: 'surface',
      compressed: false,
      angularRadius: 1.2,
    },
    orientation,
    hasAtmosphere: true,
    terminator: 0.1,
    atmosphereScale: 1.02,
    airTop: 1.015,
    airHeights: { rayleigh: 0.0013, aerosol: 0.0002 },
    limb: 0.25,
    limbFalloff: 0.004,
    trueRadius: EARTH.radius,
    rotationPeriod: EARTH.rotationPeriod,
    flattening: 1,
    figure: null,
    rings: null,
    appearance: EARTH.appearance,
  }
}

function scene(body: RenderBody): RenderScene {
  return {
    camera: { position: Vec.ZERO, orientation: Q.IDENTITY, up: UP },
    horizon: null,
    bodies: [body],
    stars: [
      {
        luminance: 1.6e9,
        sunlight: 1,
        system: 'SOL',
        name: 'Sun',
        placement: {
          position: Vec.scale(
            Vec.normalize({ x: -0.6, y: 0.75, z: 0.28 }),
            1.5e9,
          ),
          scale: 1e6,
          compression: 1e-3,
          distance: 1.5e11,
          tier: 'billboard',
          compressed: true,
          angularRadius: 0.0047,
        },
        color: { r: 1, g: 0.96, b: 0.9 },
        brightness: 1,
      },
    ],
    entities: [],
    structures: [],
    stations: [],
    terrainCandidates: [],
  } as unknown as RenderScene
}

/** Pitched 60° up off a horizontal heading, so every ray of a 65° lens meets the deck. */
const CAMERA: Quat = (() => {
  const heading = Vec.normalize(Vec.cross(UP, { x: 0, y: 0, z: 1 }))
  const forward = Vec.add(
    Vec.scale(heading, Math.cos(Math.PI / 3)),
    Vec.scale(UP, Math.sin(Math.PI / 3)),
  )
  const back = Vec.negate(forward)
  const right = Vec.normalize(Vec.cross(UP, back))
  return Q.fromBasis(right, Vec.cross(back, right), back)
})()

/** 256 × 192: a 64 × 48 trace and a 128 × 96 history. */
const DISPLAY: Extent = { width: 256, height: 192 }
const HISTORY: Extent = { width: 128, height: 96 }
const START = 1000
const DELTA = 1 / 60

interface Step {
  readonly orientation?: Quat
  readonly renderTime?: number
  readonly epoch?: number
  readonly display?: Extent
  readonly levers?: Partial<CloudLevers>
}

function inputs(step: Step = {}): CloudFrameInputs {
  const display = step.display ?? DISPLAY
  return {
    levers: {
      ...DEFAULT_CLOUD_LEVERS,
      on: true,
      scenario: 'anvil',
      ...step.levers,
    },
    scene: scene(earth(step.orientation ?? TURNED)),
    record: (address) => SOL.get(address) ?? null,
    scattering: () => null,
    renderTime: step.renderTime ?? START,
    visibility: false,
    enhanced: false,
    pictureEpoch: step.epoch ?? 0,
    historyKey: 'seed:flight',
    camera: { position: Vec.ZERO, quaternion: CAMERA },
    lens: lensForFov(65),
    css: display,
    render: display,
    delta: DELTA,
  }
}

/* ------------------------------------------------------------------------- */
/* The deck: what the stand-in trace draws, and the oracle it is held to      */
/* ------------------------------------------------------------------------- */

const DECK_HEIGHT = 2000
/**
 * The patch's radius on the deck, meters: fifteen history pixels at the
 * view's center, resolved by the trace's samples two pixels apart, and
 * nothing at the image's edges. The clip holds a pixel to the bilinear
 * current of its neighbors, so it flattens what the trace has not measured:
 * a peak the samples straddle reads 0.25% under the deck at thirteen pixels,
 * and an edge row on a frame that does not sample it is held to the row
 * inside it, clamp-to-edge, 1.6% off where a patch's slope crossed the edge.
 * Both are the clip doing its job; neither is this file's subject.
 */
const PATCH_RADIUS = 400
const BASE = [0.3, 0.35, 0.4] as const
const PATCH = [0.6, 0.5, 0.4] as const
const BLOCKED = [0.02, 0.03, 0.04] as const
/** Km past every ray: the scene ends far beyond the deck, so nothing is occluded. */
const SCENE_END = 60

/** A deck fixed on the body: its plane over the first frame's eye, and a patch the wind carries. */
interface Deck {
  /** Body-fixed unit: the first frame's vertical. */
  readonly normal: Vec3
  /** The first frame's eye, body-fixed meters. */
  readonly origin: Vec3
  /** The patch's center at `time`, body-fixed meters. */
  readonly center: Vec3
  readonly time: number
}

/** The deck where the first frame's forward ray meets it. */
function deckOf(frame: CloudFrame): Deck {
  const origin = frame.served.eye
  const normal = Vec.normalize(origin)
  const forward = frame.camera.forward
  const reach = DECK_HEIGHT / Vec.dot(forward, normal)
  return {
    normal,
    origin,
    center: Vec.add(origin, Vec.scale(forward, reach)),
    time: frame.time,
  }
}

/** The deck as this frame's eye sees it, float64: its height over the eye and the patch eye-relative. */
function aimOf(
  deck: Deck,
  frame: CloudFrame,
): { readonly height: number; readonly patch: Vec3 } {
  const eye = frame.served.eye
  const drift = Vec.scale(frame.served.wind, frame.time - deck.time)
  return {
    height: DECK_HEIGHT - Vec.dot(Vec.sub(eye, deck.origin), deck.normal),
    patch: Vec.sub(Vec.add(deck.center, drift), eye),
  }
}

/** One history texel of the deck, float64. */
interface Texel {
  readonly light: readonly [number, number, number, number]
  readonly distance: number
}

/** The deck at every history pixel's center: what a stationary history converges to. */
function expected(
  deck: Deck,
  frame: CloudFrame,
  gain = 1,
): (x: number, y: number) => Texel {
  const { width, height } = frame.extents.history
  const { right, up, forward, halfTan, aspect } = frame.camera
  const aim = aimOf(deck, frame)
  return (x, y) => {
    const sx = (2 * (x + 0.5)) / width - 1
    const sy = 1 - (2 * (y + 0.5)) / height
    const ray = Vec.normalize(
      Vec.add(
        Vec.add(forward, Vec.scale(right, sx * halfTan * aspect)),
        Vec.scale(up, sy * halfTan),
      ),
    )
    const reach = aim.height / Math.max(Vec.dot(ray, deck.normal), 0.05)
    const miss =
      Vec.length(Vec.sub(Vec.scale(ray, reach), aim.patch)) / PATCH_RADIUS
    const blob = Math.exp(-miss * miss)
    return {
      light: [
        (BASE[0] + PATCH[0] * blob) * gain,
        (BASE[1] + PATCH[1] * blob) * gain,
        (BASE[2] + PATCH[2] * blob) * gain,
        0.7 - 0.4 * blob,
      ],
      distance: reach / 1000,
    }
  }
}

const luminanceOf = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b

/** The patch's centroid, weighted by its light over the deck's, in history pixels. */
function centroid(
  width: number,
  height: number,
  lightAt: (x: number, y: number) => readonly number[],
): { readonly x: number; readonly y: number } {
  const base = luminanceOf(...BASE)
  let sum = 0
  let sx = 0
  let sy = 0
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = lightAt(x, y)
      const excess = Math.max(0, luminanceOf(r!, g!, b!) - base)
      sum += excess
      sx += excess * x
      sy += excess * y
    }
  return { x: sx / sum, y: sy / sum }
}

/* ------------------------------------------------------------------------- */
/* The stand-in trace                                                         */
/* ------------------------------------------------------------------------- */

const NAN_BITS = 0x7fc00000

/**
 * Writes the trace's light and aux as the trace lays them out, at the
 * interleave's texels: trace texel (i, j) samples history pixel
 * (2i + φx, 2j + φy) at its center. The knots are 1 × 1: nothing here reads
 * them.
 */
class StandInTrace {
  readonly #light = cloudStorageTexture(1, 1, 'rgba16float', 'test trace light')
  readonly #aux = cloudStorageTexture(1, 1, 'rgba16float', 'test trace aux')
  readonly #knots = [
    cloudStorageTexture(1, 1, 'rgba16float', 'test knot depth'),
    cloudStorageTexture(1, 1, 'rgba16float', 'test knot light'),
  ] as const
  #extent: Extent = { width: 1, height: 1 }
  readonly phase = uniform(new Vector2())
  readonly seed = uniform(0, 'uint')
  readonly normal = uniform(new Vector3(0, 1, 0))
  readonly height = uniform(DECK_HEIGHT)
  readonly patch = uniform(new Vector3())
  readonly gain = uniform(1)
  /** Meters; the oracle above draws PATCH_RADIUS's. */
  readonly radius = uniform(PATCH_RADIUS)
  /** Each sample's light times 1 ± this, by interleaved gradient noise: the jitter's stand-in. */
  readonly noise = uniform(0)
  /** The light times 1 + ramp·(x, y), across the image's −1…1 axes. */
  readonly ramp = uniform(new Vector2())
  /** The trace texel written as NaN, or (−1, −1). */
  readonly poison = uniform(new Vector2(-1, -1))
  /** ≥ 0: write each texel's own coordinates and this code instead of the deck. */
  readonly code = uniform(-1)
  readonly kernel: ComputeNode

  constructor(uniforms: CloudUniforms) {
    const { size, history } = uniforms.trace
    // A NaN from a uniform's bits, which no compiler can fold; `@types/three`
    // types the bitcast as a node of no type.
    const nan = uintBitsToFloat(
      uniform(NAN_BITS, 'uint'),
    ) as unknown as Node<'float'>
    const body = Fn(() => {
      const texel = globalId.xy as unknown as Node<'uvec2'>
      If(
        float(texel.x).lessThan(size.x).and(float(texel.y).lessThan(size.y)),
        () => {
          const pixel = texel.mul(uint(2)).add(uvec2(this.phase))
          const screen = traceScreen(pixel, vec2(0), history)
          const ray = viewDirection(uniforms.camera, screen)
          const reach = this.height.div(max(dot(ray, this.normal), 0.05))
          const miss = length(ray.mul(reach).sub(this.patch)).div(this.radius)
          const blob = exp(miss.mul(miss).negate())
          const wobble = float(1).add(
            this.noise.mul(traceJitter(texel, this.seed).x.mul(2).sub(1)),
          )
          const lit = vec3(...BASE)
            .add(vec3(...PATCH).mul(blob))
            .mul(this.gain.mul(wobble).mul(dot(this.ramp, screen).add(1)))
          const coded = this.code.greaterThanEqual(0)
          const at = vec2(texel)
          const light = select(
            coded,
            vec4(at, this.code, 0.5),
            vec4(lit, float(0.7).sub(blob.mul(0.4))),
          )
          const air = select(
            coded,
            vec4(this.code.add(1), at, 1),
            vec4(vec3(...BLOCKED).mul(this.gain), reach.div(1000)),
          )
          const depth = select(
            coded,
            vec4(at, this.code.add(2), 9),
            vec4(SCENE_END, reach.div(1000), 0.1, 2),
          )
          const poisoned = at.x
            .equal(this.poison.x)
            .and(at.y.equal(this.poison.y))
          const left = texel.mul(uint(2)).x
          textureStore(this.#light, texel, select(poisoned, vec4(nan), light))
          textureStore(
            this.#aux,
            uvec2(left, texel.y),
            select(poisoned, vec4(nan), air),
          )
          textureStore(this.#aux, uvec2(left.add(1), texel.y), depth)
        },
      )
    })
    this.kernel = computeKernel(body(), [8, 8, 1]).setName('test trace')
  }

  get outputs(): CloudTraceTextures {
    return {
      light: this.#light,
      aux: this.#aux,
      knotDepth: this.#knots[0],
      knotLight: this.#knots[1],
      extent: this.#extent,
    }
  }

  resize(extent: Extent): void {
    if (
      extent.width === this.#extent.width &&
      extent.height === this.#extent.height
    )
      return
    this.#light.setSize(extent.width, extent.height, 1)
    this.#aux.setSize(2 * extent.width, extent.height, 1)
    this.#extent = extent
  }

  aim(deck: Deck, frame: CloudFrame): void {
    const { height, patch } = aimOf(deck, frame)
    this.normal.value.set(deck.normal.x, deck.normal.y, deck.normal.z)
    this.height.value = height
    this.patch.value.set(patch.x, patch.y, patch.z)
  }

  dispatch(three: WebGPURenderer, k: number, seed: number): void {
    const [x, y] = PHASES[k]!
    this.phase.value.set(x, y)
    this.seed.value = seed >>> 0
    three.compute(this.kernel, [
      Math.ceil(this.#extent.width / 8),
      Math.ceil(this.#extent.height / 8),
      1,
    ])
  }

  dispose(): void {
    this.kernel.dispose()
    for (const map of [this.#light, this.#aux, ...this.#knots]) map.dispose()
  }
}

/* ------------------------------------------------------------------------- */
/* Reading a storage texture back                                             */
/* ------------------------------------------------------------------------- */

interface Image {
  readonly width: number
  readonly height: number
  at(x: number, y: number): [number, number, number, number]
}

const READ_TEXELS = 128 * 128

/** One kernel, its source swapped per read: textureLoad, so nothing filters a texel. */
class Reader {
  readonly #out = new StorageBufferAttribute(
    new Float32Array(READ_TEXELS * 4),
    4,
  )
  readonly #source = texture(
    cloudStorageTexture(1, 1, 'rgba16float', 'test read source'),
  )
  readonly #width = uniform(1, 'uint')
  readonly #count = uniform(1, 'uint')
  readonly kernel: ComputeNode

  constructor() {
    const into = storage(this.#out, 'vec4', READ_TEXELS)
    this.kernel = Fn(() => {
      If(instanceIndex.lessThan(this.#count), () => {
        const x = int(instanceIndex.mod(this.#width))
        const y = int(instanceIndex.div(this.#width))
        into.element(instanceIndex).assign(this.#source.load(ivec2(x, y)))
      })
    })().compute(READ_TEXELS)
  }

  async read(map: Texture, extent: Extent): Promise<Image> {
    const { width, height } = extent
    this.#source.value = map
    this.#width.value = width
    this.#count.value = width * height
    await gpu.compute(this.kernel)
    const data = new Float32Array(await gpu.readBuffer(this.#out))
    return {
      width,
      height,
      at(x, y) {
        if (x < 0 || x >= width || y < 0 || y >= height)
          throw new RangeError(`(${x}, ${y}) is outside ${width} × ${height}`)
        const i = (y * width + x) * 4
        return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]
      },
    }
  }
}

let reader: Reader

beforeAll(() => {
  reader = new Reader()
})

/* ------------------------------------------------------------------------- */
/* The rig: the system's loop, for the history and the stand-in trace alone   */
/* ------------------------------------------------------------------------- */

const BUDGET: CloudBudget = {
  slices: 0,
  tiles: 0,
  jump: false,
  sunTexelSteps: 0,
}

/**
 * Run `work` inside a validation scope of the test's own and fail on any
 * error either channel carried: a dispatch is no harness verb.
 */
async function checked<T>(work: () => T): Promise<T> {
  const from = gpu.reported().length
  device.pushErrorScope('validation')
  let result: T
  try {
    result = work()
  } finally {
    const scoped = await device.popErrorScope()
    if (scoped !== null)
      throw new Error(`the device reported: ${scoped.message}`)
  }
  await device.queue.onSubmittedWorkDone()
  expect(
    gpu
      .reported()
      .slice(from)
      .filter((entry) => entry.type === 'error'),
  ).toEqual([])
  return result
}

interface Tamper {
  /** Runs after the frame's uniforms are written and the trace has drawn, before the history. */
  (uniforms: CloudUniforms): void
}

class Rig {
  readonly uniforms = createCloudUniforms()
  readonly trace = new StandInTrace(this.uniforms)
  readonly history = new CloudHistory(this.uniforms, () => this.trace.outputs)
  deck: Deck | null = null
  last: CloudFrame | null = null

  /** One frame as the system draws it: the regime decides the dispatches. */
  async frame(step: Step = {}, tamper?: Tamper): Promise<CloudFrame> {
    const frame = cloudFrame(inputs(step), this.last)
    if (frame === null) throw new Error('no frame: nothing served')
    this.deck ??= deckOf(frame)
    const deck = this.deck
    await checked(() => {
      this.uniforms.write(frame)
      this.trace.resize(frame.extents.trace)
      this.trace.aim(deck, frame)
      if (frame.regime === 'immediate')
        for (let k = 0; k < 4; k += 1) {
          this.trace.dispatch(renderer, k, 4 * frame.frameIndex + k)
          this.history.renderImmediate(renderer, frame, k)
        }
      else {
        this.trace.dispatch(renderer, frame.frameIndex % 4, frame.frameIndex)
        tamper?.(this.uniforms)
        this.history.render(renderer, frame, BUDGET)
      }
    })
    this.last = frame
    return frame
  }

  /** Frames with the same step, `count` of them. */
  async frames(count: number, step: (n: number) => Step = () => ({})) {
    for (let n = 0; n < count; n += 1) await this.frame(step(n))
  }

  /** The newest history, all three textures. */
  async read(): Promise<{
    readonly light: Image
    readonly air: Image
    readonly depth: Image
  }> {
    const { light, air, depth, extent } = this.history.outputs
    return {
      light: await reader.read(light, extent),
      air: await reader.read(air, extent),
      depth: await reader.read(depth, extent),
    }
  }

  dispose(): void {
    this.history.dispose()
    this.trace.dispose()
  }
}

/** Every component of every texel finite. */
function finite(image: Image): boolean {
  for (let y = 0; y < image.height; y += 1)
    for (let x = 0; x < image.width; x += 1)
      if (!image.at(x, y).every(Number.isFinite)) return false
  return true
}

/** The largest relative miss of a history's light against the deck's. */
function worstMiss(
  image: Image,
  deck: (x: number, y: number) => Texel,
): number {
  let worst = 0
  for (let y = 0; y < image.height; y += 1)
    for (let x = 0; x < image.width; x += 1) {
      const got = image.at(x, y)
      const want = deck(x, y).light
      for (let c = 0; c < 4; c += 1)
        worst = Math.max(worst, Math.abs(got[c]! / want[c]! - 1))
    }
  return worst
}

/* ------------------------------------------------------------------------- */
/* The tests                                                                  */
/* ------------------------------------------------------------------------- */

describe('what the history holds', () => {
  it('declares nothing until a frame sizes it, then both parities at one level each, then nothing once disposed', async () => {
    const rig = new Rig()
    expect(rig.history.bytes).toBe(0)
    expect(rig.history.textures()).toEqual([])
    await rig.frame()
    const { width, height } = rig.history.outputs.extent
    expect({ width, height }).toEqual(HISTORY)
    const held = rig.history.textures()
    expect(held).toHaveLength(6)
    const backend = renderer.backend as unknown as {
      get(texture: object): { texture: GPUTexture }
    }
    let declared = 0
    for (const map of held) {
      const gpuTexture = backend.get(map).texture
      expect(gpuTexture.mipLevelCount, map.name).toBe(1)
      expect([gpuTexture.width, gpuTexture.height], map.name).toEqual([
        width,
        height,
      ])
      expect(gpuTexture.format, map.name).toBe('rgba16float')
      declared += textureBytes(gpuTexture.width, gpuTexture.height, 1, 8)
    }
    expect(rig.history.bytes).toBe(declared)
    // 48 B a texel across both parities, §3.19's figure.
    expect(rig.history.bytes).toBe(HISTORY.width * HISTORY.height * 48)
    rig.dispose()
    expect(rig.history.bytes).toBe(0)
    expect(rig.history.textures()).toEqual([])
  })
})

describe('compile-ahead', () => {
  it('warm builds all four kernels, and the first frame of either regime builds none', async () => {
    const rig = new Rig()
    // The stand-in and the reader are this file's, and warmed first so the
    // count below is the history's alone.
    await warmCompute(renderer, [rig.trace.kernel, reader.kernel])
    const before = gpu.computePipelinesBuilt()
    await rig.history.warm(renderer)
    expect(gpu.computePipelinesBuilt() - before).toBe(4)
    const warmed = gpu.computePipelinesBuilt()
    const first = await rig.frame()
    expect(first.regime).toBe('immediate')
    // Both parities, both directions: the first converging frame reads the
    // parity the immediate frame wrote, the second the other.
    await rig.frame({ renderTime: START })
    await rig.frame({ renderTime: START })
    await rig.frame({ levers: { force: 'reset' } })
    expect(rig.last?.regime).toBe('immediate')
    expect(gpu.computePipelinesBuilt()).toBe(warmed)
    rig.dispose()
  })
})

describe('the immediate regime', () => {
  it('writes exactly phase k’s pixels of the newest parity at age 0, and nothing else', async () => {
    const rig = new Rig()
    const frame = await rig.frame()
    const { width, height } = frame.extents.history
    // Every texel of both parities a sentinel, so a write shows where it lands.
    const SENTINEL = -7
    for (const offset of [0, 3]) {
      const maps = rig.history.textures().slice(offset, offset + 3)
      const fill = Fn(() => {
        const at = globalId.xy as unknown as Node<'uvec2'>
        If(
          float(at.x).lessThan(width).and(float(at.y).lessThan(height)),
          () => {
            for (const map of maps)
              textureStore(map as StorageTexture, at, vec4(SENTINEL))
          },
        )
      })
      await checked(() =>
        renderer.compute(computeKernel(fill(), [8, 8, 1]), [
          Math.ceil(width / 8),
          Math.ceil(height / 8),
          1,
        ]),
      )
    }
    const before = rig.history.outputs
    for (let k = 0; k < 4; k += 1) {
      await checked(() => {
        rig.trace.code.value = k
        rig.trace.dispatch(renderer, k, 0)
        rig.history.renderImmediate(renderer, frame, k)
      })
      const newest = rig.history.outputs
      // k = 0 turned to the other parity, and every phase lands in it.
      expect(newest.light).not.toBe(before.light)
      const { light, air, depth } = await rig.read()
      for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1) {
          const phase = PHASES.findIndex(
            ([px, py]) => x % 2 === px && y % 2 === py,
          )
          const i = (x - PHASES[phase]![0]) / 2
          const j = (y - PHASES[phase]![1]) / 2
          if (phase <= k) {
            expect(light.at(x, y)).toEqual([i, j, phase, 0.5])
            expect(air.at(x, y)).toEqual([phase + 1, i, j, 1])
            // The trace's knot count, 9, is not the history's: age 0.
            expect(depth.at(x, y)).toEqual([i, j, phase + 2, 0])
          } else {
            expect(light.at(x, y)).toEqual([
              SENTINEL,
              SENTINEL,
              SENTINEL,
              SENTINEL,
            ])
            expect(depth.at(x, y)[3]).toBe(SENTINEL)
          }
        }
      // The parity the last frame wrote is untouched.
      const old = await reader.read(before.light, before.extent)
      expect(old.at(width - 1, height - 1)).toEqual([
        SENTINEL,
        SENTINEL,
        SENTINEL,
        SENTINEL,
      ])
    }
    expect(rig.history.report.phase).toBe(3)
    rig.dispose()
  })
})

describe('a stationary scene', () => {
  /*
   * The trace mean is what the trace wrote, read back after every frame and
   * averaged per pixel over its eight converging samples. The deck is flat,
   * so the nine neighbors' bilinear current is the deck wherever the trace
   * has sampled it and the clip answers only to the frame's own samples.
   */
  async function sampled(
    rig: Rig,
    gain: (n: number) => number,
  ): Promise<{ readonly single: Image; readonly mean: Image }> {
    rig.trace.radius.value = 1e7
    rig.trace.gain.value = gain(0)
    // The world held still: frameSeconds is 0 and the wind moves nothing.
    await rig.frame()
    const single = (await rig.read()).light
    const { width, height } = HISTORY
    const sums = new Float64Array(width * height * 4)
    for (let n = 1; n <= 32; n += 1) {
      rig.trace.gain.value = gain(n)
      const frame = await rig.frame()
      const [px, py] = PHASES[frame.frameIndex % 4]!
      const traced = await reader.read(
        rig.trace.outputs.light,
        frame.extents.trace,
      )
      for (let j = 0; j < traced.height; j += 1)
        for (let i = 0; i < traced.width; i += 1) {
          const at = ((2 * j + py) * width + 2 * i + px) * 4
          traced.at(i, j).forEach((value, c) => {
            sums[at + c] = sums[at + c]! + value
          })
        }
    }
    expect(rig.last!.regime).toBe('converging')
    expect(rig.history.report.sinceReset).toBe(32)
    const mean: Image = {
      width,
      height,
      at: (x, y) => {
        const at = (y * width + x) * 4
        return [
          sums[at]! / 8,
          sums[at + 1]! / 8,
          sums[at + 2]! / 8,
          sums[at + 3]! / 8,
        ]
      },
    }
    return { single, mean }
  }

  it('holds the plain mean of each pixel’s eight converging samples, the reset frame’s given none', async () => {
    /*
     * The clip kept idle, so the bookkeeping is all that is measured: a ramp
     * across the deck widens every window to ±0.7% of the light at its
     * brightest, and the light moves uniformly by a fifth of that from frame
     * to frame, so every window moves with it. A sample mixed from the
     * wrong phase or the wrong parity is a pixel's step of the ramp off,
     * 1.25%. The reset frame draws 25% bright, as a quarter of the step
     * budget may; the clip holds it to its window's edge before the first
     * full-budget sample replaces it, so this cannot tell the weights apart
     * by that frame, and the bound is the running mean's own rounding.
     */
    const rig = new Rig()
    rig.trace.ramp.value.set(0.8, 0)
    const { mean } = await sampled(rig, (n) =>
      n === 0 ? 1.25 : 1 + 0.0015 * Math.sin(1.3 * n),
    )
    expect(largestDifference((await rig.read()).light, mean)).toBeLessThan(
      MEAN_ROUNDING,
    )
    rig.dispose()
  })

  /*
   * At 2% noise. The clip holds a converged pixel within 1.25 deviations of
   * this frame's nine bilinear neighbors, and a bilinear value averages two
   * or four samples, so that window is narrower than one sample's noise:
   * at 5% noise the worst pixel stays 2.1% from its mean, 0.7% RMS.
   */
  it('converges to the trace mean within 1% in 32 frames under 2% noise, which one frame’s samples do not', async () => {
    const rig = new Rig()
    rig.trace.noise.value = 0.02
    const { single, mean } = await sampled(rig, () => 1)
    // The control: one sample a pixel misses its mean by the noise's own
    // 2%, so the bound separates an accumulated history from a copied one.
    expect(largestDifference(single, mean)).toBeGreaterThan(0.015)
    expect(largestDifference((await rig.read()).light, mean)).toBeLessThan(0.01)
    rig.dispose()
  })
})

/**
 * The body turning under a camera held in render space: the eye sweeps 6.7 m
 * a frame through the body's axes, 0.2° off the spin axis, and the camera's
 * body-fixed basis turns 3 × 10⁻⁴ rad a frame with it.
 */
const SPIN = Vec.normalize(
  Vec.add(
    UP,
    Vec.scale(
      Vec.normalize(Vec.cross(UP, { x: 1, y: 0, z: 0 })),
      Math.tan((0.2 * Math.PI) / 180),
    ),
  ),
)
const TURN = 3e-4
const turned = (n: number): Quat =>
  Q.multiply(Q.fromAxisAngle(SPIN, n * TURN), TURNED)

/** The patch's centroid in the history after `frames` frames, and where the deck puts it. */
async function tracked(
  frames: number,
  step: (n: number) => Step,
  tamper?: Tamper,
): Promise<{ readonly miss: number; readonly travel: number }> {
  const rig = new Rig()
  await rig.frame(step(0))
  const deck = (): ((x: number, y: number) => readonly number[]) => {
    const at = expected(rig.deck!, rig.last!)
    return (x, y) => at(x, y).light
  }
  const start = centroid(HISTORY.width, HISTORY.height, deck())
  for (let n = 1; n <= frames; n += 1) await rig.frame(step(n), tamper)
  expect(rig.last!.regime).toBe('converging')
  const { light } = await rig.read()
  const got = centroid(light.width, light.height, (x, y) => light.at(x, y))
  const want = centroid(HISTORY.width, HISTORY.height, deck())
  rig.dispose()
  return {
    miss: Math.hypot(got.x - want.x, got.y - want.y),
    travel: Math.hypot(want.x - start.x, want.y - start.y),
  }
}

describe('reprojection', () => {
  /*
   * A feature carried right lands within a tenth of a history pixel of the
   * deck's own (measured: 0.013 px for the turn, 0.046 for the wind, over a
   * travel of 7 to 8 px). Its controls take the motion out of the history's
   * uniforms alone, so the trace still draws it moving: the clip, which
   * holds a pixel within its neighbors' range, bounds the trail to about a
   * pixel (measured: 1.3 and 1.4), so half of one is what they must miss by.
   */
  const KEPT = 0.1
  const TRAILED = 0.5

  it('keeps a feature at its body-fixed place while the body turns', async () => {
    const step = (n: number): Step => ({
      orientation: turned(n),
      renderTime: START + n * DELTA,
    })
    const kept = await tracked(40, step)
    // The control: the same frames with the turn taken out of the history's
    // uniforms, as a history reprojecting in render axes would see them.
    const still = await tracked(40, step, (uniforms) => {
      const { camera } = uniforms
      camera.translation.value.set(0, 0, 0)
      camera.previousRight.value.copy(camera.right.value)
      camera.previousUp.value.copy(camera.up.value)
      camera.previousForward.value.copy(camera.forward.value)
    })
    expect(kept.travel).toBeGreaterThan(6)
    expect(kept.miss).toBeLessThan(KEPT)
    expect(still.miss).toBeGreaterThan(TRAILED)
  })

  it('moves a feature by wind·frameSeconds under warp', async () => {
    const step = (n: number): Step => ({
      levers: { force: 'warp', warp: 60 },
      renderTime: START + n * DELTA,
    })
    const carried = await tracked(40, step)
    const becalmed = await tracked(40, step, (uniforms) => {
      uniforms.trace.frameSeconds.value = 0
    })
    expect(carried.travel).toBeGreaterThan(6)
    expect(carried.miss).toBeLessThan(KEPT)
    expect(becalmed.miss).toBeGreaterThan(TRAILED)
  })
})

describe('resets', () => {
  /*
   * Converged at gain 1, then the frame under test at gain 2: a history
   * that resets holds the trace's fresh gain-2 samples exactly, at age 0;
   * one that blended would hold neither gain.
   */
  async function across(change: (n: number) => Step): Promise<{
    readonly frame: CloudFrame
    readonly rig: Rig
    readonly resets: number
  }> {
    const rig = new Rig()
    await rig.frames(12, (n) => ({ renderTime: START + n * DELTA }))
    const resets = rig.history.report.resets
    rig.trace.gain.value = 2
    const frame = await rig.frame(change(12))
    return { frame, rig, resets }
  }

  async function expectFresh(rig: Rig, frame: CloudFrame): Promise<void> {
    const { light, depth } = await rig.read()
    expect([light.width, light.height]).toEqual([
      frame.extents.history.width,
      frame.extents.history.height,
    ])
    expect(worstMiss(light, expected(rig.deck!, frame, 2))).toBeLessThan(HALF)
    for (let y = 0; y < depth.height; y += 1)
      for (let x = 0; x < depth.width; x += 1) expect(depth.at(x, y)[3]).toBe(0)
    expect(rig.history.report.sinceReset).toBe(0)
  }

  it.each([
    [
      'the picture key',
      'key',
      (n: number): Step => ({ renderTime: START + n * DELTA, epoch: 1 }),
    ],
    [
      'a resize',
      'resize',
      (n: number): Step => ({
        renderTime: START + n * DELTA,
        display: { width: 192, height: 128 },
      }),
    ],
    ['a jump', 'jump', (): Step => ({ renderTime: START + 100 })],
  ] as const)('on %s', async (_, reason, change) => {
    const { frame, rig, resets } = await across(change)
    expect(frame.reset).toBe(reason)
    expect(frame.regime).toBe('immediate')
    expect(rig.history.report.resets).toBe(resets + 1)
    await expectFresh(rig, frame)
    if (reason === 'resize') {
      expect(rig.history.outputs.extent).toEqual({ width: 96, height: 64 })
      expect(rig.history.bytes).toBe(96 * 64 * 48)
    }
    rig.dispose()
  })

  it('and not on a frame that changes nothing, whose every texel ages by one', async () => {
    const rig = new Rig()
    await rig.frames(12, (n) => ({ renderTime: START + n * DELTA }))
    const { resets, sinceReset } = rig.history.report
    const ages = (await rig.read()).depth
    const frame = await rig.frame({ renderTime: START + 12 * DELTA })
    expect(frame.regime).toBe('converging')
    expect(rig.history.report.resets).toBe(resets)
    expect(rig.history.report.sinceReset).toBe(sinceReset + 1)
    const aged = (await rig.read()).depth
    for (let y = 0; y < aged.height; y += 1)
      for (let x = 0; x < aged.width; x += 1)
        expect(aged.at(x, y)[3]).toBe(ages.at(x, y)[3]! + 1)
    rig.dispose()
  })

  it('and on the CPU’s reset, which the next converging frame keeps nothing through', async () => {
    const rig = new Rig()
    await rig.frames(12, (n) => ({ renderTime: START + n * DELTA }))
    const resets = rig.history.report.resets
    rig.history.reset()
    const frame = await rig.frame({ renderTime: START + 12 * DELTA })
    expect(frame.regime).toBe('converging')
    expect(rig.history.report.resets).toBe(resets + 1)
    expect(rig.history.report.sinceReset).toBe(0)
    const { depth } = await rig.read()
    const [px, py] = PHASES[frame.frameIndex % 4]!
    for (let y = 0; y < depth.height; y += 1)
      for (let x = 0; x < depth.width; x += 1)
        // A fresh sample stands for one cycle, a bilinear guess for none.
        expect(depth.at(x, y)[3]).toBe(x % 2 === px && y % 2 === py ? 4 : 0)
    rig.dispose()
  })
})

/** The largest relative difference between two images, every component. */
function largestDifference(a: Image, b: Image): number {
  let largest = 0
  for (let y = 0; y < a.height; y += 1)
    for (let x = 0; x < a.width; x += 1) {
      const p = a.at(x, y)
      const q = b.at(x, y)
      for (let c = 0; c < 4; c += 1)
        largest = Math.max(
          largest,
          Math.abs(p[c]! - q[c]!) / Math.max(Math.abs(q[c]!), 1e-3),
        )
    }
  return largest
}

describe('the NaN guard', () => {
  /*
   * The reference is a twin fed the same frames without the poison. Both
   * are deterministic, so once the poisoned history recovers it holds what
   * the twin holds, texel for texel; the texels are where the deck is flat,
   * so neither the clip nor the restart's own weights can tell them apart.
   */
  it.each([
    ['where the deck is flat', [8, 8]],
    ['at the image’s corner', [0, 0]],
  ] as const)(
    'a NaN trace texel %s leaves the history finite, and its pixels recover within 4 frames',
    async (_, [i, j]) => {
      const rig = new Rig()
      const twin = new Rig()
      const step = (n: number): Step => ({ renderTime: START + n * DELTA })
      const both = async (n: number): Promise<void> => {
        await rig.frame(step(n))
        await twin.frame(step(n))
      }
      for (let n = 0; n < 12; n += 1) await both(n)
      rig.trace.poison.value.set(i, j)
      await both(12)
      rig.trace.poison.value.set(-1, -1)
      // The poison reached the trace: its light reads back as NaN.
      const traced = await reader.read(
        rig.trace.outputs.light,
        rig.trace.outputs.extent,
      )
      expect(traced.at(i, j).every(Number.isNaN)).toBe(true)
      const poisoned = await rig.read()
      expect(finite(poisoned.light)).toBe(true)
      expect(finite(poisoned.air)).toBe(true)
      expect(finite(poisoned.depth)).toBe(true)
      // ...and the history, which wrote clear sky where it could not trust
      // the texel: the twin's T of 0.7 is a 1 there.
      expect(
        largestDifference(poisoned.light, (await twin.read()).light),
      ).toBeGreaterThan(0.4)
      for (let n = 13; n < 17; n += 1) {
        await both(n)
        const { light, air, depth } = await rig.read()
        expect(finite(light) && finite(air) && finite(depth)).toBe(true)
      }
      const recovered = await rig.read()
      const reference = await twin.read()
      expect(largestDifference(recovered.light, reference.light)).toBeLessThan(
        HALF,
      )
      expect(largestDifference(recovered.air, reference.air)).toBeLessThan(HALF)
      rig.dispose()
      twin.dispose()
    },
  )
})

describe('the report under stats', () => {
  /*
   * One readback is in flight at a time and a frame issued while it is
   * counts nothing, so the frame a count is about is drawn only after
   * every earlier readback has landed: the queue drained, and the map and
   * its promise chain given turns to run.
   */
  async function landed(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) {
      await device.queue.onSubmittedWorkDone()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  it('counts the share of pixels a frame rejected: none in a still scene, all after a reset, and null without stats', async () => {
    const rig = new Rig()
    const stats = { levers: { stats: true } }
    await rig.frames(8, (n) => ({ ...stats, renderTime: START + n * DELTA }))
    await landed()
    expect(rig.history.report.rejected).toBe(0)
    rig.history.reset()
    await rig.frame({ ...stats, renderTime: START + 8 * DELTA })
    await landed()
    expect(rig.history.report.rejected).toBe(1)
    await rig.frame({ renderTime: START + 9 * DELTA })
    expect(rig.history.report.rejected).toBeNull()
    rig.dispose()
  })
})

describe.skipIf(!TIMESTAMPS)('the history on the pass timeline', () => {
  it.each([
    [1, 'a converging frame', 'none'],
    [4, 'an immediate frame', 'reset'],
  ] as const)('is %d `cloud history` passes in %s', async (count, _, force) => {
    const rig = new Rig()
    const stop = installPassTimeline(renderer)
    try {
      await rig.frames(4, (n) => ({ renderTime: START + n * DELTA }))
      const timeline = passTimelineOf(renderer)
      expect(timeline).not.toBeNull()
      let n = 4
      const draw = () => {
        const frame = cloudFrame(
          inputs({ renderTime: START + n * DELTA, levers: { force } }),
          rig.last,
        )!
        n += 1
        rig.uniforms.write(frame)
        rig.trace.aim(rig.deck!, frame)
        if (frame.regime === 'immediate')
          for (let k = 0; k < 4; k += 1) {
            rig.trace.dispatch(renderer, k, k)
            rig.history.renderImmediate(renderer, frame, k)
          }
        else {
          rig.trace.dispatch(renderer, frame.frameIndex % 4, 0)
          rig.history.render(renderer, frame, BUDGET)
        }
        rig.last = frame
      }
      await checked(draw)
      const result = await timeline!.measure(draw, 4)
      expect(result.dropped).toBe(0)
      const history = result.passes.find(
        (pass) => pass.label === 'cloud history',
      )
      expect(history?.count).toBe(count)
    } finally {
      stop()
      rig.dispose()
    }
  })
})
