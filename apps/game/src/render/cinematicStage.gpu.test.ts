import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  AddEquation,
  CustomBlending,
  Mesh,
  MeshBasicNodeMaterial,
  NodeUpdateType,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ZeroFactor,
} from 'three/webgpu'
import { float, pass, vec3 as nodeVec3 } from 'three/tsl'
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
const HULL = { lengthMetres: 46, beamMetres: 16 }
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
      fx.update(view(kind === 'entry' ? 1 : 0, kind === 'dust' ? 1 : 0), HULL)
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
      fx.update(null, null)
      const off = await gpu.drawGraph(scenePass, { float: true })
      expect(
        off.data.every((value, index) => index % 4 === 3 || value === 0),
      ).toBe(true)
      fx.update({ ...view(1, 1), elapsedSeconds: 48 }, HULL)
      await gpu.drawGraph(scenePass, { float: true })
      fx.update(view(kind === 'entry' ? 1 : 0, kind === 'dust' ? 1 : 0), HULL)
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

it('draws a dusty photographic sky with a cool halo at the Sun only when the script requests it', async () => {
  const camera = new PerspectiveCamera(55, 1, 0.1, 10000)
  const scene = new Scene()
  const fx = createLandingEffects()
  const foreground = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicNodeMaterial(),
  )
  foreground.material.colorNode = nodeVec3(0.02, 0.04, 0.3)
  foreground.position.z = -3
  scene.add(fx.group, foreground)
  const scenePass = pass(scene, camera)
  scenePass.updateBeforeType = NodeUpdateType.RENDER
  const sample = { ...view(0, 0), effects: { ...NO_EFFECTS, skyHaze: 1 } }
  try {
    setSceneExposure(gpu.renderer, 1 / SURFACE_LUMINANCE)
    // A null hull throughout: the sky is the stage's, and it has to draw
    // for the frames before the script's prop resolves.
    fx.update(sample, null)
    const first = await gpu.drawGraph(scenePass, { float: true })
    const horizon = first.at(5, 52)
    expect(horizon[0]).toBeGreaterThan(0.05)
    expect(horizon[0]).toBeGreaterThan(horizon[2] * 1.5)
    expect(first.at(48, 48)[2]).toBeCloseTo(0.3, 3)
    fx.update(sample, null, vec3(-5, 0, -10))
    const sunlit = await gpu.drawGraph(scenePass, { float: true })
    expect(sunlit.at(5, 52)[0]).toBeGreaterThan(horizon[0] * 1.3)
    expect(sunlit.at(5, 52)[0]).toBeGreaterThan(sunlit.at(90, 52)[0] * 1.3)
    // The halo is the blue of a Martian sunset, not a brighter tan: blue
    // rises faster than red toward the Sun, and the far sky stays warm.
    expect(sunlit.at(5, 52)[2]).toBeGreaterThan(sunlit.at(90, 52)[2] * 2)
    expect(sunlit.at(5, 52)[2] / sunlit.at(5, 52)[0]).toBeGreaterThan(
      sunlit.at(90, 52)[2] / sunlit.at(90, 52)[0],
    )
    fx.update(sample, null)
    setSceneExposure(gpu.renderer, 0.25 / SURFACE_LUMINANCE)
    const dim = await gpu.drawGraph(scenePass, { float: true })
    expect(dim.at(5, 52)[0] / horizon[0]).toBeCloseTo(0.25, 3)
    fx.update(view(0, 0), null)
    const off = await gpu.drawGraph(scenePass, { float: true })
    expect(off.at(5, 48)[0]).toBe(0)
    expect(off.at(48, 48)[2]).toBeCloseTo(0.3, 3)
  } finally {
    setSceneExposure(gpu.renderer, null)
    scenePass.dispose()
    foreground.geometry.dispose()
    foreground.material.dispose()
    fx.dispose()
  }
})

it.each([50, 5000])(
  'replaces transparent atmospheric radiance at %i metres without covering foreground or the Sun',
  async (distance) => {
    const camera = new PerspectiveCamera(55, 1, 0.1, 10000)
    const scene = new Scene()
    const fx = createLandingEffects()
    const geometry = new PlaneGeometry(1, 1)
    const foregroundMaterial = new MeshBasicNodeMaterial()
    foregroundMaterial.colorNode = nodeVec3(0.02, 0.04, 0.3)
    const foreground = new Mesh(geometry, foregroundMaterial)
    foreground.position.z = -3
    const sunMaterial = new MeshBasicNodeMaterial()
    sunMaterial.colorNode = nodeVec3(2, 1.5, 1)
    const sun = new Mesh(geometry, sunMaterial)
    sun.position.set(9, 9, -30)
    sun.scale.setScalar(3)
    const atmosphereMaterial = new MeshBasicNodeMaterial()
    atmosphereMaterial.colorNode = nodeVec3(0.5, 2, 3)
    atmosphereMaterial.opacityNode = float(0.25)
    atmosphereMaterial.transparent = true
    atmosphereMaterial.depthWrite = false
    // The production physical shell composites L + T·background. Test shell
    // geometry on either side of the sky dome, independently of depth sorting.
    atmosphereMaterial.blending = CustomBlending
    atmosphereMaterial.blendEquation = AddEquation
    atmosphereMaterial.blendSrc = OneFactor
    atmosphereMaterial.blendDst = OneMinusSrcAlphaFactor
    atmosphereMaterial.blendSrcAlpha = ZeroFactor
    atmosphereMaterial.blendDstAlpha = OneFactor
    const atmosphere = new Mesh(geometry, atmosphereMaterial)
    atmosphere.position.z = -distance
    atmosphere.scale.setScalar(distance * 2)
    atmosphere.visible = false
    scene.add(fx.group, foreground, sun, atmosphere)
    const scenePass = pass(scene, camera)
    scenePass.updateBeforeType = NodeUpdateType.RENDER
    try {
      setSceneExposure(gpu.renderer, 1 / SURFACE_LUMINANCE)
      fx.update({ ...view(0, 0), effects: { ...NO_EFFECTS, skyHaze: 1 } }, HULL)
      const baseline = await gpu.drawGraph(scenePass, { float: true })
      atmosphere.visible = true
      const composed = await gpu.drawGraph(scenePass, { float: true })
      expect(
        composed.data.every((value, index) => value === baseline.data[index]),
      ).toBe(true)
      expect(composed.at(48, 48)[2]).toBeCloseTo(0.3, 3)
      expect(
        composed.data.some((value, index) => index % 4 === 0 && value === 2),
      ).toBe(true)
      fx.update(view(0, 0), HULL)
      const unmodified = await gpu.drawGraph(scenePass, { float: true })
      expect(unmodified.at(5, 20)[2]).toBeCloseTo(3, 3)
    } finally {
      setSceneExposure(gpu.renderer, null)
      scenePass.dispose()
      geometry.dispose()
      foregroundMaterial.dispose()
      sunMaterial.dispose()
      atmosphereMaterial.dispose()
      fx.dispose()
    }
  },
)

it('keeps the lower hemisphere dark even when the Sun is below the ground', async () => {
  const camera = new PerspectiveCamera(55, 1, 0.1, 10000)
  camera.rotation.x = -Math.PI / 4
  const scene = new Scene()
  const fx = createLandingEffects()
  scene.add(fx.group)
  const scenePass = pass(scene, camera)
  scenePass.updateBeforeType = NodeUpdateType.RENDER
  const sample = { ...view(0, 0), effects: { ...NO_EFFECTS, skyHaze: 1 } }
  try {
    setSceneExposure(gpu.renderer, 1 / SURFACE_LUMINANCE)
    fx.update(sample, HULL)
    const baseline = await gpu.drawGraph(scenePass, { float: true })
    fx.update(sample, HULL, vec3(0, -5, -10))
    const subterraneanSun = await gpu.drawGraph(scenePass, { float: true })
    expect(
      subterraneanSun.data.every(
        (value, index) => value === baseline.data[index],
      ),
    ).toBe(true)
    expect(subterraneanSun.at(48, 48)[0]).toBeLessThan(0.01)
  } finally {
    setSceneExposure(gpu.renderer, null)
    scenePass.dispose()
    fx.dispose()
  }
})
