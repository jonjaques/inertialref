import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DepthTexture,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  StorageBufferAttribute,
  type Texture,
} from 'three/webgpu'
import {
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  storage,
  textureLoad,
  uint,
  uvec2,
  vec2,
  vec4,
} from 'three/tsl'
import {
  CLOUD_DEPTH_CLAMP_KM,
  CLOUD_DEPTH_LABEL,
  CloudDepth,
} from './cloudDepth.ts'
import { screenTexel, traceScreen } from './cloudGeometry.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import { sceneBackend, sceneLayout, type SceneLayout } from './sceneLayout.ts'

/*
 * The depth copy, drawn from a scene target of the scene pass's own shape —
 * four samples, a float depth, reversed — and read back texel for texel by a
 * kernel, so nothing between the copy and the assertion filters or flips it.
 * The camera is the app's: 60°, near 5 cm, far 10⁷ km.
 */

/** The render's size: a multiple of the trace's 8 × 8, as the real one's quarter is. */
const SIZE = 32
const TRACE = 8
const FOV = 60
const NEAR = 0.05
const FAR = 1e10

/**
 * A half float's step at `value`. An R16F store here truncates rather than
 * rounding: all 1,024 texels of the facing plane below land under their
 * float32 value, by up to 0.99 of a step, so a copy is held to one step, not
 * half of one.
 */
const halfStep = (value: number): number =>
  2 ** (Math.floor(Math.log2(value)) - 10)
/**
 * Reversed float32 depth decoded to view z, relative: the rasterizer's depth
 * and the decode's three operations, a handful of float32 steps.
 */
const DECODE = 8 * 2 ** -24
const withinCopy = (stored: number, expected: number): boolean =>
  Math.abs(stored - expected) <= halfStep(expected) + expected * DECODE

const view = (): PerspectiveCamera => {
  const camera = new PerspectiveCamera(FOV, 1, NEAR, FAR)
  camera.updateMatrixWorld()
  return camera
}
const HALF_TAN = Math.tan((FOV / 2) * (Math.PI / 180))

/** The bundle with the camera's planes and frame, as the system writes them. */
function cameraUniforms(camera: PerspectiveCamera): CloudUniforms {
  const uniforms = createCloudUniforms()
  uniforms.camera.plane.value.set(HALF_TAN * camera.aspect, HALF_TAN)
  uniforms.camera.near.value = camera.near
  uniforms.camera.far.value = camera.far
  return uniforms
}

/** Kilometers along the ray through render texel (i, j)'s center to a plane `depth` meters down the axis. */
function alongRay(depth: number, i: number, j: number): number {
  const x = (2 * (i + 0.5)) / SIZE - 1
  const y = 1 - (2 * (j + 0.5)) / SIZE
  return (depth * Math.hypot(1, x * HALF_TAN, y * HALF_TAN)) / 1000
}

/** A plane facing the camera, `depth` meters down its axis, over the image rectangle [x0, x1] × [y0, y1], y up. */
function facing(
  depth: number,
  [x0, x1, y0, y1]: readonly [number, number, number, number],
): Mesh {
  const scale = depth * HALF_TAN
  const material = new MeshBasicNodeMaterial()
  material.colorNode = vec4(1, 1, 1, 1)
  const mesh = new Mesh(
    new PlaneGeometry((x1 - x0) * scale, (y1 - y0) * scale),
    material,
  )
  mesh.position.set(((x0 + x1) / 2) * scale, ((y0 + y1) / 2) * scale, -depth)
  return mesh
}

function sceneOf(...meshes: Mesh[]): Scene {
  const scene = new Scene()
  if (meshes.length > 0) scene.add(...meshes)
  scene.updateMatrixWorld(true)
  return scene
}

/** What a test needs of one session: its verbs, bound to its renderer and device. */
function rig(gpu: GpuSession) {
  const renderer = gpu.renderer
  const device = (renderer.backend as unknown as { device: GPUDevice }).device
  const layout: SceneLayout = sceneLayout(
    DEFAULT_PICTURE,
    sceneBackend(renderer),
  )

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
      // Popped on this path too, or the scope outlives the test and captures
      // the next one's errors.
      await device.popErrorScope()
      throw failure
    }
    const scoped = await device.popErrorScope()
    if (scoped !== null)
      throw new Error(`the device reported: ${scoped.message}`)
    await device.queue.onSubmittedWorkDone()
    expect(
      gpu
        .reported()
        .slice(from)
        .filter((entry) => entry.type === 'error'),
    ).toEqual([])
  }

  /** The scene pass's target: the layout's samples and depth type, a half-float output. */
  const sceneTarget = (size = SIZE): RenderTarget =>
    new RenderTarget(size, size, {
      type: HalfFloatType,
      samples: layout.samples,
      depthTexture: new DepthTexture(size, size, layout.depthType),
    })

  function drawScene(
    target: RenderTarget,
    scene: Scene,
    camera: PerspectiveCamera,
  ): void {
    const previous = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
    } finally {
      renderer.setRenderTarget(previous)
    }
  }

  /** Every texel of an R16F texture, row-major from the top, read by `textureLoad`. */
  async function texels(map: Texture): Promise<Float32Array> {
    const count = SIZE * SIZE
    const out = new StorageBufferAttribute(new Float32Array(count), 1)
    const into = storage(out, 'float', count)
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(uint(count)), () => {
        const at = ivec2(
          int(instanceIndex.mod(uint(SIZE))),
          int(instanceIndex.div(uint(SIZE))),
        )
        into.element(instanceIndex).assign(textureLoad(map, at).x)
      })
    })().compute(count)
    await gpu.compute(kernel)
    return new Float32Array(await gpu.readBuffer(out))
  }

  /**
   * The copy as a trace texel reads it: `traceScreen` at the trace's extent,
   * `screenTexel` at the render's, a texel load. Row-major from the top.
   */
  async function traced(map: Texture): Promise<Float32Array> {
    const count = TRACE * TRACE
    const out = new StorageBufferAttribute(new Float32Array(count), 1)
    const into = storage(out, 'float', count)
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(uint(count)), () => {
        const pixel = uvec2(
          instanceIndex.mod(uint(TRACE)),
          instanceIndex.div(uint(TRACE)),
        )
        const screen = traceScreen(pixel, vec2(0), vec2(TRACE, TRACE))
        const texel = screenTexel(screen, vec2(SIZE, SIZE))
        into.element(instanceIndex).assign(textureLoad(map, texel).x)
      })
    })().compute(count)
    await gpu.compute(kernel)
    return new Float32Array(await gpu.readBuffer(out))
  }

  /** A copy tied to a fresh scene target, warmed, and drawn from what `scene` left in it. */
  async function copied(scene: Scene) {
    const camera = view()
    const target = sceneTarget()
    const copy = new CloudDepth(cameraUniforms(camera), layout)
    copy.tie(target)
    await copy.warm(renderer)
    await checked(() => {
      drawScene(target, scene, camera)
      copy.render(renderer)
    })
    return {
      copy,
      dispose() {
        copy.dispose()
        target.dispose()
      },
    }
  }

  return {
    renderer,
    layout,
    checked,
    sceneTarget,
    drawScene,
    texels,
    traced,
    copied,
  }
}

let gpu: GpuSession
let main: ReturnType<typeof rig>

beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
  main = rig(gpu)
})

afterAll(() => {
  gpu.dispose()
})

describe('the depth copy', () => {
  it('puts a depth step’s near half on the copy’s top rows, through traceScreen and screenTexel', async () => {
    // Near over the upper half of the image, far behind the whole of it.
    const scene = sceneOf(
      facing(10, [-1.5, 1.5, 0, 1.5]),
      facing(5000, [-1.5, 1.5, -1.5, 1.5]),
    )
    const { copy, dispose } = await main.copied(scene)
    const all = await main.texels(copy.texture)
    for (let j = 0; j < SIZE; j += 1) {
      for (let i = 0; i < SIZE; i += 1) {
        const expected = alongRay(j < SIZE / 2 ? 10 : 5000, i, j)
        const stored = all[j * SIZE + i]!
        expect(
          withinCopy(stored, expected),
          `texel (${i}, ${j}): ${stored}`,
        ).toBe(true)
      }
    }
    const read = await main.traced(copy.texture)
    for (let j = 0; j < TRACE; j += 1) {
      for (let i = 0; i < TRACE; i += 1) {
        // Ten meters down the axis is under 13 m along any ray of a 60° square.
        const kilometers = read[j * TRACE + i]!
        if (j < TRACE / 2)
          expect(kilometers, `trace (${i}, ${j})`).toBeLessThan(0.013)
        else expect(kilometers, `trace (${i}, ${j})`).toBeGreaterThan(4.99)
      }
    }
    dispose()
  })

  it('stores distance along the ray, which at the corners is view z over their cosine', async () => {
    const { copy, dispose } = await main.copied(
      sceneOf(facing(100, [-1.5, 1.5, -1.5, 1.5])),
    )
    const all = await main.texels(copy.texture)
    for (let j = 0; j < SIZE; j += 1) {
      for (let i = 0; i < SIZE; i += 1) {
        const expected = alongRay(100, i, j)
        const stored = all[j * SIZE + i]!
        expect(
          withinCopy(stored, expected),
          `texel (${i}, ${j}): ${stored}`,
        ).toBe(true)
      }
    }
    // View z is 0.1 km everywhere; a copy of it would be 27% short at the
    // corner texels' centers, a hundred steps outside the bound above.
    for (const [i, j] of [
      [0, 0],
      [SIZE - 1, 0],
      [0, SIZE - 1],
      [SIZE - 1, SIZE - 1],
    ] as const)
      expect(all[j * SIZE + i]! / 0.1).toBeGreaterThan(1.25)
    dispose()
  })

  it('stores the clamp where nothing was drawn and past 60,000 km, and the distance short of it', async () => {
    // Left: nothing. Middle: 100,000 km. Right: 40,000 km.
    const { copy, dispose } = await main.copied(
      sceneOf(
        facing(1e8, [-1 / 3, 1 / 3, -1.5, 1.5]),
        facing(4e7, [1 / 3, 1.5, -1.5, 1.5]),
      ),
    )
    const all = await main.texels(copy.texture)
    // Columns clear of the bands' edges, which cross texels 10 and 21, where
    // the copy takes whichever surface sample 0 landed on.
    for (let j = 0; j < SIZE; j += 1) {
      for (const i of [0, 5, 9, 12, 16, 19])
        expect(all[j * SIZE + i], `texel (${i}, ${j})`).toBe(
          CLOUD_DEPTH_CLAMP_KM,
        )
      // 40,000 km is 51,600 along the ray at the corners: short of the clamp.
      for (const i of [23, 26, 31]) {
        const expected = alongRay(4e7, i, j)
        const stored = all[j * SIZE + i]!
        expect(
          withinCopy(stored, expected),
          `texel (${i}, ${j}): ${stored}`,
        ).toBe(true)
      }
    }
    dispose()
  })

  it('declares the bytes it holds on the GPU, at one level of R16F, and none once disposed', async () => {
    const camera = view()
    const copy = new CloudDepth(cameraUniforms(camera), main.layout)
    // Untied, it holds and compiles nothing: the program binds the tied depth.
    expect([copy.bytes, copy.textures().length]).toEqual([0, 0])
    await copy.warm(main.renderer)
    expect([copy.bytes, copy.textures().length]).toEqual([0, 0])
    const target = main.sceneTarget()
    copy.tie(target)
    await main.checked(() => {
      main.drawScene(target, sceneOf(), camera)
      copy.render(main.renderer)
    })
    expect(copy.bytes).toBe(SIZE * SIZE * 2)
    expect(copy.textures()).toEqual([copy.texture])
    const held = (
      main.renderer.backend as unknown as {
        get(texture: object): { texture: GPUTexture }
      }
    ).get(copy.texture).texture
    expect([held.format, held.mipLevelCount, held.width, held.height]).toEqual([
      'r16float',
      1,
      SIZE,
      SIZE,
    ])
    expect([copy.name, CLOUD_DEPTH_LABEL]).toEqual(['depth', 'cloud depth'])
    copy.dispose()
    expect([copy.bytes, copy.textures().length]).toEqual([0, 0])
    target.dispose()
  })
})

describe('the depth copy’s warm-up', () => {
  /*
   * A session of its own: three caches a pipeline across material instances,
   * so after the copies above have drawn, a warm-up in their session builds
   * nothing whether or not it compiled anything.
   */
  it('builds the pipeline against the tied multisampled depth, and the first draw builds none', async () => {
    const fresh = await openGpu(SIZE, SIZE)
    const own = rig(fresh)
    try {
      expect(own.layout.samples).toBe(4)
      const camera = view()
      const scene = sceneOf(facing(20, [-1.5, 1.5, -1.5, 1.5]))
      // The boot order: the copy is tied and warmed while the scene target is
      // still the pass's 1 × 1, and the scene pass first draws at its real
      // size afterwards, which makes its depth texture again.
      const target = own.sceneTarget(1)
      const copy = new CloudDepth(cameraUniforms(camera), own.layout)
      copy.tie(target)
      const before = fresh.pipelinesBuilt()
      await copy.warm(own.renderer)
      expect(fresh.pipelinesBuilt()).toBe(before + 1)
      target.setSize(SIZE, SIZE)
      await own.checked(() => own.drawScene(target, scene, camera))
      const drawn = fresh.pipelinesBuilt()
      await own.checked(() => copy.render(own.renderer))
      expect(fresh.pipelinesBuilt()).toBe(drawn)
      // And the draw drew: the plane twenty meters out, along the ray.
      const all = await own.texels(copy.texture)
      for (const [i, j] of [
        [7, 3],
        [0, 0],
        [31, 31],
      ] as const)
        expect(withinCopy(all[j * SIZE + i]!, alongRay(20, i, j))).toBe(true)
      copy.dispose()
      target.dispose()
    } finally {
      fresh.dispose()
    }
  })
})
