import { afterAll, beforeAll, expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import {
  bodyFrameId,
  COVER_CHANNELS,
  HEIGHTFIELD_BORDER,
  heightfieldStride,
  parseAddress,
  type Body,
} from '@inertialref/universe'
import { Heightfields, type HeightfieldResponse } from '@inertialref/workers'
import {
  CubeCamera,
  CubeRenderTarget,
  DoubleSide,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
} from 'three/webgpu'
import { cubeTexture, normalize, positionWorld, vec3 } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { groundDummy } from './groundWear.ts'
import { createOrbitalBaker, drawCubeFace } from './orbitalBake.ts'
import { createTerrainMaterial } from './terrain.ts'
import { warmCompile } from './warmup.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(16, 16)
})
afterAll(() => gpu?.dispose())

it('draws a ready bake, reuses it, and replaces it when the body at its address changes', async () => {
  const session = openSession({ seed: 'inertialref', workers: null })
  const address = 'g:milky-way/s:SOL/b:2'
  let body: Body = session.world.bodyAt(bodyFrameId(parseAddress(address)))!
  const terrain = createTerrainMaterial()
  const pending: (() => void)[] = []
  let submitted = 0
  const heightfields = new Heightfields({
    kind: 'flat fixture',
    available: true,
    submit(_surface, request) {
      const result = new Promise<HeightfieldResponse>((resolve) => {
        pending.push(() => {
          const border = request.border ?? HEIGHTFIELD_BORDER
          const stride = heightfieldStride({
            resolution: request.resolution,
            border,
          })
          resolve({
            ...request,
            border,
            elevations: new Float32Array(stride * stride),
            cover: new Uint8Array(request.resolution ** 2 * COVER_CHANNELS),
            // Dry is NaN; a zeroed `water` is standing water at the datum.
            water: new Float32Array(request.resolution ** 2).fill(Number.NaN),
            minElevation: 0,
            maxElevation: 0,
          })
        })
      })
      return { id: ++submitted, result, cancel() {} }
    },
  })
  const baker = createOrbitalBaker({
    renderer: gpu.renderer,
    terrain,
    bodyFor: () => body,
    heightfields,
    // No table: the bake draws the slope as drawn.
    slopesFor: () => Promise.resolve(null),
  })
  const dummy = groundDummy(terrain.material)
  const scene = new Scene()
  scene.add(dummy)
  const camera = new PerspectiveCamera()
  // The tiles, then the frames that build and draw them — as many as the
  // build budget takes on this machine, and twelve of one face.
  const deliver = async () => {
    for (const finish of pending.splice(0)) finish()
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    let frames = 0
    while (!baker.report()[0]?.ready && frames < 500) {
      baker.advance()
      frames += 1
    }
    expect(frames).toBeGreaterThanOrEqual(12)
    expect(baker.report()).toEqual([{ address, ready: true, failed: false }])
  }
  try {
    expect(baker.textureFor(address)).toBeNull()
    const first = baker.targetFor(address)!
    gpu.renderer.setRenderTarget(first.albedo)
    await warmCompile(gpu.renderer, { object: dummy, scene, camera })
    gpu.renderer.setRenderTarget(null)
    await deliver()
    const picture = await gpu.drawGraph(
      cubeTexture(first.albedo.texture, vec3(1, 0, 0)),
      { float: true },
    )
    expect(picture.data.every(Number.isFinite)).toBe(true)
    expect(
      picture
        .at(8, 8)
        .slice(0, 3)
        .some((value) => value > 0),
    ).toBe(true)
    /*
     * Every texel of every face is ground. Each face is drawn culled against
     * its own camera, and a patch the culling lost would leave the clear
     * color where its ground was: a hole the sphere wears as a black square.
     * Half float, and a positive half has a nonzero bit pattern, so a texel
     * with all three color lanes zero is one nothing drew.
     */
    for (let face = 0; face < 6; face += 1) {
      const texels = (await gpu.renderer.readRenderTargetPixelsAsync(
        first.albedo,
        0,
        0,
        512,
        512,
        0,
        face,
      )) as Uint16Array
      expect(texels.length).toBe(512 * 512 * 4)
      let holes = 0
      for (let i = 0; i < texels.length; i += 4) {
        if (texels[i] === 0 && texels[i + 1] === 0 && texels[i + 2] === 0)
          holes += 1
      }
      expect(holes).toBe(0)
    }
    const count = submitted
    expect(baker.textureFor(address)?.albedo === first.albedo.texture).toBe(
      true,
    )
    expect(submitted).toBe(count)
    body = { ...body, surface: { ...body.surface } }
    expect(baker.textureFor(address)).toBeNull()
    expect(baker.targetFor(address)?.albedo === first.albedo).toBe(false)
    await deliver()
    expect(baker.textureFor(address)).not.toBeNull()
    expect(submitted).toBe(count * 2)
  } finally {
    baker.dispose()
    dummy.geometry.dispose()
    terrain.material.dispose()
    session.dispose()
  }
})

it('draws a cube face by face into the same six faces `CubeCamera.update` draws', async () => {
  /*
   * The bake draws one face a frame where three's cube camera draws six in
   * one call, so the one-face draw has to aim each of its cameras, in the
   * renderer's coordinate system, exactly as `update` does — a face drawn
   * from the wrong camera is a sphere wearing its ground turned through a
   * right angle. A shell whose color is its own direction tells every face
   * from every other; drawn both ways, the twelve readbacks agree texel for
   * texel.
   */
  const { renderer } = gpu
  const material = new MeshBasicNodeMaterial({ side: DoubleSide })
  material.colorNode = normalize(positionWorld).mul(0.5).add(0.5)
  const scene = new Scene()
  scene.add(new Mesh(new SphereGeometry(1, 32, 16), material))
  // Sixteen float texels are 256 bytes, so a row reads back unpadded.
  const cube = () =>
    new CubeRenderTarget(16, { type: FloatType, generateMipmaps: false })
  const whole = cube()
  const faced = cube()
  try {
    new CubeCamera(0.1, 10, whole).update(renderer, scene)
    const camera = new CubeCamera(0.1, 10, faced)
    for (let face = 0; face < 6; face += 1)
      drawCubeFace(renderer, camera, scene, face)
    const read = async (target: CubeRenderTarget, face: number) =>
      Array.from(
        (await renderer.readRenderTargetPixelsAsync(
          target,
          0,
          0,
          16,
          16,
          0,
          face,
        )) as Float32Array,
      )
    const faces = []
    for (let face = 0; face < 6; face += 1) {
      const reference = await read(whole, face)
      expect(await read(faced, face)).toEqual(reference)
      faces.push(reference)
    }
    // And the faces are six different pictures, so agreeing means something.
    expect(new Set(faces.map((face) => face.join())).size).toBe(6)
  } finally {
    whole.dispose()
    faced.dispose()
    material.dispose()
  }
})
