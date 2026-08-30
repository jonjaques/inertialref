import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  DataTexture,
  LinearFilter,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  RGBAFormat,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  Vector2,
  Vector3,
} from 'three/webgpu'
import { buildPatch } from '@inertialref/rendering'
import { regionAddress } from '@inertialref/universe'
import { scatteringFor } from './atmosphereLuts.ts'
import { createLensFlare } from './flare.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import {
  createAtmosphereMaterial,
  createStarfieldMaterial,
  createStarMaterial,
} from './materials.ts'
import {
  createCloudMaterial,
  createPlanetMaterial,
  createRingMaterial,
} from './planet.ts'
import { createTerrainMaterial } from './terrain.ts'
import { createWarpEffects } from './warpEffects.ts'

/*
 * Every production material, compiled to a Metal pipeline.
 *
 * The cheapest real coverage there is: a loop over the graphs, catching the
 * whole class of error that otherwise reaches a browser — WGSL Tint rejects, a
 * varying named after an attribute, two attribute names on one buffer, a
 * `Loop` built outside a `Fn`. Each of those has shipped here at least once,
 * and each surfaced as a black canvas with the real message on a channel the
 * page console does not carry.
 *
 * What this does not say is that a frame is right. Nothing here observes
 * presentation, and the browser procedure in `docs/agents/driving.md` remains
 * the end of rendering work.
 */

let gpu: GpuSession
let camera: Camera

beforeAll(async () => {
  gpu = await openGpu()
  camera = new PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 4)
  camera.updateMatrixWorld()
})

afterAll(() => {
  gpu.dispose()
})

/** A scene holding exactly `object`, so the compile is of that and nothing else. */
function staged(object: Object3D): Scene {
  const scene = new Scene()
  scene.add(object)
  scene.updateMatrixWorld(true)
  return scene
}

/**
 * A real patch, from the real builder, with a flat field on it.
 *
 * Nine samples a side rather than the production sixty-five: this is about the
 * attribute set, and the builder's own invariants — an odd resolution, two
 * rings of border — are what make it a patch rather than a grid.
 */
function patchMesh(material: Mesh['material']): Mesh {
  const resolution = 9
  const border = 2
  const stride = resolution + 2 * border
  const patch = buildPatch({
    region: regionAddress(0, 0, 0, 0),
    resolution,
    border,
    elevations: new Float32Array(stride * stride),
    cover: new Uint8Array(resolution * resolution * 4),
    bodyRadius: 1_737_400,
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(patch.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(patch.normals, 3))
  geometry.setAttribute(
    'terrainMorph',
    new BufferAttribute(patch.morphPositions, 3),
  )
  geometry.setAttribute(
    'terrainMorphNormal',
    new BufferAttribute(patch.morphNormals, 3),
  )
  geometry.setAttribute(
    'terrainCover',
    new BufferAttribute(patch.cover, 4, true),
  )
  geometry.setAttribute(
    'terrainMorphCover',
    new BufferAttribute(patch.morphCover, 4, true),
  )
  geometry.setIndex(new BufferAttribute(patch.indices, 1))
  const mesh = new Mesh(geometry, material)
  mesh.userData.eyeLocal = new Vector3()
  mesh.userData.morphBand = new Vector2(1, 2)
  mesh.userData.anchor = new Vector3(
    patch.anchor.x,
    patch.anchor.y,
    patch.anchor.z,
  )
  return mesh
}

describe('every production material compiles', () => {
  const sphere = () => new SphereGeometry(1, 16, 12)

  it('the star', async () => {
    await gpu.compile(
      new Mesh(sphere(), createStarMaterial().material),
      camera,
      staged(new Scene()),
    )
  })

  it('the atmosphere', async () => {
    const shell = new Mesh(sphere(), createAtmosphereMaterial().material)
    await gpu.compile(shell, camera, staged(shell))
  })

  it('the star field', async () => {
    const field = createStarfieldMaterial(8)
    const sprites = new Sprite(field.material)
    sprites.count = 8
    await gpu.compile(sprites, camera, staged(sprites))
  })

  it('the planet, its clouds and its rings', async () => {
    const planet = new Mesh(sphere(), createPlanetMaterial().material)
    const clouds = new Mesh(sphere(), createCloudMaterial().material)
    const rings = new Mesh(
      new RingGeometry(0.5, 1, 32),
      createRingMaterial().material,
    )
    for (const mesh of [planet, clouds, rings]) {
      await gpu.compile(mesh, camera, staged(mesh))
    }
  })

  it('the ground', async () => {
    const ground = patchMesh(createTerrainMaterial().material)
    await gpu.compile(ground, camera, staged(ground))
  })

  it('the lens flare', async () => {
    const flare = createLensFlare()
    // Dormant by construction; `compileAsync` skips what is invisible.
    flare.group.visible = true
    await gpu.compile(flare.group, camera, staged(flare.group))
    flare.dispose()
  })

  it('the warp effects', async () => {
    const warp = createWarpEffects(() => 6)
    warp.group.visible = true
    await gpu.compile(warp.group, camera, staged(warp.group))
    warp.dispose()
  })
})

/**
 * What a fragment program does with its textures, as a comparable shape: which
 * read each binding gets, and how many samplers were declared for them.
 * Identifiers are left out on purpose — `nodeUniform17` is a node id, and two
 * material instances never share one.
 */
function textureSignature(fragmentShader: string): string {
  const reads = (
    fragmentShader.match(/texture(?:Sample|SampleGrad|SampleLevel|Load)\(/g) ??
    []
  ).sort()
  const samplers = (fragmentShader.match(/: sampler;/g) ?? []).length
  const textures = (fragmentShader.match(/texture_2d<f32>/g) ?? []).length
  // Whether every binding got a sampler, not how many bindings there are: the
  // builder shares one binding between two uses of the same texture object,
  // and the stand-ins reuse one white pixel where the real maps are distinct.
  return `${samplers === textures ? 'sampled' : 'unsampled'}: ${reads.join(' ')}`
}

/** A 1×1 map loaded the way `TextureLoader` loads one: linear both ways. */
function linearPixel(): DataTexture {
  const map = new DataTexture(
    new Uint8Array([200, 200, 200, 255]),
    1,
    1,
    RGBAFormat,
  )
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.needsUpdate = true
  return map
}

describe('a stand-in texture compiles the program the real one draws with', () => {
  /*
   * Every material here runs one graph whether or not its maps have arrived,
   * on the strength of a 1×1 stand-in — and the boot warm-up compiles against
   * those stand-ins. The graph being identical is not enough: the WGSL builder
   * reads a nearest-filtered texture with `textureLoad` and no sampler, and a
   * linear one with `textureSample` and one, so a stand-in left at
   * `DataTexture`'s nearest default warms a program no real body draws with.
   * The ground's version is worse — its gradient sample has no `textureLoad`
   * path at all, so against a nearest stand-in it references a sampler that
   * was never declared and Tint refuses the module. Measured in the browser
   * before the stand-ins were made linear: standing on Gliese 1061 d streamed
   * 706 patches and drew a black frame, with `[Invalid ShaderModule
   * "fragment"]` on the console.
   */

  it('the ground', async () => {
    const standIn = createTerrainMaterial()
    const real = createTerrainMaterial()
    real.setAlbedoMap(linearPixel(), true)
    const a = patchMesh(standIn.material)
    const b = patchMesh(real.material)
    const withStandIn = await gpu.shader(a, camera, staged(a))
    const withMap = await gpu.shader(b, camera, staged(b))
    expect(textureSignature(withStandIn.fragmentShader)).toBe(
      textureSignature(withMap.fragmentShader),
    )
  })

  it('the atmosphere', async () => {
    const standIn = createAtmosphereMaterial()
    const real = createAtmosphereMaterial()
    const baked = scatteringFor(
      {
        colour: { r: 0.3, g: 0.5, b: 0.9 },
        limb: { r: 1, g: 0.5, b: 0.2 },
        thickness: 1,
      },
      1.02,
    )
    real.setScattering(baked.recipe, baked.transmittance, baked.multiScatter)
    const a = new Mesh(new SphereGeometry(1, 8, 8), standIn.material)
    const b = new Mesh(new SphereGeometry(1, 8, 8), real.material)
    const withStandIn = await gpu.shader(a, camera, staged(a))
    const withTables = await gpu.shader(b, camera, staged(b))
    expect(textureSignature(withStandIn.fragmentShader)).toBe(
      textureSignature(withTables.fragmentShader),
    )
  })

  it('the planet', async () => {
    const standIn = createPlanetMaterial()
    const real = createPlanetMaterial()
    real.setTextures({
      albedo: linearPixel(),
      normal: linearPixel(),
      night: linearPixel(),
      clouds: linearPixel(),
      ring: linearPixel(),
    })
    const a = new Mesh(new SphereGeometry(1, 8, 8), standIn.material)
    const b = new Mesh(new SphereGeometry(1, 8, 8), real.material)
    const withStandIn = await gpu.shader(a, camera, staged(a))
    const withMaps = await gpu.shader(b, camera, staged(b))
    expect(textureSignature(withStandIn.fragmentShader)).toBe(
      textureSignature(withMaps.fragmentShader),
    )
  })
})

describe('what the WGSL contains', () => {
  /*
   * Structure, never a snapshot: `getShaderAsync` carries no stability
   * guarantee, and a byte-for-byte comparison would go red on a `three`
   * upgrade with nothing wrong. A binding count and an identifier are the
   * claims a graph actually makes.
   */

  it('the atmosphere binds exactly its two scattering tables', async () => {
    // Transmittance and Ψ. A shell that stopped sampling one of them would
    // still compile and still draw — a sky with no sunset, or no twilight.
    const shell = new Mesh(
      new SphereGeometry(1, 8, 8),
      createAtmosphereMaterial().material,
    )
    const { fragmentShader } = await gpu.shader(shell, camera, staged(shell))
    const bindings = fragmentShader.match(/texture_2d<f32>/g) ?? []
    expect(bindings).toHaveLength(2)
  })

  it('the ground reads all four of its morph attributes in the vertex stage', async () => {
    const ground = patchMesh(createTerrainMaterial().material)
    const { vertexShader } = await gpu.shader(ground, camera, staged(ground))
    for (const name of [
      'terrainMorph',
      'terrainMorphNormal',
      'terrainCover',
      'terrainMorphCover',
    ]) {
      expect(vertexShader).toContain(name)
    }
  })
})

describe('a patch mesh supplies every attribute its material reads', () => {
  it('the real builder does', async () => {
    const ground = patchMesh(createTerrainMaterial().material)
    gpu.warnings()
    await gpu.compile(ground, camera, staged(ground))
    const missing = gpu
      .warnings()
      .filter((entry) => /not found on geometry/.test(entry.message))
    expect(missing).toEqual([])
  })

  it('a plain sphere does not, and the builder says which one', async () => {
    /*
     * Not hypothetical: a probe that paired this material with a
     * `SphereGeometry` reported this before rendering a single pixel. The
     * node builder warns and substitutes a constant for each missing
     * attribute, so the pipeline builds and the ground draws — un-morphed,
     * with no cover — which is a defect a compile smoke test alone cannot
     * see. The warning is the only signal, and it is one `warmCompile` in the
     * browser never surfaces.
     */
    const wrong = new Mesh(
      new SphereGeometry(1, 8, 8),
      createTerrainMaterial().material,
    )
    gpu.warnings()
    await gpu.compile(wrong, camera, staged(wrong))
    const missing = gpu
      .warnings()
      .filter((entry) => /not found on geometry/.test(entry.message))
      .map((entry) => entry.message)
    expect(missing.some((message) => message.includes('terrainMorph'))).toBe(
      true,
    )
  })
})
