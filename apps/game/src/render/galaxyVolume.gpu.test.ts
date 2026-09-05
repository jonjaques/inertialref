import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  FloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SphereGeometry,
} from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import { createGalaxyField } from '@inertialref/universe'
import {
  DEFAULT_SENSOR_SETTINGS,
  exposurePinnedToLens,
  GALAXY_VIEWS,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { createGalaxyBackdrop, GalaxyVolumeNode } from './galaxyVolume.ts'
import { createSensor, declareSceneTarget } from './sensor.ts'
import { installToneCurve } from './tonemap.ts'
import { warmCompile, warmRenderer } from './warmup.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(64, 64)
})
afterAll(() => gpu.dispose())

it('updates every sensor submission and composes foreground depth at full resolution', async () => {
  const view = GALAXY_VIEWS['face-on']
  const renderer = gpu.renderer
  renderer.setSize(64, 64, false)
  renderer.outputColorSpace = LinearSRGBColorSpace
  declareSceneTarget(renderer, { samples: 4, optics: true })
  installToneCurve(renderer, 1)
  const camera = new PerspectiveCamera(
    verticalFovDegrees(view.lens),
    1,
    0.1,
    100,
  )
  camera.updateMatrixWorld()
  const scene = new Scene()
  const volume = new GalaxyVolumeNode(
    createGalaxyField(rootSeed('inertialref')),
  )
  volume.configure(view.pose, view.lens)
  const backdrop = createGalaxyBackdrop(volume)
  backdrop.visible = true
  scene.add(backdrop)
  const material = new MeshBasicNodeMaterial()
  material.colorNode = vec3(0)
  const body = new Mesh(new SphereGeometry(0.35, 32, 24), material)
  body.position.set(0, 0, -2)
  scene.add(body)
  const output = new RenderTarget(64, 64, {
    type: FloatType,
    depthBuffer: false,
  })
  const sensor = createSensor(renderer, scene, camera, () => ({
    lens: view.lens,
    settings: DEFAULT_SENSOR_SETTINGS,
    time: 0,
    headroom: 1,
    pinned: exposurePinnedToLens(view.lens),
  }))
  try {
    await volume.warm(renderer)
    await warmCompile(warmRenderer(renderer), {
      object: backdrop,
      camera,
      scene,
    })
    await warmCompile(warmRenderer(renderer), { object: body, camera, scene })
    await sensor.warm()
    const pipelines = gpu.pipelinesBuilt()
    body.visible = false
    sensor.render(output)
    const clear = await gpu.read(output)
    expect(volume.diagnostics.submissions).toBe(1)
    expect(clear.at(32, 32)[0]).toBeGreaterThan(0.1)
    const presented = gpu.pipelinesBuilt()
    body.visible = true
    sensor.render(output)
    const covered = await gpu.read(output)
    expect(volume.diagnostics.submissions).toBe(2)
    expect(covered.at(32, 32)[0]).toBeLessThan(clear.at(32, 32)[0] * 0.02)
    expect(covered.at(24, 32)[0]).toBeGreaterThan(clear.at(24, 32)[0] * 0.9)
    sensor.render(output)
    const repeated = await gpu.read(output)
    expect(repeated.at(24, 32)).toEqual(covered.at(24, 32))
    expect(volume.diagnostics.submissions).toBe(3)
    expect(gpu.pipelinesBuilt()).toBe(presented)
    // One float readback output variant, plus r185's first cached Fn ordering
    // change. Subsequent submissions must build no more pipelines.
    expect(presented - pipelines).toBeLessThanOrEqual(2)
    renderer.setSize(95, 61, false)
    output.setSize(95, 61)
    camera.aspect = 95 / 61
    camera.updateProjectionMatrix()
    sensor.render(output)
    const resized = await gpu.read(output)
    expect(volume.diagnostics).toMatchObject({
      width: 24,
      height: 16,
      submissions: 4,
    })
    expect(resized.at(30, 30)[3]).toBe(1)
  } finally {
    sensor.dispose()
    volume.dispose()
    backdrop.geometry.dispose()
    backdrop.material.dispose()
    body.geometry.dispose()
    material.dispose()
    output.dispose()
  }
})
