import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
} from 'three/webgpu'
import { float, texture, vec3, vec4 } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { createSensor } from './sensor.ts'
import { sensorRadiance } from './radiance.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(32, 32)
})
afterAll(() => gpu.dispose())

it.each([
  [false, false, 0, 0],
  [true, false, undefined, 1],
  [false, true, undefined, 1],
  [false, false, 'alpha', 0.4],
  [false, false, 0.3, 0.3],
] as const)(
  'marks material history coverage: overlay %s, instrument %s, coverage %s',
  async (overlay, instrument, coverage, expected) => {
    const material = sensorRadiance(
      new MeshBasicNodeMaterial(),
      overlay,
      instrument,
      coverage,
    )
    material.colorNode = vec3(0.2)
    material.opacityNode = float(0.4)
    material.transparent = true
    const geometry = new PlaneGeometry(20, 20)
    const mesh = new Mesh(geometry, material)
    mesh.position.z = -2
    const scene = new Scene()
    scene.add(mesh)
    const camera = new PerspectiveCamera(60, 1, 0.1, 100)
    const target = new RenderTarget(32, 32, {
      type: FloatType,
      depthBuffer: false,
    })
    const sensor = createSensor(gpu.renderer, scene, camera, undefined, {
      aa: 'temporal',
      scale: 'native',
      sharpness: 'off',
    })
    try {
      sensor.render(target)
      await gpu.read(target)
      const reactive = sensor.sceneTarget.textures.find(
        (entry) => entry.name === 'reactive',
      )!
      const mask = await gpu.drawGraph(vec4(texture(reactive).r, 0, 0, 1), {
        float: true,
      })
      expect(mask.at(16, 16)[0]).toBeCloseTo(expected, 2)
    } finally {
      sensor.dispose()
      target.dispose()
      geometry.dispose()
      material.dispose()
    }
  },
)
