import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BufferAttribute,
  type Camera,
  Color,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  RenderTarget,
  RGBAFormat,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  WebGLCubeRenderTarget,
} from 'three/webgpu'
import { openSession, type Session } from '@inertialref/devtools'
import { buildPatch, terrainPalette } from '@inertialref/rendering'
import {
  type Body,
  COVER_CHANNELS,
  parseAddress,
  regionAddress,
  walkBodies,
} from '@inertialref/universe'
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
import { createWaterMaterial } from './water.ts'
import {
  anchorGround,
  COVER_ATTRIBUTES,
  groundDummy,
  MORPH_COVER_ATTRIBUTES,
  patchGeometry,
  placeEye,
  sheetGeometry,
  wearGround,
  wearSea,
} from './groundWear.ts'
import { createThrusterPlumes } from './plumes.ts'
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
  placeEye(mesh, { x: 0, y: 0, z: 0 }, 1, 2)
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
  placeEye(mesh, { x: 0, y: 0, z: 0 }, 1, 2)
  return mesh
}

describe('the sea', () => {
  it('compiles over a sheet, and reads the depth and the morph in the vertex stage', async () => {
    /*
     * Built without the frame read. `viewportSharedTexture` copies the
     * framebuffer before the first sheet of a frame is drawn — ending the
     * render pass and beginning it again — and the harness has neither a swap
     * chain to copy nor a pass that survives being re-begun around its single
     * draw, so the production graph cannot be drawn here. What can is
     * everything else in it: the sheet's own attributes, the morph, the
     * waves, the Fresnel split. The copy is exercised where it runs, in the
     * browser, and `WaterBuild` says why the option exists.
     */
    const sea = sheetMesh(createWaterMaterial({ refraction: false }).material)
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
 * A cube target whose six faces hold one colour, the way a bake's arrive:
 * the same type and filtering the baker builds, cleared rather than drawn.
 */
function filledCube(
  red: number,
  green: number,
  blue: number,
): WebGLCubeRenderTarget {
  const target = new WebGLCubeRenderTarget(4, {
    type: HalfFloatType,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    generateMipmaps: false,
  })
  const { renderer } = gpu
  const held = renderer.getRenderTarget()
  // The getter wants three's `Color4`, which `three/webgpu` does not export;
  // a `Color` carrying an alpha is the shape, and `copy` fills the three lanes.
  const heldColour = renderer.getClearColor(
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
  renderer.setClearColor(heldColour, heldAlpha)
  return target
}

describe('the sphere wearing a bake', () => {
  /*
   * The two records are read through two bindings, and the picture says so.
   *
   * Drawn rather than inferred from the WGSL: the signature test above holds
   * the binding count, and this holds what the count is for. A sphere facing
   * both the camera and the star, at its centre, is its reflectance times
   * one — every photometric term is unity there — so a bake of 0.8 with a
   * relief record saying dry ground and no slope draws 0.8. Read through the
   * reflectance instead, the record says a slope of 0.6 and a sea mask of
   * 0.8: the normal tilts off the star, the albedo goes to the ocean colour,
   * and the centre is the sun-glint.
   */
  async function centre(
    relief: readonly [number, number, number],
  ): Promise<[number, number, number, number]> {
    const planet = createPlanetMaterial()
    planet.reliefScale.value = 2.2
    planet.sunDirection.value.set(0, 0, 1)
    const mesh = new Mesh(new SphereGeometry(1, 32, 24), planet.material)
    const scene = staged(mesh)
    /*
     * In the boot's order: the program is compiled over the stand-ins first
     * and the bake is bound into it afterwards. Bound before the compile,
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
    const [red, green, blue] = await centre([0.5, 0.5, 0])
    expect(red).toBeCloseTo(0.8, 2)
    expect(green).toBeCloseTo(0.8, 2)
    expect(blue).toBeCloseTo(0.8, 2)
  })

  it('draws the sea where the relief record says so, and nothing else moved', async () => {
    const [dryRed] = await centre([0.5, 0.5, 0])
    const [red, , blue] = await centre([0.5, 0.5, 1])
    // The ocean colour is a deep blue: darker than the ice, and bluer.
    expect(red).toBeLessThan(dryRed * 0.6)
    expect(blue).toBeGreaterThan(red)
  })
})
