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
import { PerspectiveCamera, Scene } from 'three/webgpu'
import { cubeTexture, vec3 } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { groundDummy } from './groundWear.ts'
import { createOrbitalBaker } from './orbitalBake.ts'
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
  })
  const dummy = groundDummy(terrain.material)
  const scene = new Scene()
  scene.add(dummy)
  const camera = new PerspectiveCamera()
  const deliver = async () => {
    for (const finish of pending.splice(0)) finish()
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
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
