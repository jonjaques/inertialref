import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BufferAttribute,
  type ComputeNode,
  Data3DTexture,
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  OrthographicCamera,
  PlaneGeometry,
  QuadMesh,
  type Object3D,
  RedFormat,
  RenderTarget,
  RenderTarget3D,
  RGBAFormat,
  RGFormat,
  Scene,
  SphereGeometry,
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
  vec3,
  vec4,
} from 'three/tsl'
import { buildPatch } from '@inertialref/rendering'
import { COVER_CHANNELS, regionAddress } from '@inertialref/universe'
import {
  markOverClouds,
  OVER_CLOUDS_LAYERS,
  UNDER_CLOUDS_LAYERS,
} from './cloudLayers.ts'
import { cloudStorageTexture } from './cloudNodes.ts'
import { cloudRig } from './cloudSystemRig.ts'
import type { CloudTrace } from './cloudTrace.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import {
  patchGeometry,
  placeEye,
  sheetGeometry,
  wearGround,
  wearSea,
} from './groundWear.ts'
import { createAtmosphereMaterial } from './materials.ts'
import { createPlanetMaterial } from './planet.ts'
import { runQuadPasses } from './quadPass.ts'
import { createTerrainMaterial } from './terrain.ts'
import { warmCompute, warmSensorPass } from './warmup.ts'
import { createWaterMaterial } from './water.ts'

/*
 * The air's bundle with and without a member, for the premise that a table
 * no graph reads binds nothing. `vi.mock` is hoisted over the imports, so
 * every module of this file's graph that builds an air bundle builds it
 * through this wrapper; with `stripped` empty it is the module itself, and
 * every other test here runs on the real bundle.
 */
const airMembers = vi.hoisted(() => ({ stripped: [] as string[] }))
vi.mock('./air.ts', async (original) => {
  const air = await original<typeof import('./air.ts')>()
  return {
    ...air,
    createAirUniforms: (
      ...args: Parameters<typeof air.createAirUniforms>
    ): ReturnType<typeof air.createAirUniforms> => {
      const bundle = air.createAirUniforms(...args) as unknown as Record<
        string,
        unknown
      >
      for (const member of airMembers.stripped) delete bundle[member]
      return bundle as unknown as ReturnType<typeof air.createAirUniforms>
    },
  }
})

/*
 * The premises a cloud format or pass depends on, settled on the real
 * GPU before any package builds on them (phase 0's design §11.1, and phase
 * 1's §10.2 from the mat3 uniforms on). Each was read from three r185's
 * source, not run; each has a fallback that changes a contract, and a
 * premise that fails here changes the contract here, before the fan-out,
 * rather than in a package that learned it after another had built on it.
 * Phase 1's sixth, the trace kernel's census, is in `cloudTrace.gpu.test.ts`.
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

/** The renderer's internals the nested work is checked against: the open render's context. */
interface Internals {
  readonly _currentRenderContext: object | null
}

/*
 * What the frame node does inside pass B: inside an open render, a
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
    three.compute(kernel)
    runQuadPasses(three, nestedQuad, { linear: true }, (draw) => {
      draw('premise nested', nestedTarget, nestedMaterial)
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
    const work = nested(() => sceneTarget, fill(WRITTEN))
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
    const map = cloudStorageTexture(16, 16, 'rgba16float', 'premise one level')
    // `generateMipmaps` off is the whole of it. three asks for a chain, and
    // regenerates one after a store, only where `Textures.needsMipmaps`
    // holds, so its own `mipmapsAutoUpdate` stands at the default and has
    // nothing to update: a three that regenerates on that flag alone fails
    // here.
    expect(map.generateMipmaps).toBe(false)
    expect(map).toHaveProperty('mipmapsAutoUpdate', true)
    const { levels, passes } = await writeThenSample(map)
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

/* ------------------------------------------------------------------------- */
/* Phase 1's premises (its design's §10.2)                                    */
/* ------------------------------------------------------------------------- */

/** The WGSL three builds for a kernel. */
function kernelWgsl(kernel: ComputeNode): string {
  const nodes = (
    renderer as unknown as {
      _nodes: { getForCompute(node: ComputeNode): { computeShader: string } }
    }
  )._nodes
  return nodes.getForCompute(kernel).computeShader
}

describe('three mat3 uniforms in a compute kernel', () => {
  /*
   * A level's turn is a matrix in its uniforms (§4.2), three a body. Each is
   * a turn about +Y, and their product applied to +X is the turn by the sum,
   * so a kernel that packed one wrongly, as a mat3's padded columns invite,
   * reads back a different vector.
   */
  const turn = (angle: number): Matrix3 => {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return new Matrix3().set(c, 0, s, 0, 1, 0, -s, 0, c)
  }

  it('builds, and each carries its nine numbers: three turns compose to the turn by their sum', async () => {
    const angles = [0.3, -1.1, 2.0]
    const turns = angles.map((angle) => uniform(turn(angle), 'mat3'))
    const out = new StorageBufferAttribute(new Float32Array(6), 1)
    const into = storage(out, 'float', 6)
    const kernel = Fn(() => {
      If(instanceIndex.equal(uint(0)), () => {
        const all = turns[0]!.mul(turns[1]!.mul(turns[2]!.mul(vec3(1, 0, 0))))
        // The middle one alone, on +Z: a kernel that bound one matrix three
        // times would pass the product above with three equal angles.
        const middle = turns[1]!.mul(vec3(0, 0, 1))
        into.element(0).assign(all.x)
        into.element(1).assign(all.y)
        into.element(2).assign(all.z)
        into.element(3).assign(middle.x)
        into.element(4).assign(middle.y)
        into.element(5).assign(middle.z)
      })
    })().compute(1)
    await checked(() => gpu.compute(kernel))
    expect(kernelWgsl(kernel).match(/mat3x3<f32>/g)?.length).toBe(3)
    const read = new Float32Array(await gpu.readBuffer(out))
    const sum = angles.reduce((a, b) => a + b, 0)
    const expected = [
      Math.cos(sum),
      0,
      -Math.sin(sum),
      Math.sin(angles[1]!),
      0,
      Math.cos(angles[1]!),
    ]
    // float32 through three matrix products.
    expected.forEach((value, k) => {
      expect(Math.abs(read[k]! - value)).toBeLessThanOrEqual(4 * 2 ** -23)
    })
    // A value swap rebuilds nothing and reaches the kernel.
    turns[1]!.value.copy(turn(0.5))
    await gpu.compute(kernel)
    const again = new Float32Array(await gpu.readBuffer(out))
    expect(Math.abs(again[3]! - Math.sin(0.5))).toBeLessThanOrEqual(2 ** -22)
    kernel.dispose()
  })
})

describe('a Data3DTexture of RGBA16F, linear', () => {
  it('is sampled at level 0 in a compute kernel: a texel at its center, the mean of eight between them', async () => {
    // 2 × 2 × 2, each texel its own index in R and its slice in G.
    const data = new Uint16Array(8 * 4)
    for (let k = 0; k < 8; k += 1) {
      data[k * 4] = DataUtils.toHalfFloat(k)
      data[k * 4 + 1] = DataUtils.toHalfFloat(k >> 2)
      data[k * 4 + 2] = DataUtils.toHalfFloat(0.25)
      data[k * 4 + 3] = DataUtils.toHalfFloat(1)
    }
    const map = new Data3DTexture(data, 2, 2, 2)
    map.format = RGBAFormat
    map.type = HalfFloatType
    map.magFilter = LinearFilter
    map.minFilter = LinearFilter
    map.generateMipmaps = false
    map.needsUpdate = true
    const node = texture3D(map)
    const at = [
      [0.25, 0.25, 0.25],
      [0.75, 0.25, 0.75],
      [0.5, 0.5, 0.5],
      [0.25, 0.25, 0.5],
    ] as const
    const out = new StorageBufferAttribute(new Float32Array(at.length * 4), 1)
    const into = storage(out, 'float', at.length * 4)
    const kernel = Fn(() => {
      If(instanceIndex.equal(uint(0)), () => {
        at.forEach(([x, y, z], k) => {
          const read = node.sample(vec3(x, y, z)).level(float(0))
          into.element(k * 4).assign(read.x)
          into.element(k * 4 + 1).assign(read.y)
          into.element(k * 4 + 2).assign(read.z)
          into.element(k * 4 + 3).assign(read.w)
        })
      })
    })().compute(1)
    await checked(() => gpu.compute(kernel))
    const wgsl = kernelWgsl(kernel)
    expect(wgsl).toMatch(/texture_3d<f32>/)
    expect(wgsl).toMatch(/\btextureSampleLevel\(/)
    const read = new Float32Array(await gpu.readBuffer(out))
    const texel = (k: number) => [...read.subarray(k * 4, k * 4 + 4)]
    // Texel 0, and texel 5 (x 1, y 0, z 1), each at its center, exactly.
    expect(texel(0)).toEqual([0, 0, 0.25, 1])
    expect(texel(1)).toEqual([5, 1, 0.25, 1])
    // The middle of the volume: the mean of all eight, 3.5, and of the two
    // slices. A filter that was nearest would read a whole number.
    expect(Math.abs(texel(2)[0]! - 3.5)).toBeLessThanOrEqual(HALF * 4)
    expect(Math.abs(texel(2)[1]! - 0.5)).toBeLessThanOrEqual(HALF)
    // Between the two slices over texel 0: 0 and 4.
    expect(Math.abs(texel(3)[0]! - 2)).toBeLessThanOrEqual(HALF * 4)
    kernel.dispose()
    map.dispose()
  })
})

describe('an R8 3D texture', () => {
  it('is read by textureLoad in a compute kernel, byte for byte', async () => {
    const size = [4, 4, 3] as const
    const count = size[0] * size[1] * size[2]
    const bytes = new Uint8Array(count)
    for (let k = 0; k < count; k += 1) bytes[k] = (k * 37 + 11) & 0xff
    const map = new Data3DTexture(bytes, ...size)
    map.format = RedFormat
    map.type = UnsignedByteType
    map.generateMipmaps = false
    map.needsUpdate = true
    const node = texture3D(map)
    const out = new StorageBufferAttribute(new Float32Array(count), 1)
    const into = storage(out, 'float', count)
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(uint(count)), () => {
        const x = int(instanceIndex.mod(uint(size[0])))
        const y = int(instanceIndex.div(uint(size[0])).mod(uint(size[1])))
        const z = int(instanceIndex.div(uint(size[0] * size[1])))
        into.element(instanceIndex).assign(node.load(ivec3(x, y, z)).x)
      })
    })().compute(count)
    await checked(() => gpu.compute(kernel))
    const wgsl = kernelWgsl(kernel)
    expect(wgsl).toMatch(/texture_3d<f32>/)
    expect(wgsl).toMatch(/\btextureLoad\(/)
    expect(wgsl).not.toMatch(/\btextureSample/)
    const read = new Float32Array(await gpu.readBuffer(out))
    // A byte over 255 is exact in float32 to the last place the division leaves.
    expect([...read].map((value) => Math.round(value * 255))).toEqual([
      ...bytes,
    ])
    kernel.dispose()
    map.dispose()
  })
})

describe('a table on the air’s bundle that no graph reads', () => {
  const sphere = () => new SphereGeometry(1, 16, 12)

  function patch(seaLevel?: number) {
    const resolution = 9
    const border = 2
    const stride = resolution + 2 * border
    const elevations = new Float32Array(stride * stride)
    if (seaLevel !== undefined)
      for (let i = 0; i < elevations.length; i += 1) elevations[i] = (i % 7) - 3
    return buildPatch({
      region: regionAddress(0, 0, 0, 0),
      resolution,
      border,
      elevations,
      cover: new Uint8Array(resolution * resolution * COVER_CHANNELS),
      bodyRadius: 1_737_400,
      ...(seaLevel === undefined ? {} : { seaLevel }),
    })
  }

  function ground(material: Mesh['material']): Mesh {
    const built = patch()
    const mesh = new Mesh(
      patchGeometry(built, new BufferAttribute(built.indices, 1)),
      material,
    )
    wearGround(mesh, built.anchor, 1_737_400)
    placeEye(mesh, { x: 0, y: 0, z: 0 }, 1, 2, 0)
    return mesh
  }

  function sea(material: Mesh['material']): Mesh {
    const built = patch(0)
    const mesh = new Mesh(
      sheetGeometry(built.water!, new BufferAttribute(built.indices, 1)),
      material,
    )
    wearSea(mesh, built.anchor)
    placeEye(mesh, { x: 0, y: 0, z: 0 }, 1, 2, 0)
    return mesh
  }

  const camera = () => {
    const eye = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    eye.position.z = 4
    eye.updateMatrixWorld()
    return eye
  }

  async function programOf(object: Object3D): Promise<string> {
    const scene = new Scene()
    scene.add(object)
    scene.updateMatrixWorld(true)
    const { vertexShader, fragmentShader } = await gpu.shader(
      object,
      camera(),
      scene,
    )
    return `${vertexShader}\n${fragmentShader}`
  }

  /**
   * A storage buffer's name carries its node's id, which counts every node
   * the session has built: the one part of a program that differs between
   * two builds of one graph.
   */
  const stable = (wgsl: string): string =>
    wgsl.replace(/NodeBuffer_\d+/g, 'NodeBuffer')

  /** The WGSL of every site that builds an air bundle, each under its name. */
  async function programs(): Promise<Record<string, string>> {
    const rig = cloudRig(gpu, 16, 16)
    try {
      await rig.system!.warm()
      const trace = rig.system!.resources.find(
        (held) => held.name === 'trace',
      ) as CloudTrace
      const composite = rig.scene.children.find(
        (child) => child.name === 'cloud composite',
      )!
      composite.visible = true
      const drawn = await gpu.shader(composite, rig.camera, rig.scene)
      return {
        // `materials.ts`, `planet.ts`, `terrain.ts`, `water.ts`.
        shell: await programOf(
          new Mesh(sphere(), createAtmosphereMaterial().material),
        ),
        sphere: await programOf(
          new Mesh(sphere(), createPlanetMaterial().material),
        ),
        ground: await programOf(ground(createTerrainMaterial().material)),
        sea: await programOf(sea(createWaterMaterial().material)),
        // `cloudUniforms.ts`, twice: the trace reads the served body's air,
        // and the composite the served and the second body's.
        trace: stable(kernelWgsl(trace.kernels()[0]!)),
        composite: stable(`${drawn.vertexShader}\n${drawn.fragmentShader}`),
      }
    } finally {
      rig.dispose()
    }
  }

  it('moves no WGSL at any of the six sites that build one', async () => {
    const control = 'multiScatter'
    const subject = 'sky'
    try {
      const whole = await programs()
      airMembers.stripped = [subject]
      const without = await programs()
      for (const site of Object.keys(whole))
        expect(without[site] === whole[site], site).toBe(true)
      // The control: a member the graphs do read is missed. Without it the
      // comparison above passes on a wrapper that strips nothing.
      airMembers.stripped = [control]
      await expect(programs()).rejects.toThrow()
    } finally {
      airMembers.stripped = []
    }
  }, 180_000)
})

const WORKSTATION = await adapterOffers('timestamp-query')

describe('re-uploading the phase atlas', () => {
  /*
   * 1024 × 64 RGBA16F, 524,288 B: what `CloudPhase` uploads again when the
   * served sun's angular radius moves 1% (§4.7). The premise is that the
   * upload fits a reset frame beside everything else it does, under 2 ms;
   * past that the convolution and its upload move to the atmosphere task.
   *
   * The figure is this machine's (Mac18,5, Apple M6): the median of 32
   * uploads, each timed from the write to the queue's own completion, with
   * nothing else on the GPU. A hosted adapter is a different queue, so the
   * bound is asserted only where the adapter offers timestamps, which is how
   * the suite tells a workstation from CI's paravirtual device.
   */
  const WIDTH = 1024
  const HEIGHT = 64
  const BOUND_MS = 2

  it.skipIf(!WORKSTATION)(
    'costs under 2 ms, the write and the queue together',
    async () => {
      const data = new Uint16Array(WIDTH * HEIGHT * 4)
      const map = new DataTexture(
        data,
        WIDTH,
        HEIGHT,
        RGBAFormat,
        HalfFloatType,
      )
      map.magFilter = LinearFilter
      map.minFilter = LinearFilter
      map.generateMipmaps = false
      map.needsUpdate = true
      renderer.initTexture(map)
      await device.queue.onSubmittedWorkDone()
      const held = () =>
        (
          renderer.backend as unknown as {
            get(texture: object): { texture?: GPUTexture }
          }
        ).get(map).texture
      const first = held()
      expect(first).toBeDefined()
      const writes: number[] = []
      const totals: number[] = []
      for (let k = 0; k < 32; k += 1) {
        data.fill(DataUtils.toHalfFloat(k / 32))
        const start = performance.now()
        map.needsUpdate = true
        renderer.initTexture(map)
        const written = performance.now()
        await device.queue.onSubmittedWorkDone()
        const done = performance.now()
        writes.push(written - start)
        totals.push(done - start)
      }
      // The same GPU texture, written again: an upload that reallocated
      // would be a different cost, and a different premise.
      expect(held()).toBe(first)
      const median = (values: number[]): number =>
        [...values].sort((a, b) => a - b)[values.length >> 1]!
      const [last] = await texels(map, '2d', [[WIDTH - 1, HEIGHT - 1]])
      expect(Math.abs(last![0]! - 31 / 32)).toBeLessThanOrEqual(HALF)
      console.log(
        `phase atlas re-upload, ${WIDTH} × ${HEIGHT} RGBA16F: write ${median(writes).toFixed(3)} ms, write and queue ${median(totals).toFixed(3)} ms (medians of 32; worst ${Math.max(...totals).toFixed(3)} ms)`,
      )
      expect(median(totals)).toBeLessThan(BOUND_MS)
      map.dispose()
    },
  )
})
