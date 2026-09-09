import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
} from 'three/webgpu'
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

it('depth-tests the rope endpoints rather than its ribbon template', async () => {
  const materials = createEntryTraceMaterials()
  const target = new RenderTarget(32, 32, {
    type: FloatType,
    depthBuffer: true,
  })
  const geometry = new LineSegmentsGeometry()
  const line = new LineSegments2(geometry, materials.ring)
  line.position.z = -4
  line.renderOrder = 1
  const ground = new Mesh(
    new PlaneGeometry(10, 10),
    new MeshBasicNodeMaterial({ color: 0xff0000 }),
  )
  ground.position.z = -3.5
  const scene = new Scene()
  scene.add(ground, line)
  const camera = new PerspectiveCamera(60, 1, 0.1, 100)
  camera.updateMatrixWorld()
  try {
    for (const endpointZ of [1, -1]) {
      geometry.setPositions([-0.8, 0, endpointZ, 0.8, 0, endpointZ])
      scene.updateMatrixWorld(true)
      const pixels = await gpu.draw(scene, camera, { into: target })
      const blue = pixels.at(16, 16)[2]
      if (endpointZ > 0) expect(blue).toBeGreaterThan(0.5)
      else expect(blue).toBeLessThan(0.1)
    }
  } finally {
    geometry.dispose()
    target.dispose()
    ground.geometry.dispose()
    ground.material.dispose()
    for (const material of Object.values(materials)) material.dispose()
  }
})

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
