import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Color,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LineSegments,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  RenderTarget,
  RGBAFormat,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  CubeRenderTarget,
} from 'three/webgpu'
import { float, uniform, vec3, vec4 } from 'three/tsl'
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { openSession, type Session } from '@inertialref/devtools'
import { rng, rootSeed } from '@inertialref/procedural'
import {
  buildPatch,
  LIMB_STRETCH,
  terrainPalette,
} from '@inertialref/rendering'
import {
  type Body,
  COVER_CHANNELS,
  liquidAppearance,
  parseAddress,
  regionAddress,
  SOL,
  SOLAR_PLANETS,
  walkBodies,
} from '@inertialref/universe'
import {
  createAirUniforms,
  ORBIT_BEAM_FLOOR,
  sunTableAt,
  sunThrough,
} from './air.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import { setSceneExposure } from './radiance.ts'
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
import { createWaterMaterial, DEFAULT_WATER_QUALITY } from './water.ts'
import {
  anchorGround,
  COVER_ATTRIBUTES,
  groundDummy,
  MORPH_COVER_ATTRIBUTES,
  patchGeometry,
  placeEye,
  seaDummy,
  sheetGeometry,
  wearGround,
  wearSea,
} from './groundWear.ts'
import { createThrusterPlumes } from './plumes.ts'
import { createCloudFrontHandle } from './cloudSystem.ts'
import { createEntryTraceMaterials } from './entryTrace.ts'
import { thrusterLayoutFor } from './thrusterLayouts.ts'
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
    cover: new Uint8Array(resolution * resolution * COVER_CHANNELS),
    bodyRadius: 1_737_400,
  })
  const mesh = new Mesh(
    patchGeometry(patch, new BufferAttribute(patch.indices, 1)),
    material,
  )
  wearGround(mesh, patch.anchor, 1_737_400)
  placeEye(mesh, { x: 0, y: 0, z: 0 }, 1, 2, 0)
  return mesh
}

describe('every production material compiles', () => {
  const sphere = () => new SphereGeometry(1, 16, 12)

  it('the star', async () => {
    const star = new Mesh(sphere(), createStarMaterial().material)
    await gpu.compile(star, camera, staged(star))
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

  it('the ground, with its unbounded lattice and its gullies', async () => {
    const ground = patchMesh(createTerrainMaterial().material)
    await gpu.compile(ground, camera, staged(ground))
    // The macro band and the gullies are functions of their own; a graph that
    // dropped a branch would still compile, and would not carry them.
    const { fragmentShader } = await gpu.shader(ground, camera, staged(ground))
    expect(fragmentShader).toContain('latticeNoise')
    expect(fragmentShader).toContain('gullyStripes')
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

  it('the plumes: the jets, the pods, the drive and its disk', async () => {
    // The measured hull, so every one of the three shell shadings and the
    // disk is in the group; the debug layout would compile only the drive.
    const plumes = createThrusterPlumes(thrusterLayoutFor('rocinante'))
    // Lit, so the visibility gate below `DARK` does not hide them from the
    // compile — `compileAsync` skips what is invisible.
    const firing = new Float32Array(plumes.nozzleCount).fill(1)
    plumes.update(firing, 1, 1)
    await gpu.compile(plumes.group, camera, staged(plumes.group))
    plumes.dispose()
  })
})

/**
 * What a fragment program does with its textures, as a comparable shape: which
 * read each binding gets, and how many samplers were declared for them.
 * Identifiers are left out on purpose — `nodeUniform17` is a node id, and two
 * material instances never share one.
 */
function textureSignature(fragmentShader: string): string {
  const reads = (fragmentShader.match(/texture\w*\(/g) ?? [])
    .filter((call) => !/^texture(Dimensions|NumLevels|NumLayers)\(/.test(call))
    .sort()
  const samplers = (fragmentShader.match(/:\s*sampler\s*;/g) ?? []).length
  const textures = (fragmentShader.match(/texture_2d\s*<\s*f32\s*>/g) ?? [])
    .length
  // The bake's two records are cubes, and they are the pair that shared.
  const cubes = (fragmentShader.match(/texture_cube\s*<\s*f32\s*>/g) ?? [])
    .length
  /*
   * Vacuity is the failure mode to guard, not a missed read. Every part of
   * this is a formatting detail of `WGSLNodeBuilder.getUniforms`, and a three
   * upgrade that respells any of them drives both counts to zero on the
   * stand-in *and* on the real map — `0 === 0` reads as `sampled`, both
   * signatures collapse to the same empty string, and the one test written to
   * catch a nearest `DataTexture` passes against nothing. So the shape is
   * asserted before it is compared.
   */
  if (reads.length === 0 || textures === 0) {
    throw new Error(
      `textureSignature: matched ${reads.length} reads and ${textures} bindings — the patterns no longer describe this WGSL, so any comparison built on them is vacuous`,
    )
  }
  /*
   * The binding count is part of the signature, not waved away. The builder
   * shares one binding between two nodes holding the same texture object, so
   * a material whose stand-ins reuse one white pixel warms a layout with
   * fewer bindings than the one a body with distinct maps needs — and a
   * pipeline is keyed on its bind group layout, so that is a second pipeline
   * built on the frame it was warmed to avoid. Every stand-in gets its own
   * object for this reason; `RING_WHITE` in `planet.ts` is the one that had
   * to be split out.
   */
  return `${textures} bound, ${cubes} cube, ${samplers === textures + cubes ? 'sampled' : 'unsampled'}: ${reads.join(' ')}`
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
   * on the strength of a 1×1 stand-in, and the program is built the first time
   * the object is compiled — which is the build-ahead in `Bodies.tsx`, against
   * the live camera and scene, before `setTextures` has ever run.
   *
   * **The program is then frozen, and the real map is bound into it.** A TSL
   * `texture()` node's value swap changes the binding and nothing else: no
   * cache key observes it, so no WGSL is rebuilt. Measured on the device — a
   * node built over a nearest 1×1 compiles `textureLoad` with no sampler, and
   * after assigning a linear map the fragment shader is byte-identical. So a
   * stand-in left at `DataTexture`'s nearest default is not a warm-up that
   * misses; it is the filtering every mapped body then draws its 8K albedo
   * with — mip 0, point sampled, no anisotropy. The ground's version has no
   * `textureLoad` path at all: its gradient sample names a sampler that was
   * never declared, Tint refuses the module, and the frame is black.
   *
   * Holding the two programs to one signature is what keeps the stand-in
   * honest, whichever of the two consequences a given material has.
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
        color: { r: 0.3, g: 0.5, b: 0.9 },
        limb: { r: 1, g: 0.5, b: 0.2 },
        thickness: 1,
        aerosolAngstrom: 1.3,
        ozone: 300,
      },
      1.02,
      { rayleigh: 0.0013, aerosol: 0.0002 },
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
    /*
     * And a bake, which is two cube records. The stand-in program has to
     * declare two `texture_cube` bindings for the two the bake binds: a node
     * hashes its uniform on the texture's uuid, so two nodes over one
     * stand-in cube compile to one binding, and the relief node's later
     * swap binds nothing — the sphere then reads its sea mask out of the
     * reflectance, which is Enceladus as a dark disk under a sun-glint.
     */
    real.setBake({
      albedo: filledCube(0.8, 0.8, 0.8).texture,
      relief: filledCube(0.5, 0.5, 0).texture,
    })
    const a = new Mesh(new SphereGeometry(1, 8, 8), standIn.material)
    const b = new Mesh(new SphereGeometry(1, 8, 8), real.material)
    const withStandIn = await gpu.shader(a, camera, staged(a))
    const withMaps = await gpu.shader(b, camera, staged(b))
    expect(textureSignature(withStandIn.fragmentShader)).toBe(
      textureSignature(withMaps.fragmentShader),
    )
  })

  /*
   * The other two `setTexture` materials. Both bind `planet.ts`'s `WHITE`
   * until a map arrives, and both are on the boot warm-up's list, so both
   * freeze whatever program their stand-in compiled. The rings are the case
   * with a live way back in: `proceduralRings` generates its strip, and a
   * generated strip is a texture somebody can decide should be nearest.
   */
  it('the clouds', async () => {
    const standIn = createCloudMaterial()
    const real = createCloudMaterial()
    real.setTexture(linearPixel())
    const a = new Mesh(new SphereGeometry(1, 8, 8), standIn.material)
    const b = new Mesh(new SphereGeometry(1, 8, 8), real.material)
    const withStandIn = await gpu.shader(a, camera, staged(a))
    const withMap = await gpu.shader(b, camera, staged(b))
    expect(textureSignature(withStandIn.fragmentShader)).toBe(
      textureSignature(withMap.fragmentShader),
    )
  })

  it('the rings', async () => {
    const standIn = createRingMaterial()
    const real = createRingMaterial()
    real.setTexture(linearPixel())
    const a = new Mesh(new RingGeometry(0.5, 1, 32), standIn.material)
    const b = new Mesh(new RingGeometry(0.5, 1, 32), real.material)
    const withStandIn = await gpu.shader(a, camera, staged(a))
    const withMap = await gpu.shader(b, camera, staged(b))
    expect(textureSignature(withStandIn.fragmentShader)).toBe(
      textureSignature(withMap.fragmentShader),
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

  it('the ground reads all six of its morph attributes in the vertex stage', async () => {
    const ground = patchMesh(createTerrainMaterial().material)
    const { vertexShader } = await gpu.shader(ground, camera, staged(ground))
    for (const name of [
      'terrainMorph',
      'terrainMorphNormal',
      ...COVER_ATTRIBUTES,
      ...MORPH_COVER_ATTRIBUTES,
    ]) {
      // Word-bounded, because `terrainMorph` is a prefix of two of the others:
      // a plain `toContain` for it is satisfied by `terrainMorphNormal`, so
      // dropping the morph position — the read whose absence cracks every LOD
      // switch — would leave this green.
      expect(vertexShader).toMatch(new RegExp(`\\b${name}\\b`))
    }
  })
})

/** A sheet over the same nine-by-nine patch, at a datum the ground crosses. */
function sheetMesh(material: Mesh['material']): Mesh {
  const resolution = 9
  const border = 2
  const stride = resolution + 2 * border
  const elevations = new Float32Array(stride * stride)
  for (let i = 0; i < elevations.length; i += 1) elevations[i] = (i % 7) - 3
  const patch = buildPatch({
    region: regionAddress(0, 0, 0, 0),
    resolution,
    border,
    elevations,
    cover: new Uint8Array(resolution * resolution * COVER_CHANNELS),
    bodyRadius: 1_737_400,
    seaLevel: 0,
  })
  const sheet = patch.water
  if (sheet === null) throw new Error('the sea reaches this patch')
  const mesh = new Mesh(
    sheetGeometry(sheet, new BufferAttribute(patch.indices, 1)),
    material,
  )
  wearSea(mesh, patch.anchor)
  placeEye(mesh, { x: 0, y: 0, z: 0 }, 1, 2, 0)
  return mesh
}

describe('the sea', () => {
  /*
   * Both materials the sea lever selects: the one that reads the frame and
   * its depth, and the one built without. Compiled here; drawn — the frame
   * copy, the split and the search — in `seaReflection.gpu.test.ts`, which
   * draws them the way the scene pass does.
   */
  it.each(['full', 'plain'] as const)(
    'the %s sea compiles over a sheet, and reads the depth and the morph in the vertex stage',
    async (detail) => {
      const water = createWaterMaterial()
      water.setQuality({ frame: detail === 'full', waveOctaves: 2 })
      const sea = sheetMesh(water.material)
      const scene = staged(sea)
      gpu.warnings()
      await gpu.compile(sea, camera, scene)
      const missing = gpu
        .warnings()
        .filter((entry) => /not found on geometry/.test(entry.message))
      expect(missing).toEqual([])
      const { vertexShader } = await gpu.shader(sea, camera, scene)
      for (const name of ['terrainMorph', 'waterDepth', 'waterMorphDepth']) {
        expect(vertexShader).toMatch(new RegExp(`\\b${name}\\b`))
      }
    },
  )
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
    // Word-bounded for the same reason as the vertex-stage assertion above:
    // a warning naming only `terrainMorphNormal` contains `terrainMorph`.
    expect(missing.some((message) => /\bterrainMorph\b/.test(message))).toBe(
      true,
    )
  })
})

describe('the orbital bake', () => {
  /*
   * Bake mode 2 is the sphere's normal-map record, and the record is right
   * only if it is written in the frame `render/planet.ts` reads it in. A
   * one-triangle ground wearer with a known tilted normal, anchored a
   * million meters up +Z so the radial there is +Z to a part in a million:
   * north is then +Y, east is +X, and RG have to come back as the normal's
   * own x and y with B the sea mask. Drawn through the production graph and
   * read from a float target, because a scalar mirror of the frame would
   * pass while the graph drifted — which is the failure the terrain-normals
   * test is remembered for.
   *
   * The anchor's altitude is what puts the triangle above or below the
   * body's own sea, through the same `altitude` the deposits read, so the
   * gate is exercised rather than assumed.
   */
  let session: Session
  let wet: Body

  /*
   * The nearest generated world with a sea — searched for rather than named,
   * because which star gets one is a property of the seed and the zoo is
   * chosen by archetype, so none of its four members happens to draw one.
   */
  beforeAll(() => {
    session = openSession({ seed: 'inertialref', workers: null })
    for (const near of session.harness.systemsNearby(25)) {
      // Through `parseAddress` rather than a cast: the harness reports an id
      // as a plain string and `loadSystem` takes a branded one, and the
      // parser is the only thing that may brand it.
      const parsed = parseAddress(`g:milky-way/s:${near.id}`)
      if (parsed.kind !== 'system') continue
      const system = session.world.loadSystem(parsed.system)
      const found = [...walkBodies(system)].find(
        (body) =>
          body.surface.maxElevation > 0 &&
          terrainPalette(body).seaLevel !== null,
      )
      if (found !== undefined) {
        wet = found
        return
      }
    }
    throw new Error(
      'no ocean world within 25 light years; the bake test needs one',
    )
  })

  afterAll(() => {
    session.dispose()
  })

  const TILT = { x: 0.3, y: -0.2, z: 1 }
  const RADIUS = 1_000_000
  /** The dummy triangle's centroid, projected through `camera` onto 64×64. */
  const CENTROID = { x: 36, y: 27 }

  /** A ground wearer in bake mode 2, its normals tilted, at `altitude` over the datum. */
  async function bakeRecord(
    altitude: number,
  ): Promise<[number, number, number, number]> {
    const terrain = createTerrainMaterial()
    terrain.setPalette(terrainPalette(wet), RADIUS)
    terrain.setBakeMode(2)
    const dummy = groundDummy(terrain.material)
    const length = Math.hypot(TILT.x, TILT.y, TILT.z)
    const normal = dummy.geometry.getAttribute('normal') as BufferAttribute
    for (let i = 0; i < 3; i += 1) {
      normal.setXYZ(i, TILT.x / length, TILT.y / length, TILT.z / length)
    }
    anchorGround(dummy, { x: 0, y: 0, z: RADIUS + altitude }, RADIUS)
    const pixels = await gpu.draw(staged(dummy), camera, {
      float: true,
      width: 64,
      height: 64,
    })
    return pixels.at(CENTROID.x, CENTROID.y)
  }

  it('writes the mesh normal along east and north, and no sea, on dry ground', async () => {
    const sea = terrainPalette(wet).seaLevel as number
    const [east, north, mask] = await bakeRecord(sea + 100)
    const length = Math.hypot(TILT.x, TILT.y, TILT.z)
    // The archive's `x / 2 + 1/2`, which is also why the tilt has a
    // downhill component: a signed channel reads back as zero.
    expect(east).toBeCloseTo(0.5 + TILT.x / length / 2, 3)
    expect(north).toBeCloseTo(0.5 + TILT.y / length / 2, 3)
    expect(mask).toBeCloseTo(0, 4)
  })

  it('flattens the slope and raises the mask under the sea', async () => {
    const sea = terrainPalette(wet).seaLevel as number
    const [east, north, mask] = await bakeRecord(sea - 10)
    expect(east).toBeCloseTo(0.5, 4)
    expect(north).toBeCloseTo(0.5, 4)
    expect(mask).toBeCloseTo(1, 4)
  })
})

/**
 * A cube target whose six faces hold one color, the way a bake's arrive:
 * the same type and filtering the baker builds, cleared rather than drawn.
 */
function filledCube(
  red: number,
  green: number,
  blue: number,
): CubeRenderTarget {
  const target = new CubeRenderTarget(4, {
    type: HalfFloatType,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    generateMipmaps: false,
  })
  const { renderer } = gpu
  const held = renderer.getRenderTarget()
  // The getter wants three's `Color4`, which `three/webgpu` does not export;
  // a `Color` carrying an alpha is the shape, and `copy` fills the three lanes.
  const heldColor = renderer.getClearColor(
    Object.assign(new Color(), { a: 1 }) as unknown as Parameters<
      typeof renderer.getClearColor
    >[0],
  )
  const heldAlpha = renderer.getClearAlpha()
  renderer.setClearColor(new Color(red, green, blue), 1)
  for (let face = 0; face < 6; face += 1) {
    renderer.setRenderTarget(target, face)
    renderer.clear()
  }
  renderer.setRenderTarget(held)
  renderer.setClearColor(heldColor, heldAlpha)
  return target
}

describe('the sphere wearing a bake', () => {
  /*
   * The two records are read through two bindings, and the picture says so.
   *
   * Drawn rather than inferred from the WGSL: the signature test above holds
   * the binding count, and this holds what the count is for. A sphere facing
   * both the camera and the star, at its center, is its reflectance times
   * one — every photometric term is unity there — so a bake of 0.8 with a
   * relief record saying dry ground and no slope draws 0.8. Read through the
   * reflectance instead, the record says a slope of 0.6 and a sea mask of
   * 0.8: the normal tilts off the star, the albedo goes to the ocean color,
   * and the center is the sun-glint.
   */
  async function center(
    relief: readonly [number, number, number],
  ): Promise<[number, number, number, number]> {
    const planet = createPlanetMaterial()
    planet.reliefScale.value = 2.2
    planet.sunDirection.value.set(0, 0, 1)
    const mesh = new Mesh(new SphereGeometry(1, 32, 24), planet.material)
    const scene = staged(mesh)
    /*
     * In the boot's order: the program is compiled over the stand-ins first
     * and the bake is bound into it afterward. Bound before the compile,
     * two distinct cubes get two bindings whatever the stand-ins share, and
     * the draw passes over the defect it exists to hold. The target is held
     * still across both draws for the same reason — a pipeline is keyed on
     * its attachment, so a fresh target per draw is a fresh program, built
     * over the bake rather than frozen before it.
     */
    const into = new RenderTarget(64, 64, {
      depthBuffer: false,
      type: FloatType,
    })
    try {
      await gpu.draw(scene, camera, { into })
      planet.setBake({
        albedo: filledCube(0.8, 0.8, 0.8).texture,
        relief: filledCube(...relief).texture,
      })
      const pixels = await gpu.draw(scene, camera, { into })
      return pixels.at(32, 32)
    } finally {
      into.dispose()
    }
  }

  it('draws the reflectance where the relief record says dry ground', async () => {
    const [red, green, blue] = await center([0.5, 0.5, 0])
    expect(red).toBeCloseTo(0.8, 2)
    expect(green).toBeCloseTo(0.8, 2)
    expect(blue).toBeCloseTo(0.8, 2)
  })

  it('draws the sea where the relief record says so, and nothing else moved', async () => {
    const [dryRed] = await center([0.5, 0.5, 0])
    const [red, , blue] = await center([0.5, 0.5, 1])
    // The ocean color is a deep blue: darker than the ice, and bluer.
    expect(red).toBeLessThan(dryRed * 0.6)
    expect(blue).toBeGreaterThan(red)
  })
})

describe('a magma sea, on the ground and from orbit', () => {
  /*
   * The ground and the sphere are one body and a descent crosses the
   * eight-pixel gate between them, so the liquid's glow has to come out the
   * same on both sides of it. The sheet emits the glow over the sea; the
   * sphere emits it where its bake's sea mask says sea. Drawn on the night
   * side, where nothing else lights either surface, both should be the glow
   * and nothing else — and a sphere taking only the liquid's color, which is
   * what it did, is black there.
   */
  let session: Session
  let palette: ReturnType<typeof terrainPalette>
  const magma = liquidAppearance('magma', rng(rootSeed('a lava sea')))!

  beforeAll(() => {
    session = openSession({ seed: 'inertialref', workers: null })
    // An airless body's palette with a magma liquid in it: no veil, no sky,
    // so the night side holds the glow alone.
    const luna = [...walkBodies(session.world.loadSystem(SOL))].find(
      (body) => body.name === 'Luna',
    )!
    palette = { ...terrainPalette(luna), liquid: magma }
  })

  afterAll(() => {
    session.dispose()
  })

  /** The sheet over fifty meters of magma, read at its centroid. */
  async function sheet(): Promise<[number, number, number, number]> {
    // The plain sea: the sheet's own color and glow, with no frame behind it.
    const water = createWaterMaterial()
    water.setQuality({ ...DEFAULT_WATER_QUALITY, frame: false })
    // Luna's radius, which only sets the air's unit; Luna has none.
    water.setPalette(palette, 1_737_400)
    water.sunDirection.value.set(0, 0, -1)
    const mesh = seaDummy(water.material)
    for (const name of ['waterDepth', 'waterMorphDepth']) {
      const depth = mesh.geometry.getAttribute(name) as BufferAttribute
      for (let i = 0; i < depth.count; i += 1) depth.setX(i, 50)
    }
    const pixels = await gpu.draw(staged(mesh), camera, {
      float: true,
      width: 64,
      height: 64,
    })
    // The dummy triangle's centroid on 64×64, as the bake record reads it.
    return pixels.at(36, 27)
  }

  /** The sphere wearing a bake whose relief record is `relief`, read at its center. */
  async function sphere(
    relief: readonly [number, number, number],
  ): Promise<[number, number, number, number]> {
    const planet = createPlanetMaterial()
    planet.sunDirection.value.set(0, 0, -1)
    const mesh = new Mesh(new SphereGeometry(1, 32, 24), planet.material)
    const scene = staged(mesh)
    // Compiled over the stand-ins first and bound after, in the boot's
    // order — see `center` above.
    const into = new RenderTarget(64, 64, {
      depthBuffer: false,
      type: FloatType,
    })
    try {
      await gpu.draw(scene, camera, { into })
      planet.setBake({
        albedo: filledCube(0.1, 0.05, 0.03).texture,
        relief: filledCube(...relief).texture,
      })
      planet.oceanColor.value.setRGB(
        magma.color.r,
        magma.color.g,
        magma.color.b,
      )
      planet.liquidGlow.value.setRGB(magma.glow.r, magma.glow.g, magma.glow.b)
      const pixels = await gpu.draw(scene, camera, { into })
      return pixels.at(32, 32)
    } finally {
      into.dispose()
    }
  }

  it('glows on the night side of the sphere as it does on the sheet', async () => {
    const ground = await sheet()
    const orbit = await sphere([0.5, 0.5, 1])
    const glow = [magma.glow.r, magma.glow.g, magma.glow.b]
    for (let channel = 0; channel < 3; channel += 1) {
      // Both are the glow: the sheet's wave field and foam are faded out at
      // fifty meters of depth and no sun, and the sphere's night is black.
      expect(ground[channel]).toBeCloseTo(glow[channel] as number, 3)
      expect(orbit[channel]).toBeCloseTo(ground[channel] as number, 3)
    }
  })

  it('and nowhere the relief record says dry ground', async () => {
    const [red, green, blue] = await sphere([0.5, 0.5, 0])
    expect(Math.max(red, green, blue)).toBeLessThan(1e-4)
  })
})

describe('the disk, seen through its own air', () => {
  const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')!
  const haze = earth.haze!
  /** Earth's tables over the datum, as `Bodies` bakes them. */
  const tables = () =>
    scatteringFor(haze, 1 + haze.height / earth.radius, {
      rayleigh: earth.atmosphere!.scaleHeight / earth.radius,
      aerosol: haze.aerosolHeight / earth.radius,
    })

  /**
   * The luminance at the center of a black disk seen at nadir from four
   * radii out, under a sun behind the eye: whatever is drawn is the air's
   * own light. `mesh` is the drawn sphere's radius in sea-level units — 1 on
   * the datum, under it as the renderer sinks it. `albedo` grays the disk,
   * so the surface's own light is drawn under the air's.
   */
  async function veil(
    air: boolean,
    mesh = 1,
    lift = 0,
    albedo = 0,
  ): Promise<number> {
    const planet = createPlanetMaterial()
    planet.baseColor.value.setRGB(albedo, albedo, albedo)
    planet.sunDirection.value.set(0, 0, 1)
    planet.seaLevel.value = 1
    if (air) {
      const baked = tables()
      planet.air.set(baked.recipe, baked.transmittance, baked.multiScatter)
      planet.air.lift(
        lift,
        LIMB_STRETCH * (earth.atmosphere!.scaleHeight / earth.radius),
      )
    }
    const disk = new Mesh(new SphereGeometry(mesh, 48, 32), planet.material)
    const eye = new PerspectiveCamera(10, 1, 0.1, 100)
    eye.position.set(0, 0, 4)
    eye.updateMatrixWorld()
    const pixels = await gpu.draw(staged(disk), eye, {
      width: 8,
      height: 8,
      float: true,
    })
    planet.material.dispose()
    const [red, green, blue] = pixels.at(4, 4)
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
  }

  it('draws the air over a black surface, and nothing over a vacuum', async () => {
    // The march is a `Loop`, and a `Loop` built outside a `Fn` is never
    // emitted: the program compiles, logs nothing, and draws the disk through
    // a vacuum. Earth's column at nadir under a high sun scatters a few
    // percent of the surface white back at the eye; a vacuum scatters none.
    expect(await veil(true)).toBeGreaterThan(0.01)
    expect(await veil(false)).toBeLessThan(1e-6)
  })

  it("keeps Enhanced's limb off the disk: the sphere takes the physics' light alone", async () => {
    // The lifted gas is the same column as the physics, so composed in front
    // of the disk it is a second nadir veil — measured 0.089 against the
    // physics' 0.053 — and the blue of it tints a Blue Marble's Sahara
    // magenta. The ring is the shell's, past the silhouette. Under Enhanced
    // from outside the air the disk's veil is the physics', lit by the beam
    // cleared halfway: 0.0546 against 0.0525 at nadir, where the ring
    // composed over it drew 0.089.
    const pre = 1 / 30_000
    setSceneExposure(gpu.renderer, pre, pre, 'enhanced')
    let lifted: number
    let physical: number
    try {
      lifted = await veil(true, 1, 1)
      physical = await veil(true, 1, 0)
    } finally {
      setSceneExposure(gpu.renderer, null)
    }
    expect(physical).toBeGreaterThan(0.01)
    expect(Math.abs(lifted / physical - 1)).toBeLessThan(0.1)
  })

  it('draws a surface from orbit at its own light under Enhanced, and through the measured air otherwise', async () => {
    // From orbit the measured air dims a surface twice, on the sun's way
    // down and the eye's way out: a gray disk at nadir under a high sun draws
    // 0.34 through it against 0.50 bare, less the 0.053 of veil. Under
    // Enhanced from outside the air the surface takes none of that
    // extinction and keeps the air's light over it — bare plus veil, 0.5548
    // against 0.5001 and 0.0546 — and under a photographic lens the lift
    // changes nothing.
    const pre = 1 / 30_000
    const measure = async (mode: 'enhanced' | 'photographic') => {
      setSceneExposure(gpu.renderer, pre, pre, mode)
      try {
        return {
          lifted: await veil(true, 1, 1, 0.5),
          physical: await veil(true, 1, 0, 0.5),
          bare: await veil(false, 1, 0, 0.5),
          airlight: await veil(true, 1, 1),
        }
      } finally {
        setSceneExposure(gpu.renderer, null)
      }
    }
    const enhanced = await measure('enhanced')
    expect(enhanced.lifted).toBeCloseTo(enhanced.bare + enhanced.airlight, 3)
    expect(enhanced.physical).toBeLessThan(0.75 * enhanced.lifted)
    const photographic = await measure('photographic')
    expect(photographic.lifted).toBeCloseTo(photographic.physical, 6)
  })

  it('keeps a beam under the floor as dim as it is, and halves the reddening of its hue alone', async () => {
    // Enhanced clears a surface's beam from orbit toward its hue: the slant
    // over the column overhead, over its brightest channel, its reddening
    // halved as a power. A beam under `ORBIT_BEAM_FLOOR` of the overhead
    // light is divided by the floor and keeps that dimming, or the air over
    // the night side beside a crescent lights orange. Taken inside the power
    // too, the dimming is its own square root: grazing the ground at a 1.1°
    // sun the red slant is 0.0047 of overhead, which over the floor is
    // 0.016, and drawn at 0.125. Red is the brightest channel at both suns
    // here, so it reads the kept dimming alone.
    const baked = tables()
    const air = createAirUniforms()
    air.set(baked.recipe, baked.transmittance, baked.multiScatter)
    air.lift(1, LIMB_STRETCH * (earth.atmosphere!.scaleHeight / earth.radius))
    const pre = 1 / 30_000
    const read = async (mu: number) => {
      const beam = sunThrough(
        air,
        vec3(1, 0, 0),
        vec3(mu, Math.sqrt(1 - mu * mu), 0),
      )
      const slant = sunTableAt(air, float(mu), float(0)).x.div(
        sunTableAt(air, float(1), float(0)).x,
      )
      setSceneExposure(gpu.renderer, pre, pre, 'enhanced')
      try {
        const pixels = await gpu.drawGraph(vec4(beam.x, slant, 0, 1), {
          width: 1,
          height: 1,
          float: true,
        })
        const [red, ratio] = pixels.at(0, 0)
        return { red: red!, slant: ratio! }
      } finally {
        setSceneExposure(gpu.renderer, null)
      }
    }
    const grazing = await read(0.02)
    expect(grazing.slant).toBeLessThan(ORBIT_BEAM_FLOOR / 2)
    expect(grazing.red).toBeCloseTo(grazing.slant / ORBIT_BEAM_FLOOR, 3)
    const high = await read(0.5)
    expect(high.slant).toBeGreaterThan(ORBIT_BEAM_FLOOR)
    expect(high.red).toBeCloseTo(1, 3)
  })

  it('marches to the datum, not to the sunk sphere under it', async () => {
    // The mesh is sunk under the datum, 9.9 km on Earth and a tenth of a
    // radius at a flattened giant's pole, and the march holds everything
    // under sea level at sea-level density — so a path marched to the mesh
    // crossed that depth as air and the nadir veil doubled. Drawn on the
    // datum and drawn a tenth of a radius under it, the disk is the same air.
    const datum = await veil(true, 1)
    const sunk = await veil(true, 0.9)
    expect(Math.abs(sunk / datum - 1)).toBeLessThan(0.02)
  })
})

describe('the materials drawn over the clouds, read through a front handle', () => {
  /*
   * Under `?clouds=1` the ring, the plumes and the entry trace's inks read
   * the clouds in front of them (design §4.9), and without a handle each
   * builds the program it always has. The handle's cost is the two knot
   * textures and the two samplers three declares beside them, though the
   * reads are `textureLoad` and use neither sampler: `cloudFront`'s nodes
   * are over the trace's own storage textures, which are not nearest
   * filtered, and the composite binds the same pair. That is what is
   * counted here, program by program, against the same material built with
   * no handle. Each is built before the handle follows a
   * trace, so it compiles against the handle's stand-ins, as the page does.
   */
  const knotBindings = async (
    without: Object3D,
    within: Object3D,
  ): Promise<void> => {
    const bare = await gpu.shader(without, camera, staged(without))
    await gpu.compile(within, camera, staged(within))
    const read = await gpu.shader(within, camera, staged(within))
    const count = (wgsl: string) =>
      (wgsl.match(/texture_2d\s*<\s*f32\s*>/g) ?? []).length
    const samplers = (wgsl: string) =>
      (wgsl.match(/:\s*sampler\s*;/g) ?? []).length
    expect(count(read.fragmentShader) - count(bare.fragmentShader)).toBe(2)
    expect(samplers(read.fragmentShader) - samplers(bare.fragmentShader)).toBe(
      2,
    )
    expect(read.fragmentShader).toContain('textureLoad')
    // The vertex stage reads no cloud.
    expect(count(read.vertexShader)).toBe(count(bare.vertexShader))
  }

  it('the ring', async () => {
    const ring = () => new RingGeometry(0.5, 1, 32)
    await knotBindings(
      new Mesh(ring(), createRingMaterial().material),
      new Mesh(ring(), createRingMaterial(createCloudFrontHandle()).material),
    )
  })

  it('the plumes: the jets, the pods, the drive and its disk', async () => {
    const lit = (front?: ReturnType<typeof createCloudFrontHandle>) => {
      const plumes = createThrusterPlumes(thrusterLayoutFor('rocinante'), front)
      plumes.update(new Float32Array(plumes.nozzleCount).fill(1), 1, 1)
      return plumes
    }
    const bare = lit()
    const read = lit(createCloudFrontHandle())
    expect(read.group.children.length).toBe(bare.group.children.length)
    expect(bare.group.children.length).toBe(4)
    for (let i = 0; i < bare.group.children.length; i += 1)
      await knotBindings(bare.group.children[i]!, read.group.children[i]!)
    bare.dispose()
    read.dispose()
  })

  it('the entry trace: its inks and the line through the body', async () => {
    const bare = createEntryTraceMaterials()
    const read = createEntryTraceMaterials({
      handle: createCloudFrontHandle(),
      compression: uniform(1),
    })
    const geometry = new LineSegmentsGeometry().setPositions([
      -0.5, 0, 0, 0.5, 0, 0,
    ])
    const through = new BufferGeometry()
    through.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0]), 3),
    )
    for (const key of Object.keys(bare) as (keyof typeof bare)[]) {
      const part = (material: (typeof bare)[typeof key]) =>
        key === 'through'
          ? new LineSegments(through, material)
          : new LineSegments2(geometry, material as typeof bare.ring)
      await knotBindings(part(bare[key]), part(read[key]))
    }
    geometry.dispose()
    through.dispose()
    for (const material of [...Object.values(bare), ...Object.values(read)])
      material.dispose()
  })
})
