import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
} from 'three/webgpu'
import { vec3 as rgb } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { Quaternion as Q, UV, vec3 } from '@inertialref/spatial'
import { createGalaxyField } from '@inertialref/universe'
import {
  DEFAULT_SENSOR_SETTINGS,
  exposurePinnedToLens,
  GALAXY_VIEWS,
  SURFACE_LUMINANCE,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { createGalaxyBackdrop, GalaxyVolumeNode } from './galaxyVolume.ts'
import { createSensor, declareSceneTarget } from './sensor.ts'
import { sensorRadiance } from './radiance.ts'
import { installToneCurve } from './tonemap.ts'
import { warmCompile, warmRenderer } from './warmup.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(96, 96)
})
afterAll(() => gpu.dispose())

it.each([1, 0])(
  'photographic daylight omission stays below one display code with dust scale %s',
  async (dustScale) => {
    const { renderer } = gpu
    renderer.setSize(96, 96, false)
    renderer.outputColorSpace = SRGBColorSpace
    declareSceneTarget(renderer, { samples: 4, optics: true })
    installToneCurve(renderer, 1)
    const lens = {
      ...GALAXY_VIEWS['edge-on'].lens,
      fStop: 2.8,
      shutter: 1 / 60,
      iso: 100,
    }
    const camera = new PerspectiveCamera(verticalFovDegrees(lens), 1, 0.1, 100)
    camera.updateMatrixWorld()
    const scene = new Scene()
    const volume = new GalaxyVolumeNode(
      createGalaxyField(rootSeed('inertialref'), { dustScale }),
    )
    const backdrop = createGalaxyBackdrop(volume)
    backdrop.visible = true
    scene.add(backdrop)
    // A lit foreground includes the PSF's mixing with the faint background;
    // equality between two otherwise black skies would not test that seam.
    const material = sensorRadiance(new MeshBasicNodeMaterial())
    material.colorNode = rgb(0.5, 0.3, 0.1)
    const body = new Mesh(new SphereGeometry(0.18, 24, 16), material)
    body.position.set(0.2, 0, -2)
    scene.add(body)
    const output = new RenderTarget(96, 96, {
      type: FloatType,
      depthBuffer: false,
    })
    let pinned: number | null = 0
    const sensor = createSensor(renderer, scene, camera, () => ({
      lens,
      settings: DEFAULT_SENSOR_SETTINGS,
      time: 0,
      noiseTick: 0,
      headroom: 1,
      pinned,
    }))
    try {
      await volume.warm(renderer)
      for (const object of [backdrop, body])
        await warmCompile(warmRenderer(renderer), { object, camera, scene })
      await sensor.warm()
      for (const yaw of [-Math.PI / 2, 0, Math.PI / 2]) {
        volume.configure(
          {
            position: UV.fromMeters(-8178 * PARSEC, 20.8 * PARSEC, 0),
            orientation: Q.fromAxisAngle(vec3(0, 1, 0), yaw),
          },
          lens,
        )
        backdrop.visible = true
        sensor.render(output)
        const withSky = await gpu.read(output)
        expect(sensor.exposure!.total).toBeCloseTo(1 / SURFACE_LUMINANCE, 12)
        backdrop.visible = false
        sensor.render(output)
        const withoutSky = await gpu.read(output)
        let worst = 0
        let lit = 0
        for (let i = 0; i < withSky.data.length; i++) {
          if (i % 4 === 3) continue
          worst = Math.max(
            worst,
            Math.abs(withSky.data[i]! - withoutSky.data[i]!),
          )
          if (withSky.data[i]! > 0.1) lit++
        }
        expect(lit).toBeGreaterThan(100)
        expect(worst).toBeLessThan(1 / 255)
      }
      // The same field must matter under a staged exposure. This control
      // fails if the integral or backdrop silently stops drawing altogether.
      pinned = exposurePinnedToLens(GALAXY_VIEWS['face-on'].lens)
      body.visible = false
      backdrop.visible = true
      sensor.render(output)
      const exposed = await gpu.read(output)
      backdrop.visible = false
      sensor.render(output)
      const hidden = await gpu.read(output)
      let difference = 0
      for (let i = 0; i < exposed.data.length; i++)
        difference = Math.max(
          difference,
          Math.abs(exposed.data[i]! - hidden.data[i]!),
        )
      expect(difference).toBeGreaterThan(0.05)
      expect(volume.diagnostics.draws).toBeGreaterThanOrEqual(3)
    } finally {
      sensor.dispose()
      output.dispose()
      volume.dispose()
      backdrop.geometry.dispose()
      backdrop.material.dispose()
      body.geometry.dispose()
      body.material.dispose()
    }
  },
)
