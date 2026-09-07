import { afterAll, beforeAll, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  CAMERA_MODES,
  DEFAULT_SENSOR_SETTINGS,
  LENS_PRESETS,
  resolveCameraPolicy,
  SURFACE_LUMINANCE,
  surfaceColour,
  surfaceVisibilityGain,
  terrainPalette,
  type TerrainPalette,
} from '@inertialref/rendering'
import {
  type Body,
  catalogStub,
  generateSystem,
  MILKY_WAY,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import {
  DataTexture,
  LinearFilter,
  Mesh,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  SphereGeometry,
} from 'three/webgpu'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import {
  anchorGround,
  groundDummy,
  placeEye,
  seaDummy,
  wearSea,
} from './groundWear.ts'
import { createPlanetMaterial } from './planet.ts'
import { NO_TEXTURES } from './planetTextures.ts'
import { setSceneExposure } from './radiance.ts'
import { createTerrainMaterial } from './terrain.ts'
import { createWaterMaterial } from './water.ts'

const system = generateSystem(
  rootSeed('inertialref'),
  MILKY_WAY,
  catalogStub(TEST_CATALOG.stars[0]!),
)
const bennu = [...walkBodies(system)].find((body) => body.name === 'Bennu')!
const RADIUS = 1_000_000
let gpu: GpuSession
const camera = new PerspectiveCamera(60, 1, 0.1, 100)
camera.position.set(0, 0, 4)
camera.updateMatrixWorld()

beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => gpu?.dispose())

function sceneFor(mesh: Mesh): Scene {
  const scene = new Scene()
  scene.add(mesh)
  scene.updateMatrixWorld(true)
  return scene
}

/** A uniform deposit isolates the source colour from geology and detail. */
function uniformPalette(body: Body): TerrainPalette {
  const palette = terrainPalette(body)
  const deposit = { ...palette.regolith, grain: 0, bump: 0 }
  return {
    ...palette,
    rock: deposit,
    regolith: deposit,
    basalt: deposit,
    sand: deposit,
    evaporite: deposit,
    ice: deposit,
    seabed: deposit,
    pigment: deposit,
    mineralLow: { r: 1, g: 1, b: 1 },
    mineralHigh: { r: 1, g: 1, b: 1 },
    freshGain: 1,
    airThickness: 0,
    seaLevel: null,
    sheet: 0,
    liquid: null,
  }
}

it.each([true, false])(
  'keeps mapped=%s sphere, ground and bake reflectance consistent across modes',
  async (mapped) => {
    const body: Body = {
      ...bennu,
      appearance: { ...bennu.appearance, texture: mapped ? 'bennu' : null },
    }
    const palette = uniformPalette(body)
    const terrain = createTerrainMaterial()
    terrain.setPalette(palette, RADIUS)
    terrain.sunDirection.value.set(0, 0, 1)
    const ground = groundDummy(terrain.material)
    anchorGround(ground, { x: 0, y: 0, z: RADIUS }, RADIUS)
    placeEye(ground, { x: 0, y: 0, z: 4 }, 1, 2)
    const groundScene = sceneFor(ground)
    const planet = createPlanetMaterial()
    planet.sunDirection.value.set(0, 0, 1)
    const tint = surfaceColour(body.appearance)
    planet.baseColour.value.setRGB(tint.r, tint.g, tint.b)
    const sphere = new Mesh(new SphereGeometry(1, 32, 24), planet.material)
    const sphereScene = sceneFor(sphere)
    const map = new DataTexture(
      new Uint8Array([32, 32, 32, 255]),
      1,
      1,
      RGBAFormat,
    )
    map.minFilter = map.magFilter = LinearFilter
    map.needsUpdate = true
    terrain.setAlbedoMap(mapped ? map : null, mapped)
    planet.setTextures({ ...NO_TEXTURES, albedo: mapped ? map : null })
    const expected = mapped ? 32 / 255 : body.appearance.colour.r
    try {
      for (const mode of CAMERA_MODES) {
        const policy = resolveCameraPolicy(
          { ...DEFAULT_SENSOR_SETTINGS, mode },
          LENS_PRESETS.flight,
        )
        const enhanced = policy.processing === 'enhanced'
        const gain = surfaceVisibilityGain(
          body.appearance.geometricAlbedo,
          0.3,
          enhanced,
        )
        terrain.albedoScale.value = planet.albedoScale.value = gain
        setSceneExposure(
          gpu.renderer,
          1 / SURFACE_LUMINANCE,
          1 / SURFACE_LUMINANCE,
          policy.processing,
        )
        const surface = (
          await gpu.draw(groundScene, camera, { float: true })
        ).at(36, 27)
        const disk = (await gpu.draw(sphereScene, camera, { float: true })).at(
          32,
          32,
        )
        // The triangle sample is off-axis; the Lommel-Seeliger view term
        // differs by under one percent from the disk's central sample.
        expect(
          Math.abs(surface[0] / (expected * gain) - (enhanced ? 1.03 : 1)),
          `${mode} ground`,
        ).toBeLessThan(0.01)
        expect(
          Math.abs(disk[0] / (expected * gain) - 1),
          `${mode} sphere`,
        ).toBeLessThan(0.01)
        terrain.setBakeMode(1)
        const bake = (await gpu.draw(groundScene, camera, { float: true })).at(
          36,
          27,
        )
        expect(bake[0], `${mode} physical bake`).toBeCloseTo(expected, 5)
        terrain.setBakeMode(0)
      }
    } finally {
      setSceneExposure(gpu.renderer, null)
      ground.geometry.dispose()
      terrain.material.dispose()
      sphere.geometry.dispose()
      planet.material.dispose()
      map.dispose()
    }
  },
)

it.each(['ground', 'water', 'foam'] as const)(
  'reserves the %s night-side visibility floor for Enhanced',
  async (kind) => {
    const palette = uniformPalette({
      ...bennu,
      appearance: { ...bennu.appearance, texture: null },
    })
    const terrain = createTerrainMaterial()
    const water = createWaterMaterial({ refraction: false })
    terrain.setPalette(palette, RADIUS)
    water.setPalette(palette)
    water.setQuality({ refraction: false, waveOctaves: 0 })
    const material = kind === 'ground' ? terrain : water
    material.sunDirection.value.set(0.1, 0, -1).normalize()
    const mesh =
      kind === 'ground'
        ? groundDummy(material.material)
        : seaDummy(material.material)
    if (kind === 'water') {
      for (const name of ['waterDepth', 'waterMorphDepth']) {
        const depth = mesh.geometry.getAttribute(name)
        for (let i = 0; i < depth.count; i += 1) depth.setX(i, 10)
      }
    }
    if (kind === 'ground') anchorGround(mesh, { x: 0, y: 0, z: RADIUS }, RADIUS)
    else wearSea(mesh, { x: 0, y: 0, z: RADIUS })
    placeEye(mesh, { x: 0, y: 0, z: 4 }, 1, 2)
    const scene = sceneFor(mesh)
    try {
      for (const processing of [
        'photographic',
        'enhanced',
        'photographic',
      ] as const) {
        setSceneExposure(
          gpu.renderer,
          1 / SURFACE_LUMINANCE,
          1 / SURFACE_LUMINANCE,
          processing,
        )
        const pixel = (await gpu.draw(scene, camera, { float: true })).at(
          36,
          27,
        )
        expect(pixel.every(Number.isFinite)).toBe(true)
        if (processing === 'enhanced')
          expect(Math.max(...pixel.slice(0, 3))).toBeGreaterThan(0.0001)
        else expect(Math.max(...pixel.slice(0, 3))).toBeLessThan(1e-7)
      }
      // The real atmosphere still lights a surface just beyond the direct
      // beam's terminator, independently of the visibility floor.
      const aired = { ...palette, airThickness: 0.4, terminator: 0.025 }
      terrain.setPalette(aired, RADIUS)
      water.setPalette(aired)
      material.sunDirection.value.set(1, 0, -0.1).normalize()
      const twilight = (await gpu.draw(scene, camera, { float: true })).at(
        36,
        27,
      )
      expect(Math.max(...twilight.slice(0, 3))).toBeGreaterThan(1e-5)
    } finally {
      setSceneExposure(gpu.renderer, null)
      mesh.geometry.dispose()
      terrain.material.dispose()
      water.material.dispose()
    }
  },
)
