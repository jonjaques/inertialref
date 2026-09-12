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

it('anchors an authored horizontal coating streak on the visible Sun', async () => {
  const lens = LENS_PRESETS.flight
  const camera = new PerspectiveCamera(verticalFovDegrees(lens), 1, 0.01, 100)
  camera.updateMatrixWorld()
  const flare = createLensFlare()
  const scene = new Scene()
  scene.add(flare.group)
  const drive = (x: number, visibility: number, anamorphic: number) =>
    flare.update(
      camera,
      { x, y: 0, z: -50 },
      new Color(1, 1, 1),
      1,
      0.0005,
      { visibility, graze: 0, eclipse: null },
      0,
      0,
      lens,
      false,
      anamorphic,
    )
  try {
    drive(0, 1, 0)
    const off = await gpu.draw(scene, camera, { float: true })
    expect(off.at(80, 64)[2]).toBe(0)
    drive(0, 1, 1)
    const on = await gpu.draw(scene, camera, { float: true })
    expect(on.at(80, 64)[2]).toBeGreaterThan(0.003)
    expect(on.at(64, 80)[2]).toBeLessThan(0.001)
    drive(12, 1, 1)
    expect(
      flare.group.getObjectByName('anamorphic-sun-streak')?.position.x,
    ).toBeCloseTo(4.8, 9)
    drive(0, 0, 1)
    const hidden = await gpu.draw(scene, camera, { float: true })
    expect(hidden.at(80, 64)[2]).toBe(0)
  } finally {
    flare.dispose()
  }
})

it('attenuates the analytic solar glow without dimming the authored horizontal streak', async () => {
  const lens = LENS_PRESETS.flight
  const camera = new PerspectiveCamera(verticalFovDegrees(lens), 1, 0.01, 100)
  camera.updateMatrixWorld()
  const flare = createLensFlare()
  const scene = new Scene()
  scene.add(flare.group)
  const drive = (coreGain: number) =>
    flare.update(
      camera,
      { x: 0, y: 0, z: -50 },
      new Color(1, 1, 1),
      1,
      0.0005,
      { visibility: 1, graze: 0, eclipse: null },
      0.65,
      0,
      lens,
      true,
      0.9,
      coreGain,
    )
  try {
    drive(1)
    const full = await gpu.draw(scene, camera, { float: true })
    drive(0.06)
    const restrained = await gpu.draw(scene, camera, { float: true })
    expect(restrained.at(64, 64)[0]).toBeLessThan(full.at(64, 64)[0] * 0.8)
    expect(restrained.at(80, 64)[2]).toBeCloseTo(full.at(80, 64)[2], 5)
    expect(restrained.at(80, 64)[2]).toBeGreaterThan(0.003)
  } finally {
    flare.dispose()
  }
})
