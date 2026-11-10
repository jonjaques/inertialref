import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { logHub, RingBufferSink } from '@inertialref/shared'
import {
  AdditiveBlending,
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
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  ivec2,
  nodeObject,
  pass,
  storage,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl'
import { CloudFrameNode } from './cloudFrameNode.ts'
import {
  markOverClouds,
  OVER_CLOUDS_LAYER,
  UNDER_CLOUDS_LAYERS,
} from './cloudLayers.ts'
import { cloudStorageTexture } from './cloudNodes.ts'
import { CloudOverPassNode, OVER_PASS_LABEL } from './cloudOverPass.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import {
  installPassTimeline,
  namePass,
  passTimelineOf,
} from './passTimeline.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import { runQuadPasses } from './quadPass.ts'
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
function chain(scene: Scene): Chain {
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
  const over = new CloudOverPassNode(scene, camera, scenePass.renderTarget, mrt)
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
      over.active = on
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
  const driver = { inFrame: true, runs: 0, run }
  const node = new CloudFrameNode({
    get inFrame() {
      return driver.inFrame
    },
    run(three) {
      driver.runs += 1
      driver.run(three)
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
      frame.passes(false)
      const one = await timeline!.measure(draw, 2)
      expect(one.passes.map((pass) => pass.label)).toEqual(['post', PASS_A])
    } finally {
      stop()
      frame.dispose()
    }
  })
})
