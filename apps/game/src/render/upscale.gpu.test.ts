import { DEFAULT_SENSOR_SETTINGS, LENS_PRESETS } from '@inertialref/rendering'
import { sensorRadiance } from './radiance.ts'
import type { SensorFrame } from './sensor.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicNodeMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
} from 'three/webgpu'
import { Fn, float, texture, vec3, vec4 } from 'three/tsl'
import { createSensor, declareSceneTarget, warmTargetFor } from './sensor.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { reactiveCoverage } from './sensorMrt.ts'
import { warmCompile, warmRenderer } from './warmup.ts'
import type { Picture } from './picture.ts'

let gpu: GpuSession
const SIZE = 64
beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
  gpu.renderer.toneMapping = NoToneMapping
  gpu.renderer.outputColorSpace = LinearSRGBColorSpace
})
afterAll(() => gpu.dispose())

function rig(picture: Picture, frame?: () => SensorFrame) {
  gpu.renderer.setSize(SIZE, SIZE, false)
  declareSceneTarget(gpu.renderer, {
    samples: 0,
    depthType: FloatType,
    optics: frame !== undefined,
  })
  const camera = new PerspectiveCamera(60, 1, 0.05, 1e10)
  const scene = new Scene()
  const material = new MeshBasicNodeMaterial()
  material.colorNode = vec3(0.25, 0.5, 2)
  if (frame !== undefined) sensorRadiance(material)
  const slab = new Mesh(new PlaneGeometry(100, 100), material)
  slab.position.z = -10
  scene.add(slab)
  scene.updateMatrixWorld(true)
  camera.updateMatrixWorld(true)
  const sensor = createSensor(gpu.renderer, scene, camera, frame, picture)
  const target = new RenderTarget(SIZE, SIZE, {
    type: FloatType,
    depthBuffer: false,
  })
  return {
    camera,
    scene,
    slab,
    material,
    sensor,
    target,
    dispose() {
      sensor.dispose()
      target.dispose()
      slab.geometry.dispose()
      material.dispose()
    },
  }
}

const spatial: Picture = { aa: 'off', scale: 'performance', sharpness: 'off' }
const temporal: Picture = { aa: 'temporal', scale: 'quality', sharpness: 'off' }

describe('the upscaler on the physical GPU', () => {
  it('reconstructs a constant HDR field at display size and runs every call', async () => {
    const f = rig(spatial)
    try {
      f.sensor.render(f.target)
      const first = await gpu.read(f.target)
      expect(first.at(32, 32)).toEqual([0.25, 0.5, 2, 1])
      expect(f.sensor.sceneTarget.width).toBe(32)
      expect(f.sensor.diagnostics.picture).toMatchObject({
        path: 'spatial',
        renderWidth: 32,
        displayWidth: 64,
        frames: 1,
      })
      f.slab.visible = false
      f.sensor.render(f.target)
      expect((await gpu.read(f.target)).at(32, 32)).toEqual([0, 0, 0, 1])
      expect(f.sensor.diagnostics.picture.frames).toBe(2)
      // Output and EASU scratch, two 1×1 exposures, one inert reactive texel.
      expect(f.sensor.diagnostics.picture.workingTextureBytes).toBe(
        SIZE * SIZE * 16 + 17,
      )
    } finally {
      f.dispose()
    }
  })

  it('preserves a constant HDR field through temporal accumulation', async () => {
    const f = rig(temporal)
    try {
      for (let i = 0; i < 20; i++) f.sensor.render(f.target, 1 / 60)
      const pixel = (await gpu.read(f.target)).at(32, 32)
      expect(pixel[0]).toBeCloseTo(0.25, 2)
      expect(pixel[1]).toBeCloseTo(0.5, 2)
      expect(pixel[2]).toBeCloseTo(2, 2)
      expect(pixel[3]).toBe(1)
      expect(f.sensor.diagnostics.picture.frames).toBe(20)
      expect(f.camera.view?.enabled).toBe(false)
      expect(f.sensor.sceneTarget.depthTexture!.type).toBe(FloatType)
      const backend = gpu.renderer.backend as unknown as {
        get(object: object): { texture: GPUTexture }
      }
      expect(
        backend.get(f.sensor.sceneTarget.depthTexture!).texture.format,
      ).toBe('depth32float')
    } finally {
      f.dispose()
    }
  })

  it('clears jitter even if the scene throws', async () => {
    const f = rig(temporal)
    let seenJitter = false
    f.slab.onBeforeRender = () => {
      seenJitter = f.camera.view?.enabled === true
      throw new Error('scene interrupted')
    }
    try {
      expect(() => f.sensor.render(f.target)).toThrow('scene interrupted')
      expect(seenJitter).toBe(true)
      expect(f.camera.view?.enabled).toBe(false)
      expect(gpu.renderer.toneMapping).toBe(NoToneMapping)
      expect(gpu.renderer.getMRT()).toBe(null)
      expect(gpu.renderer.getRenderTarget()).toBe(f.target)
      expect(gpu.renderer.getMRT()).toBe(null)
      expect(gpu.renderer.getRenderTarget()).toBe(f.target)
      f.slab.onBeforeRender = () => {}
      f.sensor.render(f.target)
      expect((await gpu.read(f.target)).at(32, 32)[1]).toBeGreaterThan(0.4)
    } finally {
      f.dispose()
    }
  })

  it('resets and reallocates at the exact new display and render dimensions', async () => {
    const f = rig(temporal)
    try {
      f.sensor.render(f.target)
      await gpu.read(f.target)
      const resets = f.sensor.diagnostics.picture.resets
      gpu.renderer.setSize(90, 60, false)
      f.sensor.render(f.target)
      await gpu.read(f.target)
      expect(f.sensor.diagnostics.picture).toMatchObject({
        renderWidth: 60,
        renderHeight: 40,
        displayWidth: 90,
        displayHeight: 60,
        phase: 1,
        resets: resets + 1,
      })
    } finally {
      f.dispose()
    }
  })

  it('warms the complete temporal attachment layout before the first frame', async () => {
    const f = rig(temporal)
    try {
      const warm = warmTargetFor(gpu.renderer)
      expect(
        warm.textures.map((one) => [one.name, one.format, one.type]),
      ).toEqual(
        f.sensor.sceneTarget.textures.map((one) => [
          one.name,
          one.format,
          one.type,
        ]),
      )
      expect(warm.depthTexture!.type).toBe(FloatType)
      await warmCompile(warmRenderer(gpu.renderer), {
        object: f.scene,
        camera: f.camera,
        scene: f.scene,
      })
      await f.sensor.warm(f.target)
      const before = gpu.pipelinesBuilt()
      f.sensor.render(f.target)
      await gpu.read(f.target)
      expect(gpu.pipelinesBuilt() - before).toBe(0)
    } finally {
      f.dispose()
    }
  })

  it('writes the material coverage into its independent reactive attachment', async () => {
    const f = rig(temporal)
    f.material.outputNode = Fn(() => {
      reactiveCoverage.assign(0.3)
      return vec4(0.25, 0.5, 2, 1)
    })()
    try {
      f.sensor.render(f.target)
      await gpu.read(f.target)
      const reactive = f.sensor.sceneTarget.textures.find(
        (one) => one.name === 'reactive',
      )!
      const mask = await gpu.drawGraph(vec4(texture(reactive).r, 0, 0, 1), {
        float: true,
      })
      expect(mask.at(32, 32)[0]).toBeCloseTo(0.3, 2)
    } finally {
      f.dispose()
    }
  })

  it('keeps the full optical chain in the resolved linear exposure domain', async () => {
    const state: SensorFrame = {
      lens: LENS_PRESETS.flight,
      settings: DEFAULT_SENSOR_SETTINGS,
      time: 1,
      pinned: 0,
      headroom: 2,
      noiseTick: 0,
      pictureEpoch: 1,
    }
    const original = rig(
      { aa: 'off', scale: 'native', sharpness: 'off' },
      () => state,
    )
    let reference: readonly number[]
    try {
      for (let i = 0; i < 4; i++) original.sensor.render(original.target)
      reference = (await gpu.read(original.target)).at(32, 32)
    } finally {
      original.dispose()
    }
    for (const picture of [
      spatial,
      { ...spatial, aa: 'msaa' as const },
      temporal,
    ]) {
      const f = rig(picture, () => state)
      try {
        for (let i = 0; i < 20; i++) f.sensor.render(f.target)
        const pixel = (await gpu.read(f.target)).at(32, 32)
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(pixel[channel]! - reference[channel]!)).toBeLessThan(
            0.015,
          )
        expect(pixel[3]).toBe(1)
        expect(f.sensor.sceneTarget.textures).toHaveLength(
          picture.aa === 'temporal' ? 5 : 3,
        )
      } finally {
        f.dispose()
      }
    }
  })

  it('restarts temporal history on declared cuts and processing-domain changes', async () => {
    let epoch = 3
    let settings = DEFAULT_SENSOR_SETTINGS
    const f = rig(temporal, () => ({
      lens: LENS_PRESETS.flight,
      settings,
      time: 1,
      pinned: null,
      headroom: 2,
      pictureEpoch: epoch,
    }))
    try {
      for (let i = 0; i < 5; i++) f.sensor.render(f.target)
      await gpu.read(f.target)
      const before = f.sensor.diagnostics.picture.resets
      expect(f.sensor.diagnostics.picture.phase).toBe(5)
      epoch++
      f.sensor.render(f.target)
      await gpu.read(f.target)
      expect(f.sensor.diagnostics.picture).toMatchObject({
        resets: before + 1,
        phase: 1,
      })
      settings = { ...settings, mode: 'manual' }
      f.sensor.render(f.target)
      await gpu.read(f.target)
      expect(f.sensor.diagnostics.picture).toMatchObject({
        resets: before + 2,
        phase: 1,
      })
    } finally {
      f.dispose()
    }
  })

  it('keeps rigid velocity at zero across a render-origin rebase', async () => {
    const f = rig(temporal)
    try {
      f.sensor.render(f.target)
      await gpu.read(f.target)
      // Previous view × previous model and current view × current model
      // describe the same point despite both coordinate translations.
      f.camera.position.set(8192, -4096, 32768)
      f.slab.position.add(f.camera.position)
      f.camera.updateMatrixWorld(true)
      f.scene.updateMatrixWorld(true)
      f.sensor.render(f.target)
      await gpu.read(f.target)
      const attachment = f.sensor.sceneTarget.textures.find(
        (one) => one.name === 'velocity',
      )!
      const pixels = await gpu.drawGraph(vec4(texture(attachment).rg, 0, 1), {
        float: true,
      })
      let worst = 0
      for (let i = 0; i < pixels.data.length; i += 4)
        worst = Math.max(
          worst,
          Math.abs(pixels.data[i]!),
          Math.abs(pixels.data[i + 1]!),
        )
      expect(worst).toBeLessThan(1e-5)
    } finally {
      f.dispose()
    }

    const moving = rig(temporal)
    try {
      moving.sensor.render(moving.target)
      await gpu.read(moving.target)
      moving.slab.position.x += 1
      moving.scene.updateMatrixWorld(true)
      moving.sensor.render(moving.target)
      await gpu.read(moving.target)
      const attachment = moving.sensor.sceneTarget.textures.find(
        (one) => one.name === 'velocity',
      )!
      const pixels = await gpu.drawGraph(vec4(texture(attachment).rg, 0, 1), {
        float: true,
      })
      expect(Math.abs(pixels.at(32, 32)[0])).toBeGreaterThan(0.1)
    } finally {
      moving.dispose()
    }
  })

  it('keeps reversed depth distinguishable at astronomical distances without frag_depth', async () => {
    const f = rig(spatial)
    try {
      const shader = await gpu.shader(f.slab, f.camera, f.scene)
      expect(shader.fragmentShader).not.toContain('@builtin(frag_depth)')
      f.slab.position.z = -1e8
      f.slab.scale.setScalar(1e8)
      f.scene.updateMatrixWorld(true)
      f.sensor.render(f.target)
      await gpu.read(f.target)
      const depth = f.sensor.sceneTarget.depthTexture!
      const first = (
        await gpu.drawGraph(
          vec4(texture(depth).r, float(0), float(0), float(1)),
          { float: true },
        )
      ).at(32, 32)[0]
      f.slab.position.z = -2e8
      f.scene.updateMatrixWorld(true)
      f.sensor.render(f.target)
      await gpu.read(f.target)
      const second = (
        await gpu.drawGraph(
          vec4(texture(depth).r, float(0), float(0), float(1)),
          { float: true },
        )
      ).at(32, 32)[0]
      expect(first).toBeGreaterThan(0)
      expect(first).toBeGreaterThan(second * 1.9)
      expect(second).toBeGreaterThan(0)
    } finally {
      f.dispose()
    }
  })
})
