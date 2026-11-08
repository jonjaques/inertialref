import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FloatType,
  FramebufferTexture,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  OrthographicCamera,
  PlaneGeometry,
  QuadMesh,
  RedFormat,
  RenderTarget,
  RenderTarget3D,
  RGFormat,
  Scene,
  StorageBufferAttribute,
  StorageTexture,
  TempNode,
  type Texture,
  UnsignedByteType,
  Vector2,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  ivec3,
  mrt,
  storage,
  texture,
  texture3D,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uv,
  uvec2,
  vec4,
} from 'three/tsl'
import {
  markOverClouds,
  OVER_CLOUDS_LAYERS,
  UNDER_CLOUDS_LAYERS,
} from './cloudLayers.ts'
import { cloudStorageTexture } from './cloudNodes.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmCompute, warmSensorPass } from './warmup.ts'

/*
 * The premises a cloud format or placement depends on, settled on the real
 * GPU before any package builds on them (the design's §11.1). Each was read
 * from three r185's source, not run; each has a fallback that changes a
 * contract, and a premise that fails here changes the contract here, before
 * the fan-out, rather than in a package that learned it after another had
 * built on it.
 */

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

/** 8-bit storage's step: what an RGBA8 or R8 texel is held to. */
const BYTE = 1 / 255
/** A half float's step near 1. */
const HALF = 2 ** -10

/**
 * Run `work` inside a validation scope of the test's own, then let the sink's
 * late reports land, and fail on any error either channel carried. The
 * harness's verbs do this for themselves; a draw issued from a node's
 * `updateBefore` is no verb.
 */
async function checked<T>(work: () => T | Promise<T>): Promise<T> {
  const from = gpu.reported().length
  device.pushErrorScope('validation')
  let result: T
  try {
    result = await work()
  } finally {
    const scoped = await device.popErrorScope()
    if (scoped !== null)
      throw new Error(`the device reported: ${scoped.message}`)
  }
  await device.queue.onSubmittedWorkDone()
  for (let turn = 0; turn < 3; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(
    gpu
      .reported()
      .slice(from)
      .filter((entry) => entry.type === 'error'),
  ).toEqual([])
  return result
}

/** Texels of `map` read back by a kernel: textureLoad, so nothing filters or flips them. */
async function texels(
  map: Texture,
  kind: '2d' | '2d-array' | '3d',
  at: readonly (readonly [number, number, number?])[],
): Promise<number[][]> {
  const out = new StorageBufferAttribute(new Float32Array(at.length * 4), 1)
  const into = storage(out, 'float', at.length * 4)
  const kernel = Fn(() => {
    at.forEach(([x, y, z = 0], k) => {
      const read =
        kind === '3d'
          ? texture3D(map).load(ivec3(x, y, z))
          : kind === '2d-array'
            ? textureLoad(map, ivec2(x, y)).depth(int(z))
            : textureLoad(map, ivec2(x, y))
      If(instanceIndex.equal(uint(0)), () => {
        into.element(k * 4).assign(read.x)
        into.element(k * 4 + 1).assign(read.y)
        into.element(k * 4 + 2).assign(read.z)
        into.element(k * 4 + 3).assign(read.w)
      })
    })
  })().compute(1)
  await gpu.compute(kernel)
  const values = new Float32Array(await gpu.readBuffer(out))
  return at.map((_, k) => [...values.subarray(k * 4, k * 4 + 4)])
}

/**
 * A node whose `updateBefore` runs `work` once a render, at the draw of the
 * object whose material holds it: the frame node's shape, and the over
 * pass's.
 */
class Before extends TempNode<'float'> {
  static get type(): string {
    return 'PremiseBefore'
  }

  readonly #work: (renderer: WebGPURenderer) => void

  constructor(work: (renderer: WebGPURenderer) => void) {
    super('float')
    this.#work = work
    this.updateBeforeType = NodeUpdateType.RENDER
  }

  override setup(): Node {
    return float(0)
  }

  override updateBefore(frame: NodeFrame): undefined {
    this.#work(frame.renderer as WebGPURenderer)
    return undefined
  }
}

/** A unit square at a quadrant's center of a −1…1 orthographic view. */
function quadrant(x: -1 | 1, y: -1 | 1, material: MeshBasicNodeMaterial): Mesh {
  const mesh = new Mesh(new PlaneGeometry(1, 1), material)
  mesh.position.set(x * 0.5, y * 0.5, 0)
  return mesh
}

function colored(color: Node<'vec4'>): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.colorNode = color
  return material
}

const view = (): OrthographicCamera => {
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.z = 1
  camera.updateMatrixWorld()
  return camera
}

/** The quadrants' interior texels in an 8 × 8 target, row 0 at the top. */
const TOP_LEFT = [1, 1] as const
const TOP_RIGHT = [6, 1] as const
const BOTTOM_LEFT = [1, 6] as const
const BOTTOM_RIGHT = [6, 6] as const

/** The renderer's internals the split reaches: the open render's context, and the backend's record of it. */
interface Internals {
  readonly _currentRenderContext: object | null
}
interface BackendRecords {
  get(object: object): {
    encoder?: GPUCommandEncoder | null
    currentPass?: GPURenderPassEncoder | null
  }
}

/**
 * The split as §4.2 builds it: end the scene pass through a one-texel
 * framebuffer copy, and hold the encoder's `beginRenderPass` for that one
 * call — submit what the encoder holds, start a fresh one, write it into the
 * context's record, and begin the resumed pass on it. `finishRender` reads
 * that record fresh before it submits, so the resumed half goes out on the
 * fresh encoder after whatever `during` submitted.
 */
function splitPrototype(
  three: WebGPURenderer,
  probe: FramebufferTexture,
  during: () => void,
): boolean {
  const context = (three as unknown as Internals)._currentRenderContext
  if (context === null) return false
  const records = three.backend as unknown as BackendRecords
  const record = records.get(context)
  const encoder = record.encoder
  if (encoder === undefined || encoder === null || !record.currentPass)
    return false
  const begin = encoder.beginRenderPass
  encoder.beginRenderPass = (descriptor) => {
    encoder.beginRenderPass = begin
    device.queue.submit([encoder.finish()])
    const next = device.createCommandEncoder({ label: 'scene over clouds' })
    record.encoder = next
    return next.beginRenderPass(descriptor)
  }
  try {
    three.copyFramebufferToTexture(probe, new Vector2(0, 0))
  } finally {
    encoder.beginRenderPass = begin
  }
  during()
  return true
}

describe('a RenderTarget3D slice', () => {
  it.each([
    ['R8', RedFormat, 0],
    ['RG8', RGFormat, 1],
  ] as const)(
    'takes a fragment draw per slice in %s, and warmSensorPass builds what the first draw uses',
    async (_, format, channel) => {
      const volume = new RenderTarget3D(4, 4, 4, {
        type: UnsignedByteType,
        format,
        depthBuffer: false,
      })
      const value = uniform(0)
      const material = new NodeMaterial()
      material.fragmentNode = vec4(value, value, 0, 1)
      const quad = new QuadMesh()
      const before = gpu.pipelinesBuilt()
      await checked(() =>
        warmSensorPass(renderer, quad, [{ target: volume, material }]),
      )
      const warmed = gpu.pipelinesBuilt()
      expect(warmed).toBeGreaterThan(before)
      await checked(() =>
        runQuadPasses(renderer, quad, { linear: true }, (draw) => {
          for (let z = 0; z < 4; z += 1) {
            value.value = (z + 1) / 8
            draw('premise slice', volume, material, z)
          }
        }),
      )
      expect(gpu.pipelinesBuilt()).toBe(warmed)
      const read = await texels(volume.texture, '3d', [
        [0, 0, 0],
        [3, 1, 1],
        [2, 3, 2],
        [1, 2, 3],
      ])
      read.forEach((texel, z) => {
        expect(Math.abs(texel[channel]! - (z + 1) / 8)).toBeLessThanOrEqual(
          BYTE,
        )
      })
      volume.dispose()
    },
  )
})

describe('a 2D-array MRT target', () => {
  it('takes one quad into four targets at a layer, and warmSensorPass builds what the first draw uses', async () => {
    const maps = new RenderTarget(4, 4, {
      depth: 6,
      count: 4,
      type: UnsignedByteType,
      depthBuffer: false,
    })
    maps.textures.forEach((map, k) => {
      map.name = `premise${k}`
    })
    const layer = uniform(0)
    const material = new NodeMaterial()
    material.fragmentNode = mrt({
      premise0: vec4(0.2, layer, 0, 1),
      premise1: vec4(0.4, layer, 0, 1),
      premise2: vec4(0.6, layer, 0, 1),
      premise3: vec4(0.8, layer, 0, 1),
    })
    const quad = new QuadMesh()
    const before = gpu.pipelinesBuilt()
    await checked(() =>
      warmSensorPass(renderer, quad, [{ target: maps, material }]),
    )
    const warmed = gpu.pipelinesBuilt()
    expect(warmed).toBeGreaterThan(before)
    await checked(() =>
      runQuadPasses(renderer, quad, { linear: true }, (draw) => {
        for (const k of [1, 4]) {
          layer.value = (k + 1) / 8
          draw('premise maps', maps, material, k)
        }
      }),
    )
    expect(gpu.pipelinesBuilt()).toBe(warmed)
    for (let target = 0; target < 4; target += 1) {
      const [one, untouched, four] = await texels(
        maps.textures[target]!,
        '2d-array',
        [
          [1, 2, 1],
          [1, 2, 2],
          [3, 0, 4],
        ],
      )
      expect(Math.abs(one![0]! - 0.2 * (target + 1))).toBeLessThanOrEqual(BYTE)
      expect(Math.abs(one![1]! - 2 / 8)).toBeLessThanOrEqual(BYTE)
      expect(Math.abs(four![1]! - 5 / 8)).toBeLessThanOrEqual(BYTE)
      // A layer no quad drew keeps WebGPU's zero initialization.
      expect(untouched).toEqual([0, 0, 0, 0])
    }
    maps.dispose()
  })
})

/*
 * What the frame node does in both placements: inside an open render, a
 * compute writes a storage texture, a quad render reads it into a target of
 * its own, and the object whose material holds the node then draws that
 * target, with an object after it reading the storage texture too. If any
 * of them ran out of order, a later one reads what was there before.
 */
interface Nested {
  readonly storageMap: StorageTexture
  readonly nestedTarget: RenderTarget
  readonly frameNode: Before
  readonly composite: MeshBasicNodeMaterial
  readonly after: MeshBasicNodeMaterial
  readonly seen: { context: boolean; target: boolean; runs: number }
}

const WRITTEN = 0.75

function nested(
  outer: () => RenderTarget,
  around: (three: WebGPURenderer, run: () => void) => void,
  compute: (storageMap: StorageTexture) => Node,
): Nested {
  const storageMap = cloudStorageTexture(4, 4, 'rgba16float', 'premise storage')
  const nestedTarget = new RenderTarget(4, 4, {
    type: HalfFloatType,
    depthBuffer: false,
  })
  const kernel = Fn(() => {
    compute(storageMap)
  })().compute(16)
  const nestedMaterial = new NodeMaterial()
  nestedMaterial.fragmentNode = texture(storageMap, uv())
  const nestedQuad = new QuadMesh()
  const seen = { context: false, target: false, runs: 0 }
  const frameNode = new Before((three) => {
    const context = (three as unknown as Internals)._currentRenderContext
    around(three, () => {
      three.compute(kernel)
      runQuadPasses(three, nestedQuad, { linear: true }, (draw) => {
        draw('premise nested', nestedTarget, nestedMaterial)
      })
    })
    seen.runs += 1
    seen.context =
      (three as unknown as Internals)._currentRenderContext === context
    seen.target = three.getRenderTarget() === outer()
  })
  const composite = colored(
    texture(nestedTarget.texture, uv()).add(frameNode) as Node<'vec4'>,
  )
  composite.transparent = true
  const after = colored(texture(storageMap, uv()))
  after.transparent = true
  return { storageMap, nestedTarget, frameNode, composite, after, seen }
}

/** Write `value` into every texel of a 4 × 4 storage texture. */
const fill =
  (value: number) =>
  (storageMap: StorageTexture): Node => {
    const at = uvec2(instanceIndex.mod(uint(4)), instanceIndex.div(uint(4)))
    return textureStore(storageMap, at, vec4(value, value, value, 1))
  }

describe('compute and a render inside an open render', () => {
  it('under a pass-B-like render: in order, the outer pass loads what was there and keeps drawing into its target', async () => {
    const sceneTarget = new RenderTarget(8, 8, {
      type: HalfFloatType,
      samples: 4,
    })
    const post = new RenderTarget(8, 8, { type: FloatType, depthBuffer: false })
    const work = nested(
      () => sceneTarget,
      (_, run) => run(),
      fill(WRITTEN),
    )
    const camera = view()
    camera.layers.enable(1)
    const scene = new Scene()
    const under = quadrant(-1, 1, colored(vec4(0.25, 0, 0, 1)))
    const over = [
      quadrant(1, 1, colored(vec4(0.5, 0, 0, 1))),
      quadrant(-1, -1, work.composite),
      quadrant(1, -1, work.after),
    ]
    over[1]!.renderOrder = 1
    over[2]!.renderOrder = 2
    for (const mesh of over) markOverClouds(mesh)
    scene.add(under, ...over)
    scene.updateMatrixWorld(true)
    // Pass A and pass B from the post quad's own `updateBefore`, as the
    // sensor's scene pass and over pass run from its chain.
    const passes = new Before((three) => {
      const target = three.getRenderTarget()
      const autoClear = three.autoClear
      const mask = camera.layers.mask
      try {
        three.setRenderTarget(sceneTarget)
        camera.layers.mask = UNDER_CLOUDS_LAYERS.mask
        three.render(scene, camera)
        three.autoClear = false
        camera.layers.mask = OVER_CLOUDS_LAYERS.mask
        three.render(scene, camera)
      } finally {
        camera.layers.mask = mask
        three.autoClear = autoClear
        three.setRenderTarget(target)
      }
    })
    const postMaterial = new NodeMaterial()
    postMaterial.fragmentNode = texture(sceneTarget.texture, uv()).add(
      passes,
    ) as Node<'vec4'>
    const postQuad = new QuadMesh(postMaterial)
    await checked(() =>
      runQuadPasses(renderer, postQuad, { linear: true }, (draw) => {
        draw('premise post', post, postMaterial)
      }),
    )
    expect(work.seen).toEqual({ context: true, target: true, runs: 1 })
    const [a, b, composite, after] = await texels(sceneTarget.texture, '2d', [
      TOP_LEFT,
      TOP_RIGHT,
      BOTTOM_LEFT,
      BOTTOM_RIGHT,
    ])
    expect(a![0]).toBeCloseTo(0.25, 3)
    expect(b![0]).toBeCloseTo(0.5, 3)
    expect(Math.abs(composite![0]! - WRITTEN)).toBeLessThanOrEqual(HALF)
    expect(Math.abs(after![0]! - WRITTEN)).toBeLessThanOrEqual(HALF)
    const [postA, , postComposite] = await texels(post.texture, '2d', [
      TOP_LEFT,
      TOP_RIGHT,
      BOTTOM_LEFT,
    ])
    expect(postA![0]).toBeCloseTo(0.25, 3)
    expect(Math.abs(postComposite![0]! - WRITTEN)).toBeLessThanOrEqual(HALF)
    sceneTarget.dispose()
    post.dispose()
  })
})

describe('the split', () => {
  /*
   * The scene pass draws an opaque square, then the composite (transparent,
   * order 1.5), whose node splits the pass; inside the split a kernel reads
   * the opaque square's texel out of the scene target and writes the storage
   * texture, and a quad render reads that into a target the composite draws.
   * A square drawn after the composite reads the storage texture.
   */
  async function frame(split: boolean): Promise<{
    readonly before: number
    readonly seen: Nested['seen']
    readonly drawn: number[][]
  }> {
    const sceneTarget = new RenderTarget(8, 8, {
      type: HalfFloatType,
      samples: 4,
    })
    const probe = new FramebufferTexture(1, 1)
    const readOut = new StorageBufferAttribute(new Float32Array(4), 1)
    const into = storage(readOut, 'float', 4)
    let splitTook: boolean | null = null
    const work = nested(
      () => sceneTarget,
      (three, run) => {
        if (split) splitTook = splitPrototype(three, probe, run)
        else run()
      },
      (storageMap) => {
        const seenThere = textureLoad(sceneTarget.texture, ivec2(...TOP_RIGHT))
        If(instanceIndex.equal(uint(0)), () => {
          into.element(0).assign(seenThere.x)
        })
        return fill(WRITTEN)(storageMap)
      },
    )
    const camera = view()
    const scene = new Scene()
    const composite = quadrant(-1, -1, work.composite)
    const after = quadrant(1, -1, work.after)
    composite.renderOrder = 1.5
    after.renderOrder = 2
    scene.add(quadrant(1, 1, colored(vec4(0.5, 0, 0, 1))), composite, after)
    scene.updateMatrixWorld(true)
    // What the target held before this frame: what a kernel run ahead of the
    // frame's first half reads.
    const previous = new Scene()
    previous.add(quadrant(1, 1, colored(vec4(0.125, 0, 0, 1))))
    previous.updateMatrixWorld(true)
    await checked(() => {
      const target = renderer.getRenderTarget()
      try {
        renderer.setRenderTarget(sceneTarget)
        renderer.render(previous, camera)
        renderer.render(scene, camera)
      } finally {
        renderer.setRenderTarget(target)
      }
    })
    if (split) expect(splitTook).toBe(true)
    const before = new Float32Array(await gpu.readBuffer(readOut))[0]!
    const drawn = await texels(sceneTarget.texture, '2d', [
      TOP_RIGHT,
      BOTTOM_LEFT,
      BOTTOM_RIGHT,
    ])
    sceneTarget.dispose()
    return { before, seen: work.seen, drawn }
  }

  it('runs the draw before, the compute during and the draw after in that order, on the scene target', async () => {
    const { before, seen, drawn } = await frame(true)
    // The kernel inside the split saw the first half's square: the half was
    // on the queue before it.
    expect(before).toBeCloseTo(0.5, 3)
    expect(seen).toEqual({ context: true, target: true, runs: 1 })
    const [square, composite, after] = drawn
    expect(square![0]).toBeCloseTo(0.5, 3)
    expect(Math.abs(composite![0]! - WRITTEN)).toBeLessThanOrEqual(HALF)
    expect(Math.abs(after![0]! - WRITTEN)).toBeLessThanOrEqual(HALF)
  })

  it('and without it the kernel runs ahead of the whole scene pass', async () => {
    // The control: the same work issued from the node with no split reads
    // the target as the previous frame left it, so the order above is the
    // split's and not the queue's.
    const { before, drawn } = await frame(false)
    expect(before).toBeCloseTo(0.125, 3)
    expect(drawn[0]![0]).toBeCloseTo(0.5, 3)
  })
})

describe('a uvec2 uniform', () => {
  it('builds, and carries both u32 halves exactly, past 2²⁴', async () => {
    const period = uniform(new Vector2(16_777_217, 4_000_000_000), 'uvec2')
    const out = new StorageBufferAttribute(new Uint32Array(2), 1)
    const into = storage(out, 'uint', 2)
    const kernel = Fn(() => {
      If(instanceIndex.equal(uint(0)), () => {
        into.element(0).assign(period.x)
        into.element(1).assign(period.y)
      })
    })().compute(1)
    await gpu.compute(kernel)
    expect([...new Uint32Array(await gpu.readBuffer(out))]).toEqual([
      16_777_217, 4_000_000_000,
    ])
    period.value.set(7, 2 ** 31 + 3)
    await gpu.compute(kernel)
    expect([...new Uint32Array(await gpu.readBuffer(out))]).toEqual([
      7,
      2 ** 31 + 3,
    ])
  })
})

describe('a cloud storage texture', () => {
  /** Render passes begun while `work` runs, on every encoder the device makes. */
  async function passesDuring(work: () => Promise<unknown>): Promise<number> {
    let passes = 0
    const create = device.createCommandEncoder.bind(device)
    device.createCommandEncoder = (descriptor) => {
      const encoder = create(descriptor)
      const begin = encoder.beginRenderPass.bind(encoder)
      encoder.beginRenderPass = (pass) => {
        passes += 1
        return begin(pass)
      }
      return encoder
    }
    try {
      await work()
    } finally {
      device.createCommandEncoder = create
    }
    return passes
  }

  async function writeThenSample(
    map: StorageTexture,
  ): Promise<{ levels: number; passes: number }> {
    const kernel = Fn(() => {
      const at = uvec2(instanceIndex.mod(uint(16)), instanceIndex.div(uint(16)))
      textureStore(map, at, vec4(0.5, 0.25, 0, 1))
    })().compute(256)
    await gpu.compute(kernel)
    const passes = await passesDuring(() =>
      gpu.drawGraph(texture(map, uv()), { width: 16, height: 16, float: true }),
    )
    const levels = (
      renderer.backend as unknown as {
        get(texture: object): { texture: GPUTexture }
      }
    ).get(map).texture.mipLevelCount
    return { levels, passes }
  }

  it('written by compute and then sampled, has one level and draws no mip pass', async () => {
    const { levels, passes } = await writeThenSample(
      cloudStorageTexture(16, 16, 'rgba16float', 'premise one level'),
    )
    expect(levels).toBe(1)
    // The sampled draw's own pass, and nothing else.
    expect(passes).toBe(1)
  })

  it('where three’s defaults allocate a chain and regenerate it with raw passes', async () => {
    // The control the count above is read against: a counter that cannot see
    // a mip pass would pass that test too.
    const plain = new StorageTexture(16, 16)
    plain.type = HalfFloatType
    const { levels, passes } = await writeThenSample(plain)
    expect(levels).toBe(5)
    expect(passes).toBeGreaterThan(1)
  })
})

describe('computePipelinesBuilt', () => {
  it('counts a kernel’s first dispatch and nothing after, and warmCompute moves that dispatch to boot', async () => {
    const out = new StorageBufferAttribute(new Uint32Array(2), 1)
    const into = storage(out, 'uint', 2)
    const kernel = (slot: number) =>
      Fn(() => {
        If(instanceIndex.equal(uint(0)), () => {
          into.element(slot).assign(uint(slot + 1))
        })
      })().compute(1)
    const first = kernel(0)
    const start = gpu.computePipelinesBuilt()
    await gpu.compute(first)
    expect(gpu.computePipelinesBuilt()).toBe(start + 1)
    await gpu.compute(first)
    expect(gpu.computePipelinesBuilt()).toBe(start + 1)

    const warmed = kernel(1)
    await warmCompute(renderer, [warmed])
    expect(gpu.computePipelinesBuilt()).toBe(start + 2)
    // The warm-up dispatched no workgroup, so the kernel wrote nothing.
    expect([...new Uint32Array(await gpu.readBuffer(out))]).toEqual([1, 0])
    await gpu.compute(warmed)
    expect(gpu.computePipelinesBuilt()).toBe(start + 2)
    expect([...new Uint32Array(await gpu.readBuffer(out))]).toEqual([1, 2])
  })
})
