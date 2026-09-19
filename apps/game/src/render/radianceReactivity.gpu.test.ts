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

it('replaces hidden background reactivity and combines translucent coverage', async () => {
  const geometry = new PlaneGeometry(20, 20)
  const scene = new Scene()
  const camera = new PerspectiveCamera(60, 1, 0.1, 100)
  const materials = [
    sensorRadiance(new MeshBasicNodeMaterial(), true),
    sensorRadiance(new MeshBasicNodeMaterial()),
    sensorRadiance(new MeshBasicNodeMaterial(), false, false, 'alpha'),
    sensorRadiance(new MeshBasicNodeMaterial(), false, false, 'alpha'),
  ]
  const meshes = materials.map((material, index) => {
    material.colorNode = vec3(0.2)
    material.transparent = index >= 2
    if (index >= 2) material.opacityNode = float(index === 2 ? 0.4 : 0.5)
    const mesh = new Mesh(geometry, material)
    mesh.position.z = -4 + index * 0.5
    mesh.renderOrder = index
    mesh.visible = index < 2
    scene.add(mesh)
    return mesh
  })
  const target = new RenderTarget(32, 32, {
    type: FloatType,
    depthBuffer: false,
  })
  const sensor = createSensor(gpu.renderer, scene, camera, undefined, {
    aa: 'temporal',
    scale: 'native',
    sharpness: 'off',
  })
  const coverage = async () => {
    sensor.render(target)
    await gpu.read(target)
    const reactive = sensor.sceneTarget.textures.find(
      (entry) => entry.name === 'reactive',
    )!
    const mask = await gpu.drawGraph(vec4(texture(reactive).r, 0, 0, 1), {
      float: true,
    })
    return mask.at(16, 16)[0]
  }
  try {
    expect(await coverage()).toBe(0)
    meshes[2]!.visible = true
    meshes[3]!.visible = true
    expect(await coverage()).toBeCloseTo(0.7, 2)
  } finally {
    sensor.dispose()
    target.dispose()
    geometry.dispose()
    materials.forEach((material) => material.dispose())
  }
})
