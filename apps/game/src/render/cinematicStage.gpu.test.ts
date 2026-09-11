import { afterAll, beforeAll, expect, it } from 'vitest'
import { NodeUpdateType, PerspectiveCamera, Scene } from 'three/webgpu'
import { pass } from 'three/tsl'
import {
  lensForFov,
  NO_EFFECTS,
  SURFACE_LUMINANCE,
} from '@inertialref/rendering'
import { Quaternion, vec3 } from '@inertialref/spatial'
import type { CinematicView } from '../engine/GameEngine.ts'
import { createLandingEffects } from './cinematicStage.ts'
import { createThrusterPlumes } from './plumes.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { setSceneExposure } from './radiance.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(96, 96)
})
afterAll(() => gpu.dispose())

const pose = { position: vec3(0, 0, 0), orientation: Quaternion.IDENTITY }
function view(entryHeat: number, landingDust: number): CinematicView {
  return {
    frame: 240,
    elapsedSeconds: 10,
    lens: lensForFov(55),
    camera: pose,
    ship: { ...pose, visible: true, model: 'rocinante' },
    stage: { ...pose, model: 'mars-pad' },
    texts: [],
    effects: { ...NO_EFFECTS, entryHeat, landingDust },
  }
}

it.each(['entry', 'dust'] as const)(
  'draws warm %s flow only at the requested sample',
  async (kind) => {
    const camera = new PerspectiveCamera(55, 1, 0.1, 1000)
    camera.position.set(65, 25, 100)
    camera.lookAt(0, 0, 0)
    const scene = new Scene()
    const fx = createLandingEffects()
    scene.add(fx.group)
    const scenePass = pass(scene, camera)
    scenePass.updateBeforeType = NodeUpdateType.RENDER
    try {
      setSceneExposure(gpu.renderer, 1 / SURFACE_LUMINANCE)
      fx.update(view(kind === 'entry' ? 1 : 0, kind === 'dust' ? 1 : 0))
      const first = await gpu.drawGraph(scenePass, { float: true })
      let red = 0
      let blue = 0
      for (let y = 0; y < first.height; y += 1)
        for (let x = 0; x < first.width; x += 1) {
          const pixel = first.at(x, y)
          red += pixel[0]
          blue += pixel[2]
        }
      expect(red).toBeGreaterThan(0.5)
      expect(red).toBeGreaterThan(blue * 1.5)
      fx.update(null)
      const off = await gpu.drawGraph(scenePass, { float: true })
      expect(
        off.data.every((value, index) => index % 4 === 3 || value === 0),
      ).toBe(true)
      fx.update({ ...view(1, 1), elapsedSeconds: 48 })
      await gpu.drawGraph(scenePass, { float: true })
      fx.update(view(kind === 'entry' ? 1 : 0, kind === 'dust' ? 1 : 0))
      const sought = await gpu.drawGraph(scenePass, { float: true })
      expect(sought.data).toEqual(first.data)
    } finally {
      setSceneExposure(gpu.renderer, null)
      scenePass.dispose()
      fx.dispose()
    }
  },
)

it('seeks the drive turbulence and throttle independently of rendered history', async () => {
  const camera = new PerspectiveCamera(55, 1, 0.01, 100)
  camera.position.set(2, 1, 6)
  camera.lookAt(0, 0, 1)
  const scene = new Scene()
  const plumes = createThrusterPlumes({
    nozzles: [],
    drive: { position: vec3(0, 0, 0), radius: 0.3 },
  })
  scene.add(plumes.group)
  const scenePass = pass(scene, camera)
  scenePass.updateBeforeType = NodeUpdateType.RENDER
  try {
    plumes.sample(0.7, 12.5)
    const first = await gpu.drawGraph(scenePass, { float: true })
    expect(
      first.data.some((value, index) => index % 4 !== 3 && value > 0.1),
    ).toBe(true)
    plumes.update(null, 1, 0.2)
    await gpu.drawGraph(scenePass, { float: true })
    plumes.sample(0.7, 12.5)
    expect((await gpu.drawGraph(scenePass, { float: true })).data).toEqual(
      first.data,
    )
  } finally {
    scenePass.dispose()
    plumes.dispose()
  }
})
