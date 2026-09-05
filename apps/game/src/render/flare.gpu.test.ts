import { afterAll, beforeAll, expect, it } from 'vitest'
import { Color, PerspectiveCamera, Scene } from 'three/webgpu'
import { LENS_PRESETS, verticalFovDegrees } from '@inertialref/rendering'
import { createLensFlare } from './flare.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(128, 128)
})
afterAll(() => gpu.dispose())

it('keeps Natural’s Sun glow when the ghost chain is turned down', async () => {
  const lens = LENS_PRESETS.flight
  const camera = new PerspectiveCamera(verticalFovDegrees(lens), 1, 0.01, 100)
  camera.updateMatrixWorld()
  const flare = createLensFlare()
  const scene = new Scene()
  scene.add(flare.group)
  try {
    flare.update(
      camera,
      { x: 0, y: 0, z: -50 },
      new Color(1, 1, 1),
      1,
      0.0005,
      { visibility: 1, graze: 0, eclipse: null },
      0,
      0,
      lens,
    )
    const picture = await gpu.draw(scene, camera, {
      width: 128,
      height: 128,
      float: true,
    })
    expect(picture.at(64, 64)[0]).toBeGreaterThan(0.5)
    expect(picture.at(69, 64)[0]).toBeGreaterThan(0.04)
    expect(picture.at(85, 64)[0]).toBeLessThan(0.001)
  } finally {
    flare.dispose()
  }
})
