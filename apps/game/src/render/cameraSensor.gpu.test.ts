import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
} from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { DEFAULT_SENSOR_SETTINGS } from '@inertialref/rendering'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { createSensor, declareSceneTarget } from './sensor.ts'
import { sensorRadiance } from './radiance.ts'
import { createHistogramMeter } from './meter.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(32, 32)
})
afterAll(() => gpu.dispose())

it('excludes visible instrument pixels from the physical histogram', async () => {
  declareSceneTarget(gpu.renderer, { samples: 0, optics: true })
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.z = 2
  camera.updateMatrixWorld()
  const ground = new Mesh(
    new PlaneGeometry(2, 2),
    sensorRadiance(new MeshBasicNodeMaterial()),
  )
  ground.material.colorNode = vec3(0.3)
  const ink = new Mesh(
    new PlaneGeometry(1, 2),
    sensorRadiance(new MeshBasicNodeMaterial(), true, true),
  )
  ink.material.colorNode = vec3(10)
  ink.position.set(-0.5, 0, 0.1)
  ink.renderOrder = 2
  scene.add(ground, ink)
  const sensor = createSensor(gpu.renderer, scene, camera)
  const target = new RenderTarget(32, 32, { type: FloatType })
  try {
    sensor.render(target)
    const mask = sensor.sceneTarget.textures.find((t) => t.name === 'meterMask')
    expect(mask).toBeDefined()
    const meter = createHistogramMeter(
      sensor.sceneTarget.texture,
      undefined,
      mask,
    )
    try {
      meter.width.value = 8
      meter.height.value = 8
      meter.count.count = 64
      await gpu.compute(meter.clear)
      await gpu.compute(meter.count)
      const bins = new Uint32Array(await gpu.readBuffer(meter.bins))
      expect(bins.reduce((sum, count) => sum + count, 0)).toBe(32)
    } finally {
      meter.dispose()
    }
    const image = await gpu.read(target)
    expect(image.at(4, 16)[0]).toBeGreaterThan(image.at(28, 16)[0])
  } finally {
    sensor.dispose()
    target.dispose()
    for (const mesh of [ground, ink]) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }
})
