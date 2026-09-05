import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SphereGeometry,
} from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { type GpuSession, openGpu, type Pixels } from './gpuHarness.ts'
import { groundDummy } from './groundWear.ts'
import { createStarMaterial } from './materials.ts'
import { warmCompile } from './warmup.ts'

/*
 * The half of `warmup.test.ts` that file says it cannot cover: whether the
 * pipeline `warmCompile` builds is the one a frame then draws with.
 *
 * The recipe's whole reason to exist is a measured fact about the backend —
 * shader source is built per material *instance*, against the live camera and
 * scene, and `compileAsync` skips invisible objects — so a warm-up that gets
 * any of that wrong compiles a variant nothing draws with and the cost lands on
 * the first frame. The Node test proves the toggle happens; this proves the
 * toggle is enough, by counting pipelines at the device.
 */

let gpu: GpuSession

/*
 * The count is taken at the device, which is the one place a pipeline cannot
 * be built without passing through — and `backend.device` is not a public
 * path, so the session owns the one cast and hands the number over.
 */
const created = (): number => gpu.pipelinesBuilt()

/**
 * Whether anything reached the target: a color channel above zero. The
 * session clears opaque, so alpha is 255 on every pixel of an empty frame and
 * a test over the whole buffer would call that a picture.
 */
const lit = (pixels: Pixels): boolean =>
  pixels.data.some((value, i) => i % 4 !== 3 && value !== 0)

beforeAll(async () => {
  gpu = await openGpu()
})

afterAll(() => {
  gpu.dispose()
})

function staged(): { scene: Scene; mesh: Mesh; camera: PerspectiveCamera } {
  const mesh = new Mesh(
    new SphereGeometry(1, 8, 8),
    createStarMaterial().material,
  )
  mesh.visible = false
  const scene = new Scene()
  scene.add(mesh)
  const camera = new PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.z = 4
  scene.updateMatrixWorld(true)
  camera.updateMatrixWorld()
  return { scene, mesh, camera }
}

describe('warmCompile', () => {
  it('builds the pipeline the frame draws with, so the frame builds none', async () => {
    const { scene, mesh, camera } = staged()
    /*
     * One target for both halves, and one *with a depth buffer*. A pipeline
     * is keyed on its attachments as well as on the material, so a warm-up
     * against the swap chain and a draw into an `rgba8unorm` target would be
     * two pipelines for a reason that has nothing to do with the recipe. The
     * depth buffer is the subtler half of that: `compileAsync` builds against
     * a render context that assumes a depth attachment, so warming against a
     * depthless target produces a `depth24plus` pipeline the depthless draw
     * then cannot use — measured here as one extra pipeline, and not a
     * production case, because the canvas always has depth.
     */
    const target = new RenderTarget(16, 16)
    gpu.renderer.setRenderTarget(target)

    const before = created()
    await warmCompile(gpu.renderer, { object: mesh, camera, scene })
    expect(created()).toBeGreaterThan(before)

    const warmed = created()
    mesh.visible = true
    const pixels = await gpu.draw(scene, camera, { into: target })
    expect(created()).toBe(warmed)
    /*
     * And the frame is a frame. `warmCompile` swallows its rejection by
     * design and the backend's draw returns early on a pipeline it marked
     * broken, so a material Tint refused would warm, draw nothing, and build
     * no second pipeline — passing the count assertion above on a black
     * frame. The star fills the middle of a 16×16 target; asking whether
     * anything reached it is what makes that assertion falsifiable.
     */
    expect(lit(pixels)).toBe(true)
    target.dispose()
  })

  it('and a frame drawn before the compile lands draws nothing of it, quietly', async () => {
    /*
     * `compileAsync` walks the tree, then builds what it queued one object at
     * a time: each pipeline is registered in the cache when the device is
     * asked for it, and the GPU object arrives when `createRenderPipelineAsync`
     * resolves. A frame in between finds the entry without the object, and
     * `Renderer._renderObjectDirect` draws nothing for it — `Pipelines.isReady`
     * gates the backend's draw. Without that gate the backend hands
     * `setPipeline` an undefined and throws out of the whole render: one lost
     * frame on every body the build-ahead materialises and, inside the sensor
     * chain, the throw `sensor.gpu.test.ts` guards the renderer against.
     * This holds the gate, because an upgrade could lose it: the frame before
     * the promise is quiet, empty and builds no second pipeline, and the
     * frame after it has the object. The window is microseconds wide, so the
     * harness holds the promise open and the frame is drawn inside it on
     * purpose.
     */
    const { scene, mesh, camera } = staged()
    // A program of its own — a constant in the graph is one — so the pipeline
    // this test leaves in the cache is nobody else's: the star materials the
    // other two stage compile to one fragment program, and the negative
    // control below counts on its draw being the first to need it.
    const own = new MeshBasicNodeMaterial()
    own.colorNode = vec3(0.61, 0.3, 0.15)
    mesh.material = own
    const target = new RenderTarget(16, 16)
    const { renderer } = gpu
    renderer.setRenderTarget(target)

    const before = created()
    const gate = gpu.holdNextPipeline()
    const compiled = warmCompile(renderer, { object: mesh, camera, scene })
    try {
      await gate.requested
      const walked = created()
      expect(walked).toBeGreaterThan(before)

      mesh.visible = true
      expect(() => renderer.render(scene, camera)).not.toThrow()
      expect(created()).toBe(walked)
      const early = await gpu.read(target)
      expect(lit(early)).toBe(false)
    } finally {
      // A hold left armed by a failed assertion would catch the next test's
      // first pipeline and hang it for its whole timeout.
      gate.release()
    }
    await compiled
    const walked = created()
    renderer.render(scene, camera)
    expect(created()).toBe(walked)
    const landed = await gpu.read(target)
    expect(lit(landed)).toBe(true)
    target.dispose()
  })

  it('and a dummy the camera cannot see still compiles', async () => {
    /*
     * `compileAsync` culls against the camera's frustum exactly as a render
     * does, and resolves the same whether the object was built or culled. A
     * warm-up dummy is a triangle at the origin, and the render origin is a
     * snapped grid point the camera lags — so a mount-time warm-up with the
     * origin out of view would compile nothing and say nothing, and the
     * first real patch would pay the build in the frame it lands. The
     * dresser's dummies opt out of culling; the plain mesh beside it is the
     * control that shows the cull is real.
     */
    const camera = new PerspectiveCamera(60, 1, 0.1, 100)
    camera.position.set(0, 0, 4)
    camera.lookAt(0, 0, 8)
    camera.updateMatrixWorld()
    const scene = new Scene()
    scene.updateMatrixWorld(true)
    const own = (): MeshBasicNodeMaterial => {
      const material = new MeshBasicNodeMaterial()
      material.colorNode = vec3(Math.random(), 0.2, 0.4)
      return material
    }

    const culled = new Mesh(new SphereGeometry(1, 8, 8), own())
    const before = created()
    await warmCompile(gpu.renderer, { object: culled, camera, scene })
    expect(created()).toBe(before)

    const dummy = groundDummy(own())
    await warmCompile(gpu.renderer, { object: dummy, camera, scene })
    expect(created()).toBeGreaterThan(before)
    dummy.geometry.dispose()
  })

  it('and the count can see a warm-up that missed', async () => {
    /*
     * The negative control: the same compile without the visibility toggle
     * — `compileAsync` on a dormant object — walks nothing, so the frame
     * pays for the pipeline. If this ever stopped going up, the assertion
     * above would be passing for a reason other than the recipe.
     */
    const { scene, mesh, camera } = staged()
    const target = new RenderTarget(16, 16)
    gpu.renderer.setRenderTarget(target)

    const before = created()
    await gpu.renderer.compileAsync(mesh, camera, scene)
    expect(created()).toBe(before)

    mesh.visible = true
    await gpu.draw(scene, camera, { into: target })
    expect(created()).toBeGreaterThan(before)
    target.dispose()
  })
})
