import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { logHub, RingBufferSink } from '@inertialref/shared'
import {
  AdditiveBlending,
  type ComputeNode,
  DirectionalLight,
  FloatType,
  type Layers,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type MRTNode,
  type Node,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  type PassNode,
  PerspectiveCamera,
  PlaneGeometry,
  QuadMesh,
  RenderTarget,
  Scene,
  SphereGeometry,
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  nodeObject,
  pass,
  positionGeometry,
  screenUV,
  storage,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec3,
  vec4,
  viewportSharedTexture,
} from 'three/tsl'
import { CloudFrameNode } from './cloudFrameNode.ts'
import type { CloudHistory } from './cloudHistory.ts'
import {
  markOverClouds,
  OVER_CLOUDS_LAYER,
  overClouds,
  UNDER_CLOUDS_LAYERS,
} from './cloudLayers.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { cloudStorageTexture } from './cloudNodes.ts'
import {
  CHAIN_PASS_LABEL,
  type CloudOverForm,
  CloudOverPassNode,
  type CloudOverSource,
  OVER_PASS_LABEL,
} from './cloudOverPass.ts'
import { type CloudRig, cloudRig } from './cloudSystemRig.ts'
import type { CloudTrace } from './cloudTrace.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import {
  installPassTimeline,
  namePass,
  passTimelineOf,
} from './passTimeline.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import { runQuadPasses } from './quadPass.ts'
import { sensorRadiance } from './radiance.ts'
import {
  attachmentFormat,
  attachmentType,
  sceneBackend,
  sceneLayout,
  type SceneLayout,
} from './sceneLayout.ts'
import { sensorMrt } from './sensorMrt.ts'
import { warmCompile, warmRenderer } from './warmup.ts'

/*
 * The clouds' two scene passes, built the way the sensor's chain builds them: a
 * scene pass of the layout's shape on the UNDER layers, the over pass beside
 * it in a post quad's dependency sum after the scene term, and the post
 * drawn from the top. The camera tests layers 0 and 1, as `<Canvas
 * onCreated>` sets it under the flag.
 *
 * The scene: an opaque ground over the upper half on layer 0; on the OVER
 * layer, an opaque square over the right half behind the ground and an
 * additive one over the left half in front of it. Upper left is ground plus
 * the additive square: pass B landed on pass A's color. Upper right is the
 * ground alone: the opaque square was depth-tested against pass A's depth.
 * The lower half is each square alone.
 *
 * Then the forms: pass B through the lean edit, held to the same frame and
 * read off the descriptor the device is handed; and, through the system's own
 * chain and composite, the frame's choice among the three.
 */

const SIZE = 32
const FOV = 60
const HALF_TAN = Math.tan((FOV / 2) * (Math.PI / 180))
const TIMESTAMPS = await adapterOffers('timestamp-query')

/** A half float's step at 1: the output attachment's resolution about its values here. */
const HALF = 2 ** -10
const GROUND = 0.25
const BEHIND = 0.5
const IN_FRONT = 0.5

/** Interior texels of the four quadrants, row 0 at the top. */
const QUADRANTS = [
  [8, 8],
  [24, 8],
  [8, 24],
  [24, 24],
] as const

let gpu: GpuSession
let renderer: WebGPURenderer
let device: GPUDevice
let layout: SceneLayout

beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
  renderer = gpu.renderer
  device = (renderer.backend as unknown as { device: GPUDevice }).device
  layout = sceneLayout(DEFAULT_PICTURE, sceneBackend(renderer))
})

afterAll(() => {
  gpu.dispose()
})

/**
 * Run `work` inside a validation scope of the test's own and fail on any
 * error either channel carried: a draw outside the harness's verbs is
 * watched by nobody else.
 */
async function checked(work: () => void): Promise<void> {
  const from = gpu.reported().length
  device.pushErrorScope('validation')
  try {
    work()
  } catch (failure) {
    await device.popErrorScope()
    throw failure
  }
  const scoped = await device.popErrorScope()
  if (scoped !== null) throw new Error(`the device reported: ${scoped.message}`)
  await device.queue.onSubmittedWorkDone()
  expect(
    gpu
      .reported()
      .slice(from)
      .filter((entry) => entry.type === 'error'),
  ).toEqual([])
}

/** The RGB of a 2D texture's texels, read by `textureLoad`, so nothing filters or flips them. */
async function texels(
  map: Texture,
  at: readonly (readonly [number, number])[],
): Promise<number[][]> {
  const out = new StorageBufferAttribute(new Float32Array(at.length * 3), 1)
  const into = storage(out, 'float', at.length * 3)
  const kernel = Fn(() => {
    at.forEach(([x, y], k) => {
      const read = textureLoad(map, ivec2(x, y))
      If(instanceIndex.equal(uint(0)), () => {
        into.element(k * 3).assign(read.x)
        into.element(k * 3 + 1).assign(read.y)
        into.element(k * 3 + 2).assign(read.z)
      })
    })
  })().compute(1)
  await gpu.compute(kernel)
  const values = new Float32Array(await gpu.readBuffer(out))
  return at.map((_, k) => [...values.subarray(k * 3, k * 3 + 3)])
}

function expectNear(
  read: number[][],
  expected: readonly (readonly number[])[],
): void {
  read.forEach((channels, k) => {
    channels.forEach((channel, c) => {
      expect(
        Math.abs(channel - expected[k]![c]!),
        `texel ${k}, channel ${c}: ${channel}`,
      ).toBeLessThanOrEqual(HALF)
    })
  })
}

/** Every texel of a 2D texture as RGBA floats, row-major from the top, read by `textureLoad`. */
const readers = new Map<
  Texture,
  { kernel: ComputeNode; out: StorageBufferAttribute; texels: number }
>()
async function whole(map: Texture): Promise<Float32Array> {
  const { width, height } = map.image as { width: number; height: number }
  let read = readers.get(map)
  if (read === undefined || read.texels !== width * height) {
    const texels = width * height
    const out = new StorageBufferAttribute(new Float32Array(texels * 4), 4)
    const into = storage(out, 'vec4', texels)
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(uint(texels)), () => {
        const at = ivec2(
          int(instanceIndex.mod(uint(width))),
          int(instanceIndex.div(uint(width))),
        )
        into.element(instanceIndex).assign(textureLoad(map, at))
      })
    })().compute(texels)
    read = { kernel, out, texels }
    readers.set(map, read)
  }
  await gpu.compute(read.kernel)
  return new Float32Array(await gpu.readBuffer(read.out))
}

/** Every row of a scene target, by name. */
async function rows(target: RenderTarget): Promise<Map<string, Float32Array>> {
  const read = new Map<string, Float32Array>()
  for (const texture of target.textures)
    read.set(texture.name, await whole(texture))
  return read
}

const bits = (values: Float32Array): Uint32Array =>
  new Uint32Array(values.buffer.slice(0))

/**
 * Every render pass begun while `work` runs, as the device is handed it:
 * copied at the call, because three writes its cached descriptor again at
 * the next pass.
 */
function passesBegun(work: () => void): GPURenderPassDescriptor[] {
  const begun: GPURenderPassDescriptor[] = []
  const create = device.createCommandEncoder
  device.createCommandEncoder = (descriptor) => {
    const encoder = create.call(device, descriptor)
    const begin = encoder.beginRenderPass
    encoder.beginRenderPass = (pass) => {
      begun.push({
        ...pass,
        colorAttachments: [...pass.colorAttachments].map((attachment) =>
          attachment === null ? null : { ...attachment },
        ),
        ...(pass.depthStencilAttachment === undefined
          ? {}
          : { depthStencilAttachment: { ...pass.depthStencilAttachment } }),
      })
      return begin.call(encoder, pass)
    }
    return encoder
  }
  try {
    work()
  } finally {
    delete (device as { createCommandEncoder?: unknown }).createCommandEncoder
  }
  return begun
}

/** Pass B among the passes of a frame: the one that loads a multisampled color. */
const passB = (
  begun: readonly GPURenderPassDescriptor[],
): GPURenderPassDescriptor | undefined =>
  begun.find((pass) => {
    const [first] = pass.colorAttachments
    return (
      first !== null &&
      first !== undefined &&
      first.loadOp === 'load' &&
      first.resolveTarget !== undefined
    )
  })

/** A plane facing the camera, `depth` meters down its axis, over the image rectangle [x0, x1] × [y0, y1], y up. */
function facing(
  depth: number,
  [x0, x1, y0, y1]: readonly [number, number, number, number],
  material: NodeMaterial,
): Mesh {
  const scale = depth * HALF_TAN
  const mesh = new Mesh(
    new PlaneGeometry((x1 - x0) * scale, (y1 - y0) * scale),
    material,
  )
  mesh.position.set(((x0 + x1) / 2) * scale, ((y0 + y1) / 2) * scale, -depth)
  return mesh
}

function colored(color: Node<'vec4'>): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.colorNode = color
  return material
}

function added(color: Node<'vec4'>): MeshBasicNodeMaterial {
  const material = colored(color)
  material.transparent = true
  material.blending = AdditiveBlending
  material.depthWrite = false
  return material
}

/** How many times each mesh was drawn since the last reset. */
function counted(...meshes: Mesh[]): { draws: number[]; reset(): void } {
  const draws = meshes.map(() => 0)
  meshes.forEach((mesh, k) => {
    mesh.onBeforeRender = () => {
      draws[k]! += 1
    }
  })
  return { draws, reset: () => draws.fill(0) }
}

interface Chain {
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  readonly scenePass: PassNode
  readonly mrt: MRTNode
  readonly over: CloudOverPassNode
  /** The two passes for the frame: the scene pass on UNDER and pass B on, or neither. */
  passes(on: boolean): void
  frame(): void
  dispose(): void
}

/**
 * Pass A's name, which pass B hands back after its render: not the sensor's
 * own 'scene', so a pass that put back a literal of its own would show.
 */
const PASS_A = 'pass A'

/** The sensor's scene pass and the over pass, in a post quad's dependency sum. */
function chain(scene: Scene, composite: CloudOverSource | null = null): Chain {
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 1e10)
  camera.layers.enable(OVER_CLOUDS_LAYER)
  camera.updateMatrixWorld()
  const mrt = sensorMrt(layout)
  // As `createSensor` configures its pass: the layout's samples, depth type,
  // MRT and formats, drawn once per render call.
  const scenePass = pass(scene, camera, { samples: layout.samples })
  namePass(scenePass.renderTarget, PASS_A)
  scenePass.renderTarget.depthTexture!.type =
    layout.depthType ?? scenePass.renderTarget.depthTexture!.type
  scenePass.setMRT(mrt)
  for (const row of layout.attachments) {
    const texture = scenePass.getTextureNode(row.name).value
    texture.format = attachmentFormat(row)
    texture.type = attachmentType(row)
  }
  scenePass.updateBeforeType = NodeUpdateType.RENDER
  const over = new CloudOverPassNode(
    scene,
    camera,
    scenePass.renderTarget,
    mrt,
    composite,
  )
  const post = new NodeMaterial()
  post.fragmentNode = vec4(scenePass.getTextureNode().rgb.min(65_504).mul(0), 0)
    .add(nodeObject(over).min(65_504).mul(0))
    .add(vec4(0, 0, 0, 1))
  const quad = new QuadMesh(post)
  const output = new RenderTarget(4, 4, { type: FloatType, depthBuffer: false })
  return {
    scene,
    camera,
    scenePass,
    mrt,
    over,
    passes(on) {
      // `@types/three` declares no null; r185 takes it as the camera's own
      // mask (`PassNode.js:518`), the one-pass frame.
      scenePass.setLayers((on ? UNDER_CLOUDS_LAYERS : null) as Layers)
      over.form = on ? 'passes' : null
    },
    frame() {
      runQuadPasses(renderer, quad, { linear: true }, (draw) => {
        draw('post', output, post)
      })
    },
    dispose() {
      scenePass.dispose()
      output.dispose()
      post.dispose()
    },
  }
}

/** The ground on layer 0 and the two squares on the OVER layer. */
function layered(): {
  readonly scene: Scene
  readonly ground: Mesh
  readonly behind: Mesh
  readonly inFront: Mesh
} {
  const ground = facing(10, [-1.5, 1.5, 0, 1.5], colored(vec4(GROUND, 0, 0, 1)))
  const behind = facing(20, [0, 1.5, -1.5, 1.5], colored(vec4(0, BEHIND, 0, 1)))
  const inFront = facing(
    5,
    [-1.5, 0, -1.5, 1.5],
    added(vec4(0, 0, IN_FRONT, 1)),
  )
  markOverClouds(behind)
  markOverClouds(inFront)
  const scene = new Scene()
  scene.add(ground, behind, inFront)
  scene.updateMatrixWorld(true)
  return { scene, ground, behind, inFront }
}

const LAYERED = [
  [GROUND, 0, IN_FRONT],
  [GROUND, 0, 0],
  [0, 0, IN_FRONT],
  [0, BEHIND, 0],
] as const

describe('the over pass', () => {
  it('loads what the pass under the clouds drew, and draws only the OVER layer', async () => {
    const { scene, ground, behind, inFront } = layered()
    const frame = chain(scene)
    const draws = counted(ground, behind, inFront)
    frame.passes(true)
    await checked(() => frame.frame())
    // Each mesh once: the ground in pass A only, the squares in pass B only.
    expect(draws.draws).toEqual([1, 1, 1])
    expectNear(
      await texels(frame.scenePass.renderTarget.texture, QUADRANTS),
      LAYERED,
    )
    // Off, one scene pass draws all three, and the frame is the same frame.
    draws.reset()
    frame.passes(false)
    await checked(() => frame.frame())
    expect(draws.draws).toEqual([1, 1, 1])
    expectNear(
      await texels(frame.scenePass.renderTarget.texture, QUADRANTS),
      LAYERED,
    )
    frame.dispose()
  })

  it('under lean discards each multisampled color beneath its resolve and stores its depth, and draws the same frame', async () => {
    const { scene } = layered()
    const frame = chain(scene)
    frame.passes(true)
    await checked(() => frame.frame())
    const stored = await rows(frame.scenePass.renderTarget)
    const before = passB(passesBegun(() => frame.frame()))!
    expect(before.colorAttachments.map((one) => one?.storeOp)).toEqual(
      layout.attachments.map(() => 'store'),
    )
    // The opaque square behind the ground writes depth, so the count says
    // pass B's depth stays writable.
    expect(overClouds(scene)).toBe('depth')
    frame.over.form = 'lean'
    frame.over.depthReadOnly = false
    let begun: GPURenderPassDescriptor[] = []
    await checked(() => {
      begun = passesBegun(() => frame.frame())
    })
    const lean = passB(begun)!
    expect(lean.colorAttachments.map((one) => one?.storeOp)).toEqual(
      layout.attachments.map(() => 'discard'),
    )
    // Every one of them resolves, which is what keeps the frame.
    expect(
      lean.colorAttachments.every((one) => one?.resolveTarget !== undefined),
    ).toBe(true)
    expect(lean.depthStencilAttachment).toMatchObject({
      depthLoadOp: 'load',
      depthStoreOp: 'store',
    })
    // The pass under the clouds is three's own: only pass B is edited.
    expect(
      begun.filter((pass) =>
        [...pass.colorAttachments].some((one) => one?.storeOp === 'discard'),
      ),
    ).toHaveLength(1)
    const discarded = await rows(frame.scenePass.renderTarget)
    for (const [name, values] of stored)
      expect(bits(discarded.get(name)!), name).toEqual(bits(values))
    // And the frame after it, which loads nothing pass B dropped: the pass
    // under the clouds clears.
    await checked(() => frame.frame())
    const again = await rows(frame.scenePass.renderTarget)
    for (const [name, values] of stored)
      expect(bits(again.get(name)!), name).toEqual(bits(values))
    frame.dispose()
  })

  it('under lean reads depth without storing it where nothing over the clouds writes it', async () => {
    const { scene, behind } = layered()
    // Only the additive square is left over the clouds.
    scene.remove(behind)
    expect(overClouds(scene)).toBe('drawn')
    const frame = chain(scene)
    frame.passes(true)
    await checked(() => frame.frame())
    const stored = await rows(frame.scenePass.renderTarget)
    frame.over.form = 'lean'
    frame.over.depthReadOnly = true
    let begun: GPURenderPassDescriptor[] = []
    // Checked: a pipeline that wrote depth here would be refused, and the
    // pass with it.
    await checked(() => {
      begun = passesBegun(() => frame.frame())
    })
    const depth = passB(begun)!.depthStencilAttachment!
    expect(depth.depthReadOnly).toBe(true)
    expect(depth.depthLoadOp).toBeUndefined()
    expect(depth.depthStoreOp).toBeUndefined()
    const read = await rows(frame.scenePass.renderTarget)
    for (const [name, values] of stored)
      expect(bits(read.get(name)!), name).toEqual(bits(values))
    // The additive square is still tested against the ground's depth and
    // lands on its color.
    expectNear(await texels(frame.scenePass.renderTarget.texture, QUADRANTS), [
      [GROUND, 0, IN_FRONT],
      [GROUND, 0, 0],
      [0, 0, IN_FRONT],
      [0, 0, 0],
    ])
    frame.dispose()
  })

  it('leaves the device and the backend as it found them after a lean pass', async () => {
    const { scene } = layered()
    const frame = chain(scene)
    const backend = renderer.backend as unknown as { beginRender: unknown }
    const beginRender = backend.beginRender
    const own = Object.hasOwn(backend, 'beginRender')
    frame.passes(true)
    frame.over.form = 'lean'
    await checked(() => frame.frame())
    expect(backend.beginRender).toBe(beginRender)
    expect(Object.hasOwn(backend, 'beginRender')).toBe(own)
    expect(Object.hasOwn(device, 'createCommandEncoder')).toBe(false)
    frame.dispose()
  })

  it('turns lean off, once and aloud, when something over the clouds reads the framebuffer', async () => {
    const sink = new RingBufferSink()
    const detach = logHub.addSink(sink)
    const { scene } = layered()
    // A square over the clouds whose color is the frame behind it: three
    // ends pass B to copy the frame and resumes it from its own descriptor,
    // which loads the samples the lean pass was begun to drop.
    const material = new MeshBasicNodeMaterial()
    material.colorNode = viewportSharedTexture(screenUV)
    material.transparent = true
    material.depthWrite = false
    const reads = facing(3, [-0.5, 0.5, -0.5, 0.5], material)
    markOverClouds(reads)
    scene.add(reads)
    scene.updateMatrixWorld(true)
    const frame = chain(scene)
    try {
      frame.passes(true)
      frame.over.form = 'lean'
      await checked(() => frame.frame())
      const warned = () =>
        sink
          .records()
          .filter((record) => record.scope === 'game.clouds')
          .map((record) => record.fields['cause'])
      expect(warned()).toEqual([
        'something over the clouds read the framebuffer',
      ])
      // From here the node draws pass B as three builds it, whatever the
      // form asked of it.
      let begun: GPURenderPassDescriptor[] = []
      await checked(() => {
        begun = passesBegun(() => frame.frame())
      })
      expect(
        begun.flatMap((pass) =>
          [...pass.colorAttachments].map((one) => one?.storeOp),
        ),
      ).not.toContain('discard')
      expect(warned()).toHaveLength(1)
    } finally {
      detach()
      frame.dispose()
      material.dispose()
    }
  })

  it('in the chain form lands on the rows the scene pass resolves into, and follows them to another size', async () => {
    // A stand-in for the composite, alone in a scene of its own: a plane
    // over the frame that adds a quarter of blue to what it lands on.
    const material = added(vec4(0, 0, 0.25, 1))
    material.depthTest = false
    material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    const plane = new Mesh(new PlaneGeometry(2, 2), material)
    plane.layers.enableAll()
    plane.frustumCulled = false
    const alone = new Scene()
    alone.add(plane)
    const { scene, ground, behind, inFront } = layered()
    const frame = chain(scene, { over: alone })
    const draws = counted(ground, behind, inFront)
    const lit = LAYERED.map(([r, g, b]) => [r, g, b + 0.25])
    try {
      // One scene pass on every layer, then the plane over its resolve.
      frame.passes(false)
      frame.over.form = 'chain'
      await checked(() => frame.frame())
      expect(draws.draws).toEqual([1, 1, 1])
      expectNear(
        await texels(frame.scenePass.renderTarget.texture, QUADRANTS),
        lit,
      )
      // The scene target is made again at the new size, and its GPU
      // textures with it: a chain form still pointed at the ones it first
      // found would draw into textures the pass has left.
      renderer.setSize(2 * SIZE, 2 * SIZE, false)
      await checked(() => frame.frame())
      await checked(() => frame.frame())
      expect(frame.scenePass.renderTarget.width).toBe(2 * SIZE)
      expectNear(
        await texels(
          frame.scenePass.renderTarget.texture,
          QUADRANTS.map(([x, y]) => [2 * x, 2 * y] as const),
        ),
        lit,
      )
    } finally {
      renderer.setSize(SIZE, SIZE, false)
      frame.dispose()
      material.dispose()
    }
  })

  it('puts the camera, the target, the MRT and the clear back after pass B', async () => {
    const { scene } = layered()
    const frame = chain(scene)
    frame.passes(true)
    await checked(() => frame.frame())
    // Called alone, so the post's own restore is not the one being read.
    const elsewhere = new RenderTarget(4, 4, { depthBuffer: false })
    const mask = frame.camera.layers.mask
    renderer.setRenderTarget(elsewhere)
    try {
      await checked(() => {
        frame.over.updateBefore({ renderer } as unknown as NodeFrame)
      })
      expect(renderer.getRenderTarget()).toBe(elsewhere)
      expect(renderer.getMRT()).toBeNull()
      expect(renderer.autoClear).toBe(true)
      expect(frame.camera.layers.mask).toBe(mask)
    } finally {
      renderer.setRenderTarget(null)
      elsewhere.dispose()
      frame.dispose()
    }
  })

  it('runs a compute issued from the composite’s updateBefore before pass B’s draws', async () => {
    const { scene } = layered()
    const frame = chain(scene)
    const written = cloudStorageTexture(1, 1, 'rgba16float', 'over value')
    const value = uniform(0)
    const kernel = Fn(() => {
      textureStore(written, uvec2(0, 0), vec4(value, 0, 0, 1))
    })().compute(1)
    const seen = { target: false, runs: 0 }
    const node = new CloudFrameNode({
      inFrame: true,
      run(three) {
        three.compute(kernel)
        seen.runs += 1
        seen.target = three.getRenderTarget() === frame.scenePass.renderTarget
      },
      failed() {},
    })
    // The composite: opaque on the OVER layer, first in pass B.
    // It covers the left half at 2 m with the kernel's value; a square after
    // it, over the right half's lower quadrant, reads the value too.
    const composite = facing(
      2,
      [-1.5, 0, -1.5, 1.5],
      colored(
        vec4(textureLoad(written, ivec2(0, 0)).x, 0, 0, float(1).add(node)),
      ),
    )
    composite.renderOrder = -1e6
    const reader = facing(
      3,
      [0, 1.5, -1.5, 0],
      colored(vec4(0, textureLoad(written, ivec2(0, 0)).x, 0, 1)),
    )
    reader.renderOrder = 1
    markOverClouds(composite)
    markOverClouds(reader)
    scene.add(composite, reader)
    scene.updateMatrixWorld(true)
    frame.passes(true)
    value.value = 0.125
    await checked(() => frame.frame())
    value.value = 0.375
    await checked(() => frame.frame())
    expect(seen).toEqual({ target: true, runs: 2 })
    const [left, right] = await texels(frame.scenePass.renderTarget.texture, [
      [8, 24],
      [24, 24],
    ])
    expect(Math.abs(left![0]! - 0.375)).toBeLessThanOrEqual(HALF)
    expect(Math.abs(right![1]! - 0.375)).toBeLessThanOrEqual(HALF)
    frame.dispose()
    written.dispose()
  })

  it.each([
    ['every layer', 0, true],
    ['layer 0 alone', 1, false],
  ] as const)(
    'with the light on %s, the pipelines pass B builds past the boot warm-up: %i',
    async (_, built, everyLayer) => {
      const { scene } = layered()
      const light = new DirectionalLight(0xffffff, 1)
      light.position.set(0, 0, 1)
      if (everyLayer) light.layers.enableAll()
      scene.add(light)
      const lit = facing(
        4,
        [0, 1.5, 0, 1.5],
        new MeshStandardNodeMaterial({ color: 0x808080 }),
      )
      markOverClouds(lit)
      scene.add(lit)
      scene.updateMatrixWorld(true)
      const frame = chain(scene)
      frame.passes(true)
      // The boot warm-up, through the app's own recipe and the camera that
      // tests both layers.
      await warmCompile(warmRenderer(renderer, layout), {
        object: lit,
        camera: frame.camera,
        scene,
      })
      // A frame without it builds everything else the chain draws.
      lit.visible = false
      await checked(() => frame.frame())
      lit.visible = true
      const before = gpu.pipelinesBuilt()
      await checked(() => frame.frame())
      expect(gpu.pipelinesBuilt() - before).toBe(built)
      frame.dispose()
    },
  )

  it('lets a camera that does not test layer 1 compile nothing on a marked object, and one that does compile it', async () => {
    const marked = facing(
      6,
      [-1, 1, -1, 1],
      colored(vec4(0.0625, 0.125, 0.1875, 1)),
    )
    markOverClouds(marked)
    const scene = new Scene()
    scene.add(marked)
    scene.updateMatrixWorld(true)
    const unaware = new PerspectiveCamera(FOV, 1, 0.05, 1e10)
    unaware.updateMatrixWorld()
    const aware = unaware.clone()
    aware.layers.enable(OVER_CLOUDS_LAYER)
    const warm = warmRenderer(renderer, layout)
    const before = gpu.pipelinesBuilt()
    await warmCompile(warm, { object: marked, camera: unaware, scene })
    expect(gpu.pipelinesBuilt()).toBe(before)
    await warmCompile(warm, { object: marked, camera: aware, scene })
    expect(gpu.pipelinesBuilt()).toBe(before + 1)
  })
})

/** Three's render tree: what a throw inside nested work would leave pointing into it. */
interface Tree {
  readonly _currentRenderContext: object | null
  readonly _callDepth: number
  readonly lighting: { readonly _cache: readonly unknown[] }
}
const treeOf = (three: WebGPURenderer) => {
  const tree = three as unknown as Tree
  return {
    context: tree._currentRenderContext,
    depth: tree._callDepth,
    lights: tree.lighting._cache.length,
  }
}

/**
 * A frame node over `run` in a composite that adds nothing, first in pass B,
 * so a frame with it draws exactly `LAYERED`.
 */
function framed(scene: Scene, run: (three: WebGPURenderer) => void) {
  const driver = { inFrame: true, runs: 0, failures: 0, run }
  const node = new CloudFrameNode({
    get inFrame() {
      return driver.inFrame
    },
    run(three) {
      driver.runs += 1
      driver.run(three)
    },
    failed() {
      driver.failures += 1
    },
  })
  const composite = facing(
    2,
    [-1.5, 1.5, -1.5, 1.5],
    added(vec4(0, 0, 0, 0).add(node)),
  )
  composite.renderOrder = -1e6
  markOverClouds(composite)
  scene.add(composite)
  scene.updateMatrixWorld(true)
  return { driver, composite }
}

describe('the frame node in pass B', () => {
  it('reports a throw in the frame’s cloud work once, puts the renderer back, and pass B draws on', async () => {
    const sink = new RingBufferSink()
    const detach = logHub.addSink(sink)
    const elsewhere = new RenderTarget(4, 4, { depthBuffer: false })
    const thrown = new Scene()
    const trap = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial())
    trap.position.z = -1
    trap.onBeforeRender = () => {
      throw new Error('inside a nested render')
    }
    thrown.add(trap)
    thrown.updateMatrixWorld(true)
    // Its own camera: pass B's tests the OVER layer alone while it draws.
    const looking = new PerspectiveCamera(FOV, 1, 0.05, 10)
    looking.updateMatrixWorld()
    const { scene, ground, behind, inFront } = layered()
    const frame = chain(scene)
    // A render nested in the cloud work that throws halfway: three leaves its
    // context, call depth and lights pointing into it.
    let throwing = false
    const { driver } = framed(scene, (three) => {
      if (!throwing) return
      three.setRenderTarget(elsewhere)
      three.setMRT(null)
      three.render(thrown, looking)
    })
    const draws = counted(ground, behind, inFront)
    try {
      frame.passes(true)
      // A frame that builds the chain's pipelines, then two that throw.
      await checked(() => frame.frame())
      throwing = true
      draws.reset()
      await checked(() => frame.frame())
      await checked(() => frame.frame())
      const reports = sink
        .records()
        .filter((record) => record.scope === 'game.clouds')
      expect(reports.map((record) => record.level)).toEqual(['warn'])
      expect(reports[0]!.fields['cause']).toBe('Error: inside a nested render')
      // Both frames whole: the overlays pass B draws after the composite
      // landed on pass A's color, and three's tree is the top level's again.
      expect(driver.runs).toBe(3)
      // Told every time, though reported once: each frame's composite is
      // made inert by its own frame's failure.
      expect(driver.failures).toBe(2)
      expect(draws.draws).toEqual([2, 2, 2])
      expectNear(
        await texels(frame.scenePass.renderTarget.texture, QUADRANTS),
        LAYERED,
      )
      expect(treeOf(renderer)).toEqual({ context: null, depth: -1, lights: 0 })
    } finally {
      detach()
      frame.dispose()
      elsewhere.dispose()
    }
  })

  it('runs no cloud work when compileAsync runs its updateBefore outside a frame', async () => {
    /*
     * Three runs a render-scoped node's `updateBefore` once per render id,
     * and a compile from the top level runs at id 0, which is also where a
     * fresh node's record starts: a compile reaches the frame node only once
     * the node has run in a render. So each case draws a frame first, and the
     * control shows the compile then does reach it.
     */
    for (const inFrame of [true, false]) {
      const { scene } = layered()
      const frame = chain(scene)
      const { driver, composite } = framed(scene, () => {})
      frame.passes(true)
      await checked(() => frame.frame())
      const drawn = driver.runs
      driver.inFrame = inFrame
      const target = renderer.getRenderTarget()
      const mrt = renderer.getMRT()
      let compiled: Promise<unknown>
      try {
        renderer.setRenderTarget(frame.scenePass.renderTarget)
        renderer.setMRT(frame.mrt)
        compiled = renderer.compileAsync(composite, frame.camera, scene)
      } finally {
        renderer.setMRT(mrt)
        renderer.setRenderTarget(target)
      }
      await compiled
      expect(driver.runs - drawn, `in a frame: ${inFrame}`).toBe(
        inFrame ? 1 : 0,
      )
      frame.dispose()
    }
  })
})

describe.skipIf(!TIMESTAMPS)('the over pass on the pass timeline', () => {
  it('is named for what it is, and gives the scene pass its name back', async () => {
    const stop = installPassTimeline(renderer)
    const { scene } = layered()
    const frame = chain(scene)
    try {
      const timeline = passTimelineOf(renderer)
      expect(timeline).not.toBeNull()
      const draw = () => frame.frame()
      frame.passes(true)
      await checked(draw) // compile outside the measurement
      const both = await timeline!.measure(draw, 4)
      expect(both.dropped).toBe(0)
      // Encode order: the post's pass begins before the passes its
      // dependencies draw. Four frames, each of them once, so pass A is named
      // `scene` again after every pass B.
      expect(both.passes.map((pass) => [pass.label, pass.count])).toEqual([
        ['post', 1],
        [PASS_A, 1],
        [OVER_PASS_LABEL, 1],
      ])
      // The lean edit begins the pass three named: the timeline's writes are
      // on the descriptor it copies.
      frame.over.form = 'lean'
      await checked(draw)
      const lean = await timeline!.measure(draw, 4)
      expect(lean.dropped).toBe(0)
      expect(lean.passes.map((pass) => [pass.label, pass.count])).toEqual([
        ['post', 1],
        [PASS_A, 1],
        [OVER_PASS_LABEL, 1],
      ])
      frame.passes(false)
      const one = await timeline!.measure(draw, 2)
      expect(one.passes.map((pass) => pass.label)).toEqual(['post', PASS_A])
    } finally {
      stop()
      frame.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* The forms, through the system                                              */
/* ------------------------------------------------------------------------- */

/*
 * The sensor's own chain with the cloud system in it: the eye 100 m up under
 * overcast's 300 m base, looking straight up, nothing between it and the
 * deck. The frame's form is the system's choice from the `over` lever and
 * the marks in the scene, and everything below is read off what that choice
 * draws.
 */
describe('the composite’s form, chosen a frame at a time', () => {
  const FORMS = ['passes', 'lean', 'chain'] as const
  let rig: CloudRig

  beforeAll(async () => {
    rig = cloudRig(gpu, SIZE, SIZE, { levers: { weather: 'overcast' } })
    await rig.sensor.warm()
    await rig.system!.warm()
  }, 180_000)

  afterAll(() => {
    rig?.dispose()
  })

  const set = (levers: Partial<CloudLevers>): void => {
    rig.levers = {
      ...DEFAULT_CLOUD_LEVERS,
      weather: 'overcast',
      on: true,
      // Held, so two frames four apart trace the same rays.
      jitterFrame: 0,
      ...levers,
    }
  }
  const frames = (n: number): void => {
    for (let k = 0; k < n; k += 1) rig.frame()
  }
  const output = (): Promise<Float32Array> =>
    whole(rig.sensor.sceneTarget.texture)
  const pixel = (values: Float32Array, [x, y]: readonly [number, number]) =>
    [...values.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)] as const

  /** The largest difference in any channel of any texel, over the larger image's peak. */
  const apart = (a: Float32Array, b: Float32Array): number => {
    let peak = 0
    let worst = 0
    for (let i = 0; i < a.length; i += 1) {
      peak = Math.max(peak, Math.abs(a[i]!), Math.abs(b[i]!))
      worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
    }
    return worst / peak
  }

  /** The form the last frame took, by the passes the device was handed. */
  function formOf(begun: readonly GPURenderPassDescriptor[]): CloudOverForm {
    const over = passB(begun)
    if (over === undefined) return 'chain'
    return over.colorAttachments[0]?.storeOp === 'discard' ? 'lean' : 'passes'
  }
  const drawn = (): CloudOverForm => formOf(passesBegun(() => rig.frame()))

  /** A ball `distance` meters up the camera's axis, `across` of it to the side, lit by nothing. */
  function ball(distance: number, across: number, marked: boolean): Mesh {
    const material = sensorRadiance(new MeshBasicNodeMaterial(), marked)
    material.colorNode = vec3(0.8, 0.2, 0.1)
    const mesh = new Mesh(new SphereGeometry(distance / 8, 12, 8), material)
    mesh.position.set(distance * across, distance, 0)
    if (marked) markOverClouds(mesh)
    rig.scene.add(mesh)
    rig.scene.updateMatrixWorld(true)
    return mesh
  }
  const drop = (...meshes: Mesh[]): void => {
    for (const mesh of meshes) {
      rig.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as MeshBasicNodeMaterial).dispose()
    }
  }
  /** The pixel a ball `across` of its distance to the side stands at. */
  const standsAt = (across: number): [number, number] => [
    Math.floor(SIZE / 2 + (across / HALF_TAN) * (SIZE / 2)),
    SIZE / 2,
  ]

  it('draws a marked mesh in front of the deck and one behind it over the clouds, and an unmarked one behind it under them', async () => {
    // 40 m up is under the deck's 300 m base; 8 km up is over its top.
    const near = ball(40, -0.3, true)
    const far = ball(8_000, 0.3, true)
    try {
      set({ on: false })
      frames(2)
      const plain = await output()
      set({})
      frames(24)
      const clouded = await output()
      // The control: the deck is over the frame.
      expect(apart(clouded, plain)).toBeGreaterThan(0.05)
      // Both marked balls are their own color, whatever the deck holds in
      // front of them: drawn after the composite, unattenuated.
      for (const across of [-0.3, 0.3]) {
        const at = standsAt(across)
        const own = pixel(plain, at)
        pixel(clouded, at).forEach((channel, c) => {
          expect(
            Math.abs(channel - own[c]!),
            `marked at ${across}, channel ${c}`,
          ).toBeLessThanOrEqual(2 * HALF * Math.abs(own[c]!) + 1e-7)
        })
      }
      // The same ball behind the deck without its mark is the scene's, and
      // the deck stands in front of it.
      drop(far)
      const under = ball(8_000, 0.3, false)
      try {
        frames(24)
        const veiled = pixel(await output(), standsAt(0.3))
        const own = pixel(plain, standsAt(0.3))
        // Its red is four times its green; the deck's light is gray.
        expect(own[0]! / own[1]!).toBeGreaterThan(3)
        expect(veiled[0]! / veiled[1]!).toBeLessThan(1.5)
      } finally {
        drop(under)
      }
    } finally {
      drop(near)
      set({ on: false })
      rig.frame()
    }
  }, 120_000)

  /*
   * The overlay guard's frame: a station in front of the deck, opaque,
   * written into the depth the trace stops at, and carrying no mark. Nothing
   * there is drawn over the clouds, and two scene passes still walk the
   * scene twice to find that out.
   */
  it('under chain, walks the scene once on a frame with an opaque object in front of the deck and nothing marked over the clouds', async () => {
    const station = ball(40, -0.3, false)
    let walks = 0
    const held = rig.scene.onBeforeRender
    rig.scene.onBeforeRender = () => {
      walks += 1
    }
    try {
      set({ on: false })
      frames(2)
      const plain = await output()
      const walked: Record<string, [CloudOverForm, number]> = {}
      const images: Record<string, Float32Array> = {}
      for (const over of FORMS) {
        set({ over })
        frames(24)
        walks = 0
        const form = drawn()
        walked[over] = [form, walks]
        images[over] = await output()
      }
      expect(walked).toEqual({
        passes: ['passes', 2],
        lean: ['lean', 2],
        chain: ['chain', 1],
      })
      // With nothing over the clouds but the composite, lean's pass B reads
      // depth and stores none.
      set({ over: 'lean' })
      expect(
        passB(passesBegun(() => rig.frame()))!.depthStencilAttachment!
          .depthReadOnly,
      ).toBe(true)
      const at = standsAt(-0.3)
      for (const over of FORMS) {
        // The deck is in the frame, and the station in front of it is the
        // scene's own pixel: the composite leaves what stands before the
        // cloud alone.
        expect(apart(images[over]!, plain), over).toBeGreaterThan(0.05)
        const own = pixel(plain, at)
        pixel(images[over]!, at).forEach((channel, c) => {
          expect(
            Math.abs(channel - own[c]!),
            `${over}, channel ${c}`,
          ).toBeLessThanOrEqual(2 * HALF * Math.abs(own[c]!) + 1e-7)
        })
      }
    } finally {
      rig.scene.onBeforeRender = held
      drop(station)
      set({ on: false })
      rig.frame()
    }
  }, 120_000)

  it('takes the form its lever names, and under chain goes back to two passes on the frame a mark draws', async () => {
    const mark = ball(40, -0.3, true)
    try {
      mark.visible = false
      set({ over: 'passes' })
      frames(2)
      expect(drawn()).toBe('passes')
      set({ over: 'lean' })
      expect(drawn()).toBe('lean')
      set({ over: 'chain' })
      expect(drawn()).toBe('chain')
      mark.visible = true
      expect(drawn()).toBe('passes')
      mark.visible = false
      expect(drawn()).toBe('chain')
      // Lean's depth is read-only with nothing over the clouds but the
      // composite, and stored when a mark that writes depth draws.
      set({ over: 'lean' })
      const depthOf = () =>
        passB(passesBegun(() => rig.frame()))!.depthStencilAttachment!
      expect(depthOf().depthReadOnly).toBe(true)
      mark.visible = true
      expect(depthOf().depthStoreOp).toBe('store')
    } finally {
      drop(mark)
      set({ on: false })
      rig.frame()
    }
  }, 120_000)

  it('draws one frame in all three: lean bit for bit, chain to a half float’s step of the frame’s peak', async () => {
    /*
     * A held still with the jitter held repeats every four frames once the
     * history has converged, so frames four apart under two forms differ by
     * the forms alone. `cloudComposite.gpu.test.ts` holds pass B and the
     * chain form to a half float's step on a history it writes; here the
     * history is the system's own.
     */
    try {
      set({ over: 'passes' })
      frames(64)
      const passes = await output()
      // The control: the frame repeats, so a difference below is a form's.
      frames(4)
      expect(bits(await output())).toEqual(bits(passes))
      set({ over: 'lean' })
      frames(4)
      expect(bits(await output())).toEqual(bits(passes))
      set({ over: 'chain' })
      frames(4)
      expect(apart(await output(), passes)).toBeLessThanOrEqual(HALF)
      // And the deck is in it.
      set({ on: false })
      rig.frame()
      expect(apart(passes, await output())).toBeGreaterThan(0.05)
    } finally {
      set({ on: false })
      rig.frame()
    }
  }, 120_000)

  it.each(FORMS)(
    'under %s, a frame whose cloud work throws composites none of the history it abandoned',
    async (over) => {
      const resource = <T>(name: string): T =>
        rig.system!.resources.find((held) => held.name === name) as T
      const trace = resource<CloudTrace>('trace')
      const history = resource<CloudHistory>('history')
      const { render, dispatchPhase } = trace
      try {
        set({ on: false })
        rig.frame()
        const plain = await output()
        set({ over })
        frames(24)
        // The control: the history holds the deck, and the frame shows it.
        expect(apart(await output(), plain)).toBeGreaterThan(0.05)
        const fail = (): never => {
          throw new Error('the trace failed')
        }
        trace.render = fail
        trace.dispatchPhase = fail
        const resets = history.report.resets
        await checked(() => rig.frame())
        trace.render = render
        trace.dispatchPhase = dispatchPhase
        // The scene alone, bit for bit: the composite drew nothing, and
        // nothing drawn over it is handed the trace it abandoned.
        expect(bits(await output())).toEqual(bits(plain))
        expect(rig.system!.front.textures()).toBeNull()
        expect(treeOf(renderer)).toEqual({
          context: null,
          depth: -1,
          lights: 0,
        })
        // The next frame keeps none of the history, and the cloud comes back.
        rig.frame()
        expect(history.report.resets).toBe(resets + 1)
        frames(24)
        expect(apart(await output(), plain)).toBeGreaterThan(0.05)
      } finally {
        trace.render = render
        trace.dispatchPhase = dispatchPhase
        set({ on: false })
        rig.frame()
      }
    },
    120_000,
  )

  it.skipIf(!TIMESTAMPS)(
    'under chain with nothing over the clouds, times no second scene pass: the composite alone, after the scene, with the cloud work',
    async () => {
      const labels = async (): Promise<string[]> => {
        const stop = installPassTimeline(renderer)
        try {
          const read = await passTimelineOf(renderer)!.measure(
            () => rig.frame(),
            3,
          )
          expect(read.dropped).toBe(0)
          return read.passes.map((pass) => pass.label)
        } finally {
          stop()
        }
      }
      try {
        set({ over: 'chain' })
        frames(4)
        const chained = await labels()
        expect(chained).not.toContain(OVER_PASS_LABEL)
        expect(chained.filter((label) => label === CHAIN_PASS_LABEL)).toEqual([
          CHAIN_PASS_LABEL,
        ])
        expect(chained.indexOf(CHAIN_PASS_LABEL)).toBeGreaterThan(
          chained.indexOf('scene'),
        )
        expect(chained).toContain('cloud trace')
        expect(chained).toContain('cloud history')
        set({ over: 'passes' })
        frames(4)
        const passes = await labels()
        expect(passes).toContain(OVER_PASS_LABEL)
        expect(passes).not.toContain(CHAIN_PASS_LABEL)
        // The two forms run the same cloud work.
        const work = (all: string[]) =>
          all.filter(
            (label) => label.startsWith('cloud ') && label !== CHAIN_PASS_LABEL,
          )
        expect(work(chained)).toEqual(work(passes))
      } finally {
        set({ on: false })
        rig.frame()
      }
    },
    120_000,
  )
})

/* ------------------------------------------------------------------------- */
/* The forms' GPU time                                                        */
/* ------------------------------------------------------------------------- */

/*
 * Under IR_CLOUD_MEASURE=1, each form's frame on the pass timeline at two
 * target sizes, written to `.data/clouds/overForms.json`. **Not a campaign
 * figure.** The scene is the rig's: a ceiling over half the frame and the
 * deck over the rest, so the scene pass draws one plane and what is timed is
 * the break and the composite, on Node's WebGPU with no compositor, no
 * presentation and no page beside it. It says which way each form moves the
 * frame and by roughly how much at a size; the `over` batch says what a
 * stance costs.
 *
 * `wall` is the frame across a drained queue and `busy` the time any timed
 * pass was running (`passTimeline.ts`). The overlay is one blended ball over
 * the clouds that writes no depth, a plume's shape of draw: `chain` goes
 * back to the two passes for it, and `lean` reads depth without storing it.
 */
const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined

describe.skipIf(!MEASURE || !TIMESTAMPS)('the forms’ GPU time', () => {
  const SIZES = [
    ['1080p', 1920, 1080],
    ['retina', 2880, 1800],
  ] as const
  const FRAMES = 40
  const measured: Record<string, unknown> = {}

  afterAll(() => {
    mkdirSync('.data/clouds', { recursive: true })
    writeFileSync(
      '.data/clouds/overForms.json',
      `${JSON.stringify(measured, null, 2)}\n`,
    )
  })

  it.each(SIZES)(
    'at %s',
    async (name, width, height) => {
      const session = await openGpu(width, height)
      const stop = installPassTimeline(session.renderer)
      const rig = cloudRig(session, width, height, {
        ceiling: 50,
        levers: { weather: 'overcast' },
      })
      const material = sensorRadiance(new MeshBasicNodeMaterial(), true)
      material.colorNode = vec3(0.8, 0.2, 0.1)
      material.transparent = true
      material.depthWrite = false
      const overlay = new Mesh(new SphereGeometry(5, 12, 8), material)
      overlay.position.set(-12, 40, 0)
      markOverClouds(overlay)
      rig.scene.add(overlay)
      rig.scene.updateMatrixWorld(true)
      try {
        await rig.sensor.warm()
        await rig.system!.warm()
        await warmCompile(warmRenderer(session.renderer, layout), {
          object: overlay,
          camera: rig.camera,
          scene: rig.scene,
        })
        const timeline = passTimelineOf(session.renderer)!
        const row = async (levers: Partial<CloudLevers>, shown: boolean) => {
          overlay.visible = shown
          rig.levers = {
            ...DEFAULT_CLOUD_LEVERS,
            weather: 'overcast',
            on: true,
            ...levers,
          }
          for (let k = 0; k < 64; k += 1) rig.frame()
          await session.read(rig.target)
          const read = await timeline.measure(() => rig.frame(), FRAMES)
          const pass = (label: string): number | null =>
            read.passes.find((one) => one.label === label)?.ms ?? null
          return {
            wall: read.wallMs,
            busy: read.busyMs,
            scene: pass('scene'),
            sceneOverClouds: pass(OVER_PASS_LABEL),
            cloudComposite: pass(CHAIN_PASS_LABEL),
            dropped: read.dropped,
          }
        }
        const rowsOf: Record<string, unknown> = {
          off: await row({ on: false }, false),
        }
        for (const over of ['passes', 'lean', 'chain'] as const) {
          rowsOf[over] = await row({ over }, false)
          rowsOf[`${over}, overlay`] = await row({ over }, true)
        }
        measured[name] = { width, height, frames: FRAMES, rows: rowsOf }
        expect(Object.keys(rowsOf)).toHaveLength(7)
      } finally {
        rig.dispose()
        material.dispose()
        overlay.geometry.dispose()
        stop()
        session.dispose()
      }
    },
    600_000,
  )
})
