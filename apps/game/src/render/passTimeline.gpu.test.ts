import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
} from 'three/webgpu'
import { screenUV, vec3, viewportSharedTexture } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import {
  installPassTimeline,
  namePass,
  passTimelineOf,
  type PassTimelineResult,
} from './passTimeline.ts'

let gpu: GpuSession
const SIZE = 64
beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
})
afterAll(() => gpu.dispose())

/** The device's verdict on everything `body` encoded and submitted. */
async function validated(body: () => Promise<void>): Promise<string | null> {
  const device = (gpu.renderer.backend as unknown as { device: GPUDevice })
    .device
  device.pushErrorScope('validation')
  await body()
  return (await device.popErrorScope())?.message ?? null
}

/*
 * An opaque slab, and in front of it a transparent sheet that reads the frame
 * behind it the way the sea does — which makes three end the pass, copy the
 * target, and resume the pass from the same descriptor.
 */
function sea() {
  const camera = new PerspectiveCamera(60, 1, 0.05, 100)
  const scene = new Scene()
  const ground = new MeshBasicNodeMaterial()
  ground.colorNode = vec3(0.2, 0.4, 0.1)
  const slab = new Mesh(new PlaneGeometry(100, 100), ground)
  slab.position.z = -10
  const water = new MeshBasicNodeMaterial({ transparent: true })
  water.colorNode = viewportSharedTexture(screenUV).rgb.mul(0.5)
  const sheet = new Mesh(new PlaneGeometry(100, 100), water)
  sheet.position.z = -5
  scene.add(slab, sheet)
  scene.updateMatrixWorld(true)
  camera.updateMatrixWorld(true)
  const target = new RenderTarget(SIZE, SIZE, { type: FloatType })
  namePass(target, 'scene')
  return {
    draw() {
      gpu.renderer.setRenderTarget(target)
      gpu.renderer.render(scene, camera)
      gpu.renderer.setRenderTarget(null)
    },
    dispose() {
      target.dispose()
      slab.geometry.dispose()
      sheet.geometry.dispose()
      ground.dispose()
      water.dispose()
    },
  }
}

describe('the pass timeline on the physical GPU', () => {
  it('times the scene pass on both sides of a framebuffer copy', async () => {
    const stop = installPassTimeline(gpu.renderer)
    const rig = sea()
    try {
      const timeline = passTimelineOf(gpu.renderer)
      // The feature is what the whole instrument rests on; a Dawn without it
      // is a harness to fix, not a test to skip.
      expect(timeline).not.toBeNull()
      rig.draw() // compile outside the measurement
      let result!: PassTimelineResult
      expect(
        await validated(async () => {
          result = await timeline!.measure(rig.draw, 8)
        }),
      ).toBeNull()
      expect(result.dropped).toBe(0)
      expect(result.passes.map((pass) => pass.label)).toEqual([
        'scene',
        'scene after copy',
      ])
      for (const pass of result.passes) {
        expect(pass.count).toBe(1)
        expect(pass.ms).toBeGreaterThanOrEqual(0)
      }
      expect(result.spanMs).toBeGreaterThan(0)
    } finally {
      rig.dispose()
      stop()
    }
  })

  it('leaves nothing timed once the measurement has ended', async () => {
    const stop = installPassTimeline(gpu.renderer)
    const rig = sea()
    try {
      const timeline = passTimelineOf(gpu.renderer)!
      await timeline.measure(rig.draw, 2)
      // An unarmed frame between two measurements must not write into the
      // second one's slots, which a descriptor still naming the set would.
      let again!: PassTimelineResult
      expect(
        await validated(async () => {
          rig.draw()
          again = await timeline.measure(rig.draw, 3)
        }),
      ).toBeNull()
      expect(again.passes.map((pass) => pass.count)).toEqual([1, 1])
    } finally {
      rig.dispose()
      stop()
    }
  })
})
