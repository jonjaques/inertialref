import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Mesh,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SphereGeometry,
} from 'three/webgpu'
import { type GpuSession, openGpu } from './gpuHarness.ts'
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
let created = 0

beforeAll(async () => {
  gpu = await openGpu()
  /*
   * The count is taken at the device, which is the one place a pipeline
   * cannot be built without passing through. `backend.device` is not a
   * public path; wrapping its two constructors is the smallest observation
   * that answers the question, and it is confined to this file.
   */
  const device = (gpu.renderer.backend as unknown as { device: GPUDevice })
    .device
  const sync = device.createRenderPipeline.bind(device)
  const async = device.createRenderPipelineAsync.bind(device)
  device.createRenderPipeline = (descriptor) => {
    created += 1
    return sync(descriptor)
  }
  device.createRenderPipelineAsync = (descriptor) => {
    created += 1
    return async(descriptor)
  }
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

    const before = created
    await warmCompile(gpu.renderer, { object: mesh, camera, scene })
    expect(created).toBeGreaterThan(before)

    const warmed = created
    mesh.visible = true
    gpu.renderer.setRenderTarget(target)
    await gpu.draw(scene, camera, { into: target })
    expect(created).toBe(warmed)
    target.dispose()
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

    const before = created
    await gpu.renderer.compileAsync(mesh, camera, scene)
    expect(created).toBe(before)

    mesh.visible = true
    gpu.renderer.setRenderTarget(target)
    await gpu.draw(scene, camera, { into: target })
    expect(created).toBeGreaterThan(before)
    target.dispose()
  })
})
