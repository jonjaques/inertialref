import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { logHub, RingBufferSink } from '@inertialref/shared'
import {
  AdditiveBlending,
  DepthTexture,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  type MRTNode,
  type Node,
  type NodeFrame,
  NodeUpdateType,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  StorageBufferAttribute,
  TempNode,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  ivec2,
  screenUV,
  storage,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl'
import { CloudDepth } from './cloudDepth.ts'
import { type CloudFrameDriver, CloudFrameNode } from './cloudFrameNode.ts'
import type { CloudPlacement } from './cloudLevers.ts'
import { cloudStorageTexture } from './cloudNodes.ts'
import { splitScenePass } from './cloudSplit.ts'
import { createCloudUniforms } from './cloudUniforms.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import {
  installPassTimeline,
  namePass,
  passTimelineOf,
} from './passTimeline.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import {
  attachmentFormat,
  attachmentType,
  sceneBackend,
  sceneLayout,
  type SceneLayout,
} from './sceneLayout.ts'
import { seaFrame } from './seaReflection.ts'
import { sensorMrt } from './sensorMrt.ts'

/*
 * Placement B's split, inside a scene pass of the sensor's own shape: four
 * samples, a float depth, the layout's three attachments and its MRT. The
 * frame is an opaque ground over the upper half of the image, then the
 * composite (transparent, order 1.5, its node splitting the pass) over the
 * left half, then a transparent square over the right half, drawn after the
 * composite and behind the ground. Inside the split runs the frame's cloud
 * work: the depth copy, and a kernel writing the value the composite draws.
 *
 * Every quadrant says something. Upper left is ground plus composite: the
 * composite landed on what the first half drew. Upper right is ground alone:
 * the resumed pass loaded the color, and the square behind the ground was
 * depth-tested against the depth it loaded. Lower left is the composite
 * alone, the kernel's value of this frame; lower right the square alone.
 */

const SIZE = 32
const FOV = 60
const HALF_TAN = Math.tan((FOV / 2) * (Math.PI / 180))
const TIMESTAMPS = await adapterOffers('timestamp-query')

/** A half float's step at 1: the output attachment's resolution about its values here. */
const HALF = 2 ** -10
const GROUND = 0.25
const AFTER = 0.5
const BEFORE_VALUE = 0.125
const THIS_VALUE = 0.375

/** Interior texels of the four quadrants, row 0 at the top. */
const UPPER_LEFT = [8, 8] as const
const UPPER_RIGHT = [24, 8] as const
const LOWER_LEFT = [8, 24] as const
const LOWER_RIGHT = [24, 24] as const
const QUADRANTS = [UPPER_LEFT, UPPER_RIGHT, LOWER_LEFT, LOWER_RIGHT] as const

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

/** RGBA texels of a 2D texture, read by `textureLoad`, so nothing filters or flips them. */
async function texels(
  map: Texture,
  at: readonly (readonly [number, number])[],
): Promise<number[][]> {
  const out = new StorageBufferAttribute(new Float32Array(at.length * 4), 1)
  const into = storage(out, 'float', at.length * 4)
  const kernel = Fn(() => {
    at.forEach(([x, y], k) => {
      const read = textureLoad(map, ivec2(x, y))
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

/** The four quadrants' red and green, in `QUADRANTS`' order. */
async function quadrants(target: RenderTarget): Promise<number[][]> {
  const read = await texels(target.texture, QUADRANTS)
  return read.map(([red, green]) => [red!, green!])
}

/** What the four quadrants hold when the composite drew `value` on the scene target. */
const expected = (value: number): number[][] => [
  [GROUND + value, 0],
  [GROUND, 0],
  [value, 0],
  [0, AFTER],
]

function expectQuadrants(read: number[][], value: number): void {
  read.forEach((channels, k) => {
    channels.forEach((channel, c) => {
      expect(
        Math.abs(channel - expected(value)[k]![c]!),
        `quadrant ${k}, channel ${c}: ${channel}`,
      ).toBeLessThanOrEqual(HALF)
    })
  })
}

/** Kilometers along the ray through render texel (i, j)'s center to a plane `depth` meters down the axis. */
function alongRay(depth: number, [i, j]: readonly [number, number]): number {
  const x = (2 * (i + 0.5)) / SIZE - 1
  const y = 1 - (2 * (j + 0.5)) / SIZE
  return (depth * Math.hypot(1, x * HALF_TAN, y * HALF_TAN)) / 1000
}

/** The scene pass's target, as `sceneTarget.ts` lays one out, at the render's size. */
function sceneTarget(): RenderTarget {
  const depthTexture = new DepthTexture(SIZE, SIZE, layout.depthType)
  depthTexture.isRenderTargetTexture = true
  const target = new RenderTarget(SIZE, SIZE, {
    type: HalfFloatType,
    samples: layout.samples,
    depthTexture,
    count: layout.attachments.length,
  })
  layout.attachments.forEach((row, i) => {
    const texture = target.textures[i]!
    texture.name = row.name
    texture.format = attachmentFormat(row)
    texture.type = attachmentType(row)
  })
  namePass(target, 'scene')
  return target
}

/** A plane facing the camera, `depth` meters down its axis, over the image rectangle [x0, x1] × [y0, y1], y up. */
function facing(
  depth: number,
  [x0, x1, y0, y1]: readonly [number, number, number, number],
  material: MeshBasicNodeMaterial,
): Mesh {
  const scale = depth * HALF_TAN
  const mesh = new Mesh(
    new PlaneGeometry((x1 - x0) * scale, (y1 - y0) * scale),
    material,
  )
  mesh.position.set(((x0 + x1) / 2) * scale, ((y0 + y1) / 2) * scale, -depth)
  return mesh
}

/** Transparent, additive and depth-tested but not depth-writing: it adds to what it covers. */
function added(color: Node<'vec4'>): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.colorNode = color
  material.transparent = true
  material.blending = AdditiveBlending
  material.depthWrite = false
  return material
}

/** A node whose `updateBefore` runs `work` at the draw of the object whose material holds it. */
class Before extends TempNode<'float'> {
  static get type(): string {
    return 'SplitBefore'
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

/** Three's render tree: what a throw inside nested work would leave pointing into it. */
interface Tree {
  readonly _currentRenderContext: object | null
  readonly _callDepth: number
  readonly lighting: { readonly _cache: readonly unknown[] }
}
function treeOf(three: WebGPURenderer) {
  const tree = three as unknown as Tree
  return {
    context: tree._currentRenderContext,
    depth: tree._callDepth,
    lights: tree.lighting._cache.length,
    target: three.getRenderTarget(),
    mrt: three.getMRT(),
  }
}

/** A driver a test sets the placement and the frame's state of. */
interface Driver extends CloudFrameDriver {
  inFrame: boolean
  placement: CloudPlacement
}

interface Rig {
  readonly target: RenderTarget
  readonly mrt: MRTNode
  readonly camera: PerspectiveCamera
  readonly scene: Scene
  readonly depth: CloudDepth
  readonly composite: Mesh
  /** What the frame's cloud work saw of the renderer after it ran. */
  readonly seen: { context: boolean; target: boolean; runs: number }
  /** The frame's cloud work, as the system's run issues it: the depth copy, then a kernel. */
  run(three: WebGPURenderer): void
  /** One frame, the ground at 10 m when `near` and 20 m when not, the kernel writing `value`. */
  frame(near: boolean, value: number): void
  dispose(): void
}

/** The frame, its composite carrying `node(rig)` in its graph. */
async function rig(
  node: (rig: Rig) => Node<'float'>,
  options: { readonly sea?: boolean } = {},
): Promise<Rig> {
  const target = sceneTarget()
  const mrt = sensorMrt(layout)
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 1e10)
  camera.updateMatrixWorld()
  const uniforms = createCloudUniforms()
  uniforms.camera.plane.value.set(HALF_TAN, HALF_TAN)
  uniforms.camera.near.value = camera.near
  uniforms.camera.far.value = camera.far
  const depth = new CloudDepth(uniforms, layout)
  depth.tie(target)
  await depth.warm(renderer)

  const written = cloudStorageTexture(1, 1, 'rgba16float', 'split value')
  const value = uniform(0)
  const kernel = Fn(() => {
    textureStore(written, uvec2(0, 0), vec4(value, 0, 0, 1))
  })().compute(1)
  kernel.setName('cloud trace')

  const ground = new MeshBasicNodeMaterial()
  ground.colorNode = vec4(GROUND, 0, 0, 1)
  const far = facing(20, [-1.5, 1.5, 0, 1.5], ground)
  const near = facing(10, [-1.5, 1.5, 0, 1.5], ground)
  const after = facing(15, [0, 1.5, -1.5, 1.5], added(vec4(0, AFTER, 0, 1)))
  after.renderOrder = 2
  const scene = new Scene()
  const seen = { context: false, target: false, runs: 0 }
  const self = {
    target,
    mrt,
    camera,
    scene,
    depth,
    seen,
    run(three: WebGPURenderer) {
      const context = treeOf(three).context
      depth.render(three)
      three.compute(kernel)
      seen.runs += 1
      seen.context = treeOf(three).context === context
      seen.target = three.getRenderTarget() === target
    },
    frame(nearer: boolean, kernelValue: number) {
      far.visible = !nearer
      near.visible = nearer
      value.value = kernelValue
      const previous = renderer.getRenderTarget()
      const previousMrt = renderer.getMRT()
      try {
        renderer.setRenderTarget(target)
        renderer.setMRT(mrt)
        renderer.render(scene, camera)
      } finally {
        renderer.setMRT(previousMrt)
        renderer.setRenderTarget(previous)
      }
    },
    dispose() {
      depth.dispose()
      target.dispose()
      written.dispose()
    },
  } as Omit<Rig, 'composite'> & { composite: Mesh }
  const material = added(
    vec4(textureLoad(written, ivec2(0, 0)).x, 0, 0, float(1).add(node(self))),
  )
  // Over everything in front of it, as the full-screen composite is.
  material.depthTest = false
  self.composite = facing(1, [-1.5, 0, -1.5, 1.5], material)
  self.composite.renderOrder = 1.5
  scene.add(far, near, self.composite, after)
  if (options.sea === true) {
    // The full sea's frame read, color and depth in one split of its own at
    // order 0, ahead of the composite's. It adds nothing to the picture.
    const sea = seaFrame(screenUV, true)
    scene.add(facing(5, [-1.5, 1.5, -1.5, 1.5], added(vec4(sea.rgb.mul(0), 1))))
  }
  scene.updateMatrixWorld(true)
  return self
}

const driver = (placement: CloudPlacement, run: Driver['run']): Driver => ({
  inFrame: true,
  placement,
  run,
})

/** A frame node over `rig.run`, its driver in `placement`. */
async function framed(
  placement: CloudPlacement,
  options: { readonly sea?: boolean } = {},
) {
  const drive = driver(placement, () => {})
  const built = await rig((frame) => {
    drive.run = (three) => frame.run(three)
    return new CloudFrameNode(drive)
  }, options)
  return { rig: built, driver: drive }
}

describe('the split', () => {
  it('reads this frame’s depth inside it, and the resumed half lands on what the first half drew', async () => {
    const { rig: frame } = await framed('split')
    await checked(() => frame.frame(false, BEFORE_VALUE))
    await checked(() => frame.frame(true, THIS_VALUE))
    const [[copied]] = (await texels(frame.depth.texture, [UPPER_RIGHT])) as [
      [number],
    ]
    // The ground ten meters out, along the ray: this frame's, not the last's
    // twenty. A step of R16F short at most.
    const along = alongRay(10, UPPER_RIGHT)
    expect(Math.abs(copied - along)).toBeLessThanOrEqual(along * 2 ** -10)
    expectQuadrants(await quadrants(frame.target), THIS_VALUE)
    frame.dispose()
  })

  it('and without it the same work reads the depth the last frame left', async () => {
    // The control: the work issued from the composite with no split runs
    // ahead of the whole scene pass, so the order above is the split's and
    // not the queue's.
    const { rig: frame } = await framed('passes')
    await checked(() => frame.frame(false, BEFORE_VALUE))
    await checked(() => frame.frame(true, THIS_VALUE))
    const [[copied]] = (await texels(frame.depth.texture, [UPPER_RIGHT])) as [
      [number],
    ]
    const along = alongRay(20, UPPER_RIGHT)
    expect(Math.abs(copied - along)).toBeLessThanOrEqual(along * 2 ** -10)
    frame.dispose()
  })

  it('leaves the resumed half drawing into the scene target after a compute inside it', async () => {
    const { rig: frame } = await framed('split')
    await checked(() => frame.frame(true, THIS_VALUE))
    // After the depth copy's quad and the kernel, the render target and the
    // render context are the scene pass's, and the composite drew the
    // kernel's value of this frame onto the scene target.
    expect(frame.seen).toEqual({ context: true, target: true, runs: 1 })
    expectQuadrants(await quadrants(frame.target), THIS_VALUE)
    frame.dispose()
  })

  it('splits with nothing inside under empty-split, and the frame is drawn whole', async () => {
    const { rig: frame } = await framed('empty-split')
    await checked(() => frame.frame(true, THIS_VALUE))
    expect(frame.seen.runs).toBe(0)
    // Nothing wrote the value, so the composite adds WebGPU's zeros.
    expectQuadrants(await quadrants(frame.target), 0)
    frame.dispose()
  })

  it('declines outside an open render pass, and runs nothing', () => {
    let ran = false
    expect(
      splitScenePass(renderer, () => {
        ran = true
      }),
    ).toBe(false)
    expect(ran).toBe(false)
  })

  it('puts the renderer back after a throw inside a render nested in it, and the scene pass draws on', async () => {
    const elsewhere = new RenderTarget(4, 4, { depthBuffer: false })
    const thrown = new Scene()
    const trap = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial())
    trap.position.z = -1
    trap.onBeforeRender = () => {
      throw new Error('inside a nested render')
    }
    thrown.add(trap)
    thrown.updateMatrixWorld(true)
    let throwing = true
    let caught: unknown = null
    let before: ReturnType<typeof treeOf> | null = null
    let after: ReturnType<typeof treeOf> | null = null
    const frame = await rig(
      (self) =>
        new Before((three) => {
          before = treeOf(three)
          try {
            splitScenePass(three, () => {
              self.run(three)
              if (!throwing) return
              three.setRenderTarget(elsewhere)
              three.setMRT(null)
              three.render(thrown, self.camera)
            })
          } catch (cause) {
            caught = cause
          }
          after = treeOf(three)
        }),
    )
    await checked(() => frame.frame(true, THIS_VALUE))
    expect(String(caught)).toBe('Error: inside a nested render')
    // Inside the scene pass, after the throw: its own context, call depth,
    // lights, target and MRT, as the split found them.
    for (const key of ['context', 'depth', 'lights', 'target', 'mrt'] as const)
      expect(after![key], key).toBe(before![key])
    expect(before!.target).toBe(frame.target)
    // The scene pass finished, and three's tree is the top level's again.
    const top = treeOf(renderer)
    expect([top.context, top.depth, top.lights]).toEqual([null, -1, 0])
    expectQuadrants(await quadrants(frame.target), THIS_VALUE)
    // And the next frame splits as any other does.
    throwing = false
    caught = null
    await checked(() => frame.frame(true, BEFORE_VALUE))
    expect(caught).toBeNull()
    expectQuadrants(await quadrants(frame.target), BEFORE_VALUE)
    frame.dispose()
    elsewhere.dispose()
  })
})

describe('the frame node', () => {
  it('reports a throw in the frame’s cloud work once, and draws the frame without it', async () => {
    const sink = new RingBufferSink()
    const detach = logHub.addSink(sink)
    try {
      const drive = driver('split', () => {
        throw new Error('the cloud work broke')
      })
      const frame = await rig(() => new CloudFrameNode(drive))
      await checked(() => frame.frame(true, THIS_VALUE))
      await checked(() => frame.frame(true, THIS_VALUE))
      const reports = sink
        .records()
        .filter((record) => record.scope === 'game.clouds')
      expect(reports.map((record) => record.level)).toEqual(['warn'])
      expect(reports[0]!.fields['cause']).toBe('Error: the cloud work broke')
      // Split, with nothing written: the frame without its clouds.
      expectQuadrants(await quadrants(frame.target), 0)
      expect(treeOf(renderer).depth).toBe(-1)
      frame.dispose()
    } finally {
      detach()
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
    const copies = { count: 0 }
    const copy = renderer.copyFramebufferToTexture.bind(renderer)
    renderer.copyFramebufferToTexture = (texture, rectangle) => {
      copies.count += 1
      copy(texture, rectangle)
    }
    try {
      for (const [inFrame, placement] of [
        [true, 'passes'],
        [false, 'passes'],
        [false, 'split'],
        [false, 'empty-split'],
      ] as const) {
        let ran = 0
        const drive = driver(placement, () => {
          ran += 1
        })
        const frame = await rig(() => new CloudFrameNode(drive))
        await checked(() => frame.frame(true, THIS_VALUE))
        const drawn = ran
        const copied = copies.count
        drive.inFrame = inFrame
        const target = renderer.getRenderTarget()
        const mrt = renderer.getMRT()
        let compiled: Promise<unknown>
        try {
          renderer.setRenderTarget(frame.target)
          renderer.setMRT(frame.mrt)
          compiled = renderer.compileAsync(
            frame.composite,
            frame.camera,
            frame.scene,
          )
        } finally {
          renderer.setMRT(mrt)
          renderer.setRenderTarget(target)
        }
        await compiled
        const label = `in a frame: ${inFrame}, ${placement}`
        expect(ran - drawn, label).toBe(inFrame ? 1 : 0)
        expect(copies.count - copied, label).toBe(0)
        frame.dispose()
      }
    } finally {
      // The spy is an own property over the prototype's method.
      delete (renderer as { copyFramebufferToTexture?: unknown })
        .copyFramebufferToTexture
    }
  })
})

describe.skipIf(!TIMESTAMPS)('the split on the pass timeline', () => {
  /*
   * In the order the frame encoded them, which is not the order they ran:
   * the resumed half is named at the split, before the work inside it is
   * encoded, and runs after that work, which the tests above prove by what
   * each pass reads. Behind a full sea sheet the sea's own split comes first,
   * and the clouds' resumed half is still named for what it is rather than
   * by the chain of copies before it.
   */
  it.each([
    [
      'alone',
      false,
      ['scene', 'scene over clouds', 'cloud depth', 'cloud trace'],
    ],
    [
      'behind a full sea sheet',
      true,
      [
        'scene',
        'scene after copy',
        'scene over clouds',
        'cloud depth',
        'cloud trace',
      ],
    ],
  ] as const)(
    'names every pass of a split frame %s',
    async (_, sea, labels) => {
      const stop = installPassTimeline(renderer)
      const { rig: frame } = await framed('split', { sea })
      try {
        const timeline = passTimelineOf(renderer)
        expect(timeline).not.toBeNull()
        const draw = () => frame.frame(true, THIS_VALUE)
        await checked(draw) // compile outside the measurement
        const result = await timeline!.measure(draw, 4)
        expect(result.dropped).toBe(0)
        expect(result.passes.map((pass) => pass.label)).toEqual(labels)
        for (const pass of result.passes) expect(pass.count, pass.label).toBe(1)
      } finally {
        stop()
        frame.dispose()
      }
    },
  )
})
