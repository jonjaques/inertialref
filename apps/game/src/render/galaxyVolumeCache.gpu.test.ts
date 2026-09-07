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

it('keeps full-resolution foreground occlusion and held-frame identity after cache publication', async () => {
  const view = GALAXY_VIEWS['face-on']
  const renderer = gpu.renderer
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
    { cache: { faceSize: 32, tileSize: 16 } },
  )
  volume.configure(view.pose, view.lens)
  const backdrop = createGalaxyBackdrop(volume)
  backdrop.visible = true
  scene.add(backdrop)
  const material = new MeshBasicNodeMaterial()
  material.colorNode = vec3(0)
  const body = new Mesh(new SphereGeometry(0.35, 32, 24), material)
  body.position.set(0, 0, -2)
  body.visible = false
  scene.add(body)
  const output = new RenderTarget(64, 64, {
    type: FloatType,
    depthBuffer: false,
  })
  const sensor = createSensor(renderer, scene, camera, () => ({
    lens: view.lens,
    settings: DEFAULT_SENSOR_SETTINGS,
    time: 0,
    noiseTick: 0,
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
    for (let i = 0; i < 24; i++) sensor.render(output)
    const clear = await gpu.read(output)
    expect(volume.diagnostics.cache).toMatchObject({
      ready: true,
      using: true,
      tiles: 24,
      published: 1,
    })
    expect(clear.at(32, 32)[0]).toBeGreaterThan(0.1)
    body.visible = true
    sensor.render(output)
    const covered = await gpu.read(output)
    expect(covered.at(32, 32)[0]).toBeLessThan(clear.at(32, 32)[0] * 0.02)
    expect(covered.at(24, 32)[0]).toBeGreaterThan(clear.at(24, 32)[0] * 0.9)
    const draws = volume.diagnostics.draws
    sensor.render(output)
    const repeated = await gpu.read(output)
    expect(repeated.at(24, 32)).toEqual(covered.at(24, 32))
    expect(volume.diagnostics.draws).toBe(draws)
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
