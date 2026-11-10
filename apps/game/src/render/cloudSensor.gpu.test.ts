import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type Camera,
  Mesh,
  MeshBasicNodeMaterial,
  QuadMesh,
  type Scene,
  SphereGeometry,
  type WebGPURenderer,
} from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { markOverClouds, OVER_CLOUDS_LAYER } from './cloudLayers.ts'
import { DEFAULT_CLOUD_LEVERS, type CloudLevers } from './cloudLevers.ts'
import { type CloudRig, cloudRig } from './cloudSystemRig.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import { sensorRadiance } from './radiance.ts'
import { sceneBackend, sceneLayout } from './sceneLayout.ts'
import { warmCompile, warmRenderer } from './warmup.ts'

/*
 * Off by default, at the sensor (§4.7). Without the flag the chain holds
 * nothing of the clouds: no system, no report, no object in the scene, no
 * layer on the camera. With it and the levers off, a frame is the frame
 * without it —
 * the pixels bit for bit, the draw calls, the passes on the timeline — and
 * the post program carries one more `+ 0` term and not one more binding.
 * With the levers on, the scene is drawn in two passes, under the clouds and
 * over them, and an overlay marked over the clouds and warmed at boot draws
 * in the second with no pipeline built.
 */

const WIDTH = 64
const HEIGHT = 48
const TIMESTAMPS = await adapterOffers('timestamp-query')
const OPTIONS = { ceiling: 50, levers: { scenario: 'overcast' } } as const

let gpu: GpuSession
let bare: CloudRig
let flagged: CloudRig

beforeAll(async () => {
  gpu = await openGpu(WIDTH, HEIGHT)
  bare = cloudRig(gpu, WIDTH, HEIGHT, { ...OPTIONS, clouds: false })
  flagged = cloudRig(gpu, WIDTH, HEIGHT, OPTIONS)
  await bare.sensor.warm()
  await flagged.sensor.warm()
  await flagged.system!.warm()
}, 180_000)

afterAll(() => {
  bare?.dispose()
  flagged?.dispose()
  gpu?.dispose()
})

const bits = (data: Float32Array | Uint8Array): Uint32Array =>
  new Uint32Array(data.buffer.slice(0))

/** The sampled and storage textures a WGSL program declares. */
const bindings = (wgsl: string): number =>
  [...wgsl.matchAll(/var\s+\w+\s*:\s*texture_\w+/g)].length

describe('without the flag', () => {
  it('builds nothing of the clouds: no system, no report, no object, no layer', () => {
    expect(bare.system).toBeNull()
    expect(bare.sensor.clouds).toBeNull()
    expect(bare.sensor.diagnostics.clouds).toBeNull()
    expect(
      bare.scene.children.filter((child) => child.name === 'cloud composite'),
    ).toEqual([])
    expect(bare.camera.layers.isEnabled(OVER_CLOUDS_LAYER)).toBe(false)
  })
})

describe('with the flag and the levers off', () => {
  it('reports a system that exists and is off, its mesh hidden', () => {
    const report = flagged.sensor.diagnostics.clouds!
    expect(report.available).toBe(true)
    expect(report.on).toBe(false)
    expect(report.settle).toBeNull()
    const meshes = flagged.scene.children.filter(
      (child) => child.name === 'cloud composite',
    )
    expect(meshes).toHaveLength(1)
    expect(meshes[0]!.visible).toBe(false)
  })

  it('draws the frame without the flag: the pixels bit for bit, the renders and the draws', async () => {
    // `info.render.drawCalls` is reset by three's own frame loop alone,
    // which the harness stubs, so its difference over a frame is the
    // frame's draws; `info.calls` counts renders, the pass and the quad.
    const frame = async (rig: CloudRig) => {
      const { info } = gpu.renderer
      const renders = info.calls
      const draws = info.render.drawCalls
      rig.frame()
      return {
        renders: info.calls - renders,
        draws: info.render.drawCalls - draws,
        pixels: (await gpu.read(rig.target)).data,
      }
    }
    // Two frames each first, so the pass's history and the meter's first
    // frame are behind both.
    for (let k = 0; k < 2; k += 1) {
      await frame(bare)
      await frame(flagged)
    }
    const off = await frame(bare)
    const on = await frame(flagged)
    expect(on.renders).toBe(off.renders)
    expect(on.draws).toBe(off.draws)
    expect(bits(on.pixels)).toEqual(bits(off.pixels))
  })

  it('builds no pipeline over three frames after the warm-up, as the bare chain builds none', async () => {
    for (const rig of [bare, flagged]) {
      rig.frame()
      await gpu.read(rig.target)
      const render = gpu.pipelinesBuilt()
      const compute = gpu.computePipelinesBuilt()
      for (let k = 0; k < 3; k += 1) rig.frame()
      await gpu.read(rig.target)
      expect(gpu.pipelinesBuilt()).toBe(render)
      expect(gpu.computePipelinesBuilt()).toBe(compute)
    }
  })

  it('adds a term to the post program and not a binding', async () => {
    const postOf = async (rig: CloudRig) => {
      const compile = vi.spyOn(gpu.renderer, 'compileAsync')
      try {
        await rig.sensor.warm()
        const call = compile.mock.calls.find(
          ([object]) =>
            object instanceof QuadMesh &&
            !Array.isArray(object.material) &&
            object.material.name === 'RenderPipeline',
        )
        expect(call).toBeDefined()
        const [quad, camera] = call!
        return gpu.shader(
          quad as QuadMesh,
          camera as Camera,
          rig.scene as Scene,
        )
      } finally {
        compile.mockRestore()
      }
    }
    const off = await postOf(bare)
    const on = await postOf(flagged)
    expect(bindings(on.fragmentShader)).toBe(bindings(off.fragmentShader))
  })

  it.skipIf(!TIMESTAMPS)(
    'times the passes the bare chain times, by name',
    async () => {
      const labels = async (rig: CloudRig) => {
        const stop = installPassTimeline(gpu.renderer as WebGPURenderer)
        try {
          const read = await passTimelineOf(
            gpu.renderer as WebGPURenderer,
          )!.measure(() => rig.frame(), 3)
          expect(read.dropped).toBe(0)
          return read.passes.map((pass) => [pass.label, pass.count])
        } finally {
          stop()
        }
      }
      expect(await labels(flagged)).toEqual(await labels(bare))
    },
  )
})

describe('with the levers on', () => {
  /** An overlay drawn over the clouds, marked and warmed as the scene's own are at boot. */
  async function overlay(rig: CloudRig): Promise<Mesh> {
    const material = sensorRadiance(new MeshBasicNodeMaterial(), true)
    material.colorNode = vec3(0.8, 0.2, 0.1)
    material.transparent = true
    const mesh = new Mesh(new SphereGeometry(5, 8, 6), material)
    mesh.position.set(0, 40, 0)
    markOverClouds(mesh)
    rig.scene.add(mesh)
    rig.scene.updateMatrixWorld(true)
    const layout = sceneLayout(DEFAULT_PICTURE, sceneBackend(gpu.renderer))
    await warmCompile(warmRenderer(gpu.renderer, layout), {
      object: mesh,
      camera: rig.camera,
      scene: rig.scene,
    })
    return mesh
  }

  it('draws a marked overlay with no pipeline its warm-up did not build', async () => {
    const mesh = await overlay(flagged)
    try {
      flagged.levers = {
        ...DEFAULT_CLOUD_LEVERS,
        scenario: 'overcast',
        on: true,
      } satisfies CloudLevers
      // The clouds' own first frames, then the count.
      for (let k = 0; k < 3; k += 1) flagged.frame()
      await gpu.read(flagged.target)
      const render = gpu.pipelinesBuilt()
      const compute = gpu.computePipelinesBuilt()
      for (let k = 0; k < 3; k += 1) flagged.frame()
      await gpu.read(flagged.target)
      expect(gpu.pipelinesBuilt()).toBe(render)
      expect(gpu.computePipelinesBuilt()).toBe(compute)
    } finally {
      flagged.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as MeshBasicNodeMaterial).dispose()
      flagged.levers = { ...flagged.levers, on: false }
    }
  })

  it.skipIf(!TIMESTAMPS)(
    'draws pass B once, after the scene, with the cloud work',
    async () => {
      flagged.levers = {
        ...DEFAULT_CLOUD_LEVERS,
        scenario: 'overcast',
        on: true,
      }
      for (let k = 0; k < 4; k += 1) flagged.frame()
      const stop = installPassTimeline(gpu.renderer as WebGPURenderer)
      let labels: string[]
      try {
        const read = await passTimelineOf(
          gpu.renderer as WebGPURenderer,
        )!.measure(() => flagged.frame(), 3)
        labels = read.passes.map((pass) => pass.label)
      } finally {
        stop()
      }
      const scene = labels.indexOf('scene')
      const over = labels.indexOf('scene over clouds')
      expect(scene).toBeGreaterThanOrEqual(0)
      expect(over).toBeGreaterThan(scene)
      expect(labels.filter((label) => label === 'scene over clouds')).toEqual([
        'scene over clouds',
      ])
      expect(labels).toContain('cloud trace')
      expect(labels).toContain('cloud history')
      flagged.levers = { ...flagged.levers, on: false }
    },
  )
})
