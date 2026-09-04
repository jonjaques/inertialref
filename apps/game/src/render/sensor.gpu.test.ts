import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Camera,
  CustomToneMapping,
  FloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicNodeMaterial,
  NoToneMapping,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SphereGeometry,
  Sprite,
  SRGBColorSpace,
} from 'three/webgpu'
import { positionLocal, vec3 } from 'three/tsl'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { createStarfieldMaterial, createStarMaterial } from './materials.ts'
import { createSensor, declareSceneTarget } from './sensor.ts'
import { installToneCurve } from './tonemap.ts'
import { warmCompile, warmRenderer } from './warmup.ts'

/*
 * The spine's gate, headless.
 *
 * `render/sensor.ts` claims the chain is pixel-identical to the renderer
 * drawing the scene itself, by construction. The construction is an argument
 * about node graphs; this reads both paths back from a float target and holds
 * them to each other, which is the claim rather than the argument. The
 * renderer's own path is reached through `setOutputRenderTarget`, the one way
 * to make it tone-map into something readable — a plain render target is
 * never the output target, and the curve is skipped for it.
 *
 * Zero samples on both sides, deliberately: the harness renderer is built
 * without MSAA, so its internal framebuffer is single-sampled, and a pass at
 * four would differ from it exactly along every edge — a difference about
 * anti-aliasing, not about the chain. The four-sample claim is the browser
 * diff in the ADR, where the renderer it is compared against has four too.
 */

const SIZE = 96

let gpu: GpuSession
let camera: Camera

beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
  /*
   * Opaque black, the way `createRenderer` clears. `renderOutput`
   * unpremultiplies before the curve and premultiplies after it, so a pixel
   * the renderer's own path leaves at alpha 0 — the harness default, under
   * every additive sprite — comes out black however bright its rgb was. The
   * chain writes alpha 1 and never sees that; the claim is about the frame
   * the renderer draws for itself with the production clear.
   */
  gpu.renderer.setClearColor(0x000000, 1)
  camera = new PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 4)
  camera.updateMatrixWorld()
})

afterAll(() => {
  gpu.dispose()
})

/**
 * Enough of the production picture to exercise the curve at both ends: a star
 * disk above white, a gradient sphere below it, and additive sprites over the
 * black — the three blend states the scene actually draws with.
 */
function stagedScene(): Scene {
  const scene = new Scene()
  const star = new Mesh(
    new SphereGeometry(0.9, 24, 16),
    createStarMaterial().material,
  )
  star.position.set(-1.2, 0, 0)
  scene.add(star)

  const gradient = new MeshBasicNodeMaterial()
  gradient.colorNode = positionLocal.add(1).mul(0.35)
  const ball = new Mesh(new SphereGeometry(0.9, 24, 16), gradient)
  ball.position.set(1.2, 0, 0)
  scene.add(ball)

  const field = createStarfieldMaterial(8)
  const positions = field.positions.array as Float32Array
  const colours = field.colours.array as Float32Array
  const prominence = field.prominence.array as Float32Array
  for (let i = 0; i < 8; i += 1) {
    positions[i * 3] = (i - 3.5) * 0.4
    positions[i * 3 + 1] = 1.4
    positions[i * 3 + 2] = -2
    colours[i * 3] = 1
    colours[i * 3 + 1] = 0.9
    colours[i * 3 + 2] = 0.8
    prominence[i] = i / 7
  }
  const sprites = new Sprite(field.material)
  sprites.count = 8
  sprites.frustumCulled = false
  scene.add(sprites)

  scene.updateMatrixWorld(true)
  return scene
}

function floatTarget(): RenderTarget {
  return new RenderTarget(SIZE, SIZE, { depthBuffer: false, type: FloatType })
}

describe('the spine', () => {
  it('draws the frame the renderer draws for itself, at headroom 1', async () => {
    const { renderer } = gpu
    installToneCurve(renderer, 1)
    declareSceneTarget(renderer, { samples: 0 })
    const scene = stagedScene()

    const own = floatTarget()
    renderer.setOutputRenderTarget(own)
    renderer.render(scene, camera)
    renderer.setOutputRenderTarget(null)
    const theirs = await gpu.read(own)

    const chain = floatTarget()
    const sensor = createSensor(renderer, scene, camera)
    sensor.render(chain)
    const ours = await gpu.read(chain)

    let worst = 0
    let lit = 0
    let alphaOne = 0
    for (let i = 0; i < theirs.data.length; i += 1) {
      const a = theirs.data[i] as number
      const b = ours.data[i] as number
      if (i % 4 === 3) {
        if (b === 1) alphaOne += 1
        continue
      }
      worst = Math.max(worst, Math.abs(a - b))
      if (a > 0.05) lit += 1
    }
    // A float target and one graph on both sides: the honest bound is the
    // arithmetic's, three orders under the 1/255 the browser diff is held to.
    expect(worst).toBeLessThan(1e-5)
    // And the picture had something in it — a black frame equal to a black
    // frame proves nothing.
    expect(lit).toBeGreaterThan(SIZE * SIZE * 0.1)
    // Alpha is asserted on the chain alone: it writes 1 everywhere, by
    // construction, whatever the clear was.
    expect(alphaOne).toBe(SIZE * SIZE)

    sensor.dispose()
    own.dispose()
    chain.dispose()
  })

  it('leaves the renderer as it found it when a frame throws', async () => {
    const { renderer } = gpu
    installToneCurve(renderer, 1)
    renderer.outputColorSpace = SRGBColorSpace
    declareSceneTarget(renderer, { samples: 0 })

    /*
     * The scene renders inside `RenderPipeline.render`'s swap of the renderer
     * to no curve and the working space, and the swap is undone by two plain
     * assignments after the quad. A throw from the scene — an `onBeforeRender`
     * here, in the app a draw against a pipeline the warm-up is still
     * building — leaves the swapped values on the renderer, where the chain's
     * own rebuild check reads them as a mode change. The chain restores them;
     * this is the frame that throws, and the frame after it.
     */
    const scene = new Scene()
    const flat = new MeshBasicNodeMaterial()
    flat.colorNode = vec3(0.18)
    const slab = new Mesh(new SphereGeometry(3, 8, 6), flat)
    let armed = true
    slab.onBeforeRender = () => {
      if (armed) throw new Error('a frame that throws')
    }
    scene.add(slab)
    scene.updateMatrixWorld(true)

    const target = floatTarget()
    const sensor = createSensor(renderer, scene, camera)
    expect(() => sensor.render(target)).toThrow('a frame that throws')
    expect(renderer.toneMapping).toBe(CustomToneMapping)
    expect(renderer.outputColorSpace).toBe(SRGBColorSpace)

    // And the next frame is the curve's. Held to the renderer's own output
    // rather than to a number, the way the first gate is: the poisoned
    // rebuild would present 0.18 as 0.18, and the curve and the transfer put
    // it near 0.45.
    armed = false
    sensor.render(target)
    const ours = (await gpu.read(target)).at(SIZE / 2, SIZE / 2)
    const own = floatTarget()
    renderer.setRenderTarget(null)
    renderer.setOutputRenderTarget(own)
    renderer.render(scene, camera)
    renderer.setOutputRenderTarget(null)
    const theirs = (await gpu.read(own)).at(SIZE / 2, SIZE / 2)
    expect(theirs[0]).toBeGreaterThan(0.3)
    for (let channel = 0; channel < 3; channel += 1)
      expect(
        Math.abs((ours[channel] as number) - (theirs[channel] as number)),
      ).toBeLessThan(1e-5)

    sensor.dispose()
    target.dispose()
    own.dispose()
  })

  it('draws the scene once per call, so a measured frame is a frame', async () => {
    const { renderer } = gpu
    installToneCurve(renderer, 1)
    renderer.outputColorSpace = SRGBColorSpace
    declareSceneTarget(renderer, { samples: 0 })

    /*
     * Three frames through one chain, back to back in one task, with no frame
     * of three's own between them — `measureGpuFrameMs`'s loop, and the shape
     * of every second frame in this file. A pass keyed on `nodeFrame.frameId`
     * draws the scene on the first and the quad alone on the rest: the
     * harness stubs the `requestAnimationFrame` that advances the counter, so
     * here that is once and never again. `info.calls` counts scene renders,
     * and a chain frame is two, the pass and the quad; the picture changing
     * between frames is what says the pass was the frame's own.
     */
    const scene = new Scene()
    const flat = new MeshBasicNodeMaterial()
    flat.colorNode = vec3(0.5)
    const slab = new Mesh(new SphereGeometry(3, 8, 6), flat)
    scene.add(slab)
    scene.updateMatrixWorld(true)

    const target = floatTarget()
    const sensor = createSensor(renderer, scene, camera)
    const before = renderer.info.calls
    sensor.render(target)
    const first = (await gpu.read(target)).at(SIZE / 2, SIZE / 2)
    slab.visible = false
    sensor.render(target)
    const second = (await gpu.read(target)).at(SIZE / 2, SIZE / 2)
    slab.visible = true
    sensor.render(target)
    const third = (await gpu.read(target)).at(SIZE / 2, SIZE / 2)
    expect(renderer.info.calls - before).toBe(6)
    expect(first[0]).toBeGreaterThan(0.3)
    expect(second[0]).toBe(0)
    expect(third[0]).toBe(first[0])

    sensor.dispose()
    target.dispose()
  })

  it('carries a value above white to its output unclamped', async () => {
    const { renderer } = gpu
    const scene = new Scene()
    const emitter = new MeshBasicNodeMaterial()
    emitter.colorNode = vec3(8, 4, 2)
    const slab = new Mesh(new SphereGeometry(3, 8, 6), emitter)
    scene.add(slab)
    scene.updateMatrixWorld(true)

    // No curve at all: the question is whether the chain's own quad clamps,
    // which is the one thing between the scene's radiance and the canvas the
    // `rgba16float` swap chain of spike 1 accepts values above one from.
    renderer.toneMapping = NoToneMapping
    declareSceneTarget(renderer, { samples: 0 })
    const target = floatTarget()
    const sensor = createSensor(renderer, scene, camera)
    const through = async (): Promise<[number, number, number, number]> => {
      sensor.render(target)
      return (await gpu.read(target)).at(SIZE / 2, SIZE / 2)
    }

    renderer.outputColorSpace = LinearSRGBColorSpace
    expect(await through()).toEqual([8, 4, 2, 1])

    // And through the encode the canvas actually gets: the sRGB transfer with
    // no clamp, which is what extended sRGB means — 2.0 lands at 1.353, the
    // number spike 1 quotes, and 8 and 4 above it in order.
    renderer.outputColorSpace = SRGBColorSpace
    const [r, g, b, a] = await through()
    expect(b).toBeCloseTo(1.055 * 2 ** (1 / 2.4) - 0.055, 3)
    expect(g).toBeGreaterThan(b)
    expect(r).toBeGreaterThan(g)
    expect(a).toBe(1)

    sensor.dispose()
    target.dispose()
  })

  it('draws with the pipelines a warm-up compiled', async () => {
    const { renderer } = gpu
    installToneCurve(renderer, 1)
    renderer.outputColorSpace = SRGBColorSpace
    // Four samples, which the harness renderer itself does not have: the
    // warm-up has to compile against the pass's shape rather than the
    // renderer's, or every pipeline is built twice.
    declareSceneTarget(renderer, { samples: 4 })

    /*
     * A material of its own per arm, so the pipeline it needs cannot have been
     * built by anything earlier in the file: the cache is keyed on the program
     * and the target's shape, and a constant in the graph is a program of its
     * own.
     */
    const arm = (shade: number): Scene => {
      const scene = new Scene()
      const material = new MeshBasicNodeMaterial()
      material.colorNode = vec3(shade, shade * 0.5, shade * 0.25)
      scene.add(new Mesh(new SphereGeometry(1, 12, 8), material))
      scene.updateMatrixWorld(true)
      return scene
    }
    const target = floatTarget()
    const present = async (scene: Scene): Promise<void> => {
      const sensor = createSensor(renderer, scene, camera)
      sensor.render(target)
      await gpu.read(target)
      sensor.dispose()
    }

    // The control: a compile the way the renderer would do it alone, against
    // its own single-sampled framebuffer. The chain then builds again.
    const cold = arm(0.31)
    await renderer.compileAsync(cold, camera, cold)
    const afterColdCompile = gpu.pipelinesBuilt()
    await present(cold)
    expect(gpu.pipelinesBuilt()).toBeGreaterThan(afterColdCompile)

    // Through the warm-up's seam, the compile is against the pass's shape and
    // the frame builds nothing the scene needs — at most the chain's own
    // output quad, which no scene compile can reach.
    const warm = arm(0.57)
    await warmCompile(warmRenderer(renderer), {
      object: warm,
      camera,
      scene: warm,
    })
    const afterWarmCompile = gpu.pipelinesBuilt()
    await present(warm)
    expect(gpu.pipelinesBuilt() - afterWarmCompile).toBeLessThanOrEqual(1)

    target.dispose()
  })
})
