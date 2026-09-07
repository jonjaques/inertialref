import { afterAll, beforeAll, expect, it } from 'vitest'
import { Mesh, PerspectiveCamera, Scene, SphereGeometry } from 'three/webgpu'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { createCloudMaterial } from './planet.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => gpu?.dispose())

it('lets a descending eye leave cloud coverage without a culling step', async () => {
  const clouds = createCloudMaterial()
  clouds.sunDirection.value.set(0, 0, 1)
  const mesh = new Mesh(new SphereGeometry(100, 32, 24), clouds.material)
  const scene = new Scene()
  scene.add(mesh)
  const camera = new PerspectiveCamera(30, 1, 0.00001, 1000)
  const levels: number[] = []
  try {
    for (const distance of [4, 2, 1, 0.5, 0.1, 0.001, -0.001]) {
      camera.position.set(0, 0, 100 + distance)
      camera.lookAt(0, 0, 0)
      camera.updateMatrixWorld(true)
      levels.push(
        (
          await gpu.draw(scene, camera, { width: 1, height: 1, float: true })
        ).at(0, 0)[0],
      )
    }
    // Distant weather retains its coverage, while a crossing cannot remove
    // an opaque texel in one frame just because its front face passes the eye.
    expect(levels[0]).toBeGreaterThan(0.9)
    expect(levels[1]).toBeCloseTo(levels[0]!, 5)
    expect(levels[3]).toBeGreaterThan(0.1)
    expect(levels[3]).toBeLessThan(0.9)
    expect(Math.abs(levels[5]! - levels[6]!)).toBeLessThan(0.001)
    expect(levels[6]).toBe(0)
  } finally {
    mesh.geometry.dispose()
    clouds.material.dispose()
  }
})
