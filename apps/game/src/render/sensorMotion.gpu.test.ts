import { afterAll, beforeAll, expect, it } from 'vitest'
import { DEFAULT_SENSOR_SETTINGS, LENS_PRESETS } from '@inertialref/rendering'
import {
  createRenderOrigin,
  maintainOrigin,
  toRenderSpace,
  UV,
  vec3,
} from '@inertialref/spatial'
import {
  FloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
} from 'three/webgpu'
import { uv, vec3 as rgb } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { sensorRadiance } from './radiance.ts'
import { createSensor, declareSceneTarget } from './sensor.ts'
import { installToneCurve } from './tonemap.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(64, 64)
})
afterAll(() => gpu.dispose())

it('bypasses optical motion at a rebase and resumes on the next physical frame', async () => {
  const renderer = gpu.renderer
  installToneCurve(renderer, 1)
  renderer.outputColorSpace = LinearSRGBColorSpace
  declareSceneTarget(renderer, { samples: 0, optics: true })
  const anchor = UV.fromMeters(8e20, -3e20, 5e20)
  let origin = createRenderOrigin(anchor)
  const prop = UV.translate(anchor, vec3(4095, 0, -100))
  const camera = new PerspectiveCamera(65, 1, 0.1, 1000)
  camera.position.x = 4080
  camera.updateMatrixWorld()
  const material = sensorRadiance(new MeshBasicNodeMaterial())
  material.colorNode = rgb(uv().x, uv().y, 0.5).mul(0.02)
  const plane = new Mesh(new PlaneGeometry(400, 400), material)
  plane.position.set(4095, 0, -100)
  const scene = new Scene()
  scene.add(plane)
  let draws = 0
  plane.onBeforeRender = () => {
    draws++
  }
  let time = 0
  const dt = 1 / 60
  const lens = { ...LENS_PRESETS.flight, shutter: 1 / 120 }
  const sensor = createSensor(renderer, scene, camera, () => ({
    lens,
    settings: { ...DEFAULT_SENSOR_SETTINGS, mode: 'manual' },
    time,
    adaptationTime: time,
    renderOrigin: origin,
    historyKey: 'moving-prop',
    pinned: null,
    headroom: 1,
    motionBlur: true,
    noiseTick: 0,
  }))
  const target = new RenderTarget(64, 64, {
    type: FloatType,
    depthBuffer: false,
  })
  // The headless renderer has no rAF to advance Three's velocity history.
  const frames = (
    renderer as unknown as { _nodes: { nodeFrame: { frameId: number } } }
  )._nodes.nodeFrame
  const draw = async (distance: number, instant: number) => {
    time = instant
    const eye = UV.translate(anchor, vec3(distance, 0, 0))
    origin = maintainOrigin(origin, eye)
    const placedEye = toRenderSpace(origin, eye)
    const placedProp = toRenderSpace(origin, prop)
    camera.position.set(placedEye.x, placedEye.y, placedEye.z)
    plane.position.set(placedProp.x, placedProp.y, placedProp.z)
    camera.updateMatrixWorld()
    plane.updateMatrixWorld()
    frames.frameId++
    sensor.render(target)
    const image = await gpu.read(target)
    expect(image.data.every(Number.isFinite)).toBe(true)
    expect(image.at(32, 32)[0]).toBeGreaterThan(0.02)
    expect(image.at(32, 32)[3]).toBe(1)
    return sensor.diagnostics
  }
  try {
    await sensor.warm()
    draws = 0
    expect((await draw(4080, 0)).motionPasses).toBe(0)
    const moving = await draw(4090, dt)
    expect(origin.generation).toBe(0)
    expect(moving.shutterFraction).toBeCloseTo(lens.shutter / dt, 12)
    expect(moving.motionPasses).toBe(3)
    const rebased = await draw(4100, dt * 2)
    expect(origin.generation).toBe(1)
    expect(rebased.shutterFraction).toBe(0)
    expect(rebased.motionPasses).toBe(0)
    const resumed = await draw(4110, dt * 3)
    expect(origin.generation).toBe(1)
    expect(resumed.shutterFraction).toBeCloseTo(lens.shutter / dt, 12)
    expect(resumed.motionPasses).toBe(3)
    lens.fStop = 4
    const aperture = await draw(4120, dt * 4)
    expect(aperture.motionPasses).toBe(3)
    expect(aperture.shutterFraction).toBeCloseTo(lens.shutter / dt, 12)
    expect(draws).toBe(5)
  } finally {
    sensor.dispose()
    target.dispose()
    plane.geometry.dispose()
    material.dispose()
  }
})
