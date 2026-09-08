import { afterAll, beforeAll, expect, it } from 'vitest'
import { Mesh, PerspectiveCamera, Scene, SphereGeometry } from 'three/webgpu'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { createCloudMaterial } from './planet.ts'
import { cloudShellAltitude } from '@inertialref/rendering'
import { Quaternion, vec3 } from '@inertialref/spatial'

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
      clouds.eyeAltitude.value = cloudShellAltitude(
        vec3(0, 0, 100 + distance),
        Quaternion.IDENTITY,
        100,
        1,
      )
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

it('fades the grazing rim with the nadir before crossing the deck', async () => {
  const clouds = createCloudMaterial()
  clouds.sunDirection.value.set(0, 0, 1)
  const mesh = new Mesh(new SphereGeometry(100, 128, 96), clouds.material)
  const scene = new Scene()
  scene.add(mesh)
  const camera = new PerspectiveCamera(140, 1, 0.00001, 1000)
  try {
    for (const height of [0.5, 0.1, 0.001]) {
      camera.position.set(0, 0, 100 + height)
      camera.lookAt(100, 0, 100 + height - 26.8)
      camera.updateMatrixWorld(true)
      clouds.eyeAltitude.value = cloudShellAltitude(
        vec3(0, 0, 100 + height),
        Quaternion.IDENTITY,
        100,
        1,
      )
      const pixels = await gpu.draw(scene, camera, {
        width: 33,
        height: 33,
        float: true,
      })
      const maximum = Math.max(
        ...Array.from(pixels.data).filter((_, i) => i % 4 === 0),
      )
      expect(maximum).toBeGreaterThan(0)
      expect(maximum).toBeLessThanOrEqual(
        height * height * (3 - 2 * height) + 0.001,
      )
    }
  } finally {
    mesh.geometry.dispose()
    clouds.material.dispose()
  }
})
