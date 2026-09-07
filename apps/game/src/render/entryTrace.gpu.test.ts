import { afterAll, beforeAll, expect, it } from 'vitest'
import { OrthographicCamera, Scene } from 'three/webgpu'
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { createEntryTraceMaterials } from './entryTrace.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { setSceneExposure } from './radiance.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(32, 32)
})
afterAll(() => gpu.dispose())

it('draws a two-pixel landing ring at the same radiance across exposures', async () => {
  const materials = createEntryTraceMaterials()
  const geometry = new LineSegmentsGeometry().setPositions([
    -0.8, 0, 0, 0.8, 0, 0,
  ])
  const line = new LineSegments2(geometry, materials.ring)
  const scene = new Scene()
  scene.add(line)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  camera.position.z = 0.5
  camera.updateMatrixWorld()
  scene.updateMatrixWorld(true)
  try {
    const readings: number[] = []
    for (const exposure of [1e-6, 1]) {
      setSceneExposure(gpu.renderer, exposure, exposure)
      const pixels = await gpu.draw(scene, camera, { float: true })
      let rows = 0
      let blue = 0
      for (let y = 0; y < pixels.height; y += 1) {
        const value = pixels.at(16, y)[2]
        if (value > 0.5) rows += 1
        blue = Math.max(blue, value)
      }
      expect(rows).toBe(2)
      readings.push(blue)
    }
    expect(readings[0]).toBeCloseTo(1.8, 3)
    expect(readings[1]).toBeCloseTo(readings[0]!, 3)
  } finally {
    setSceneExposure(gpu.renderer, null)
    geometry.dispose()
    for (const material of Object.values(materials)) material.dispose()
  }
})
