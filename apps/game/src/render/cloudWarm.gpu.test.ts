import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Mesh, MeshBasicNodeMaterial, SphereGeometry } from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { markOverClouds } from './cloudLayers.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  type CloudRig,
  cloudRig,
  LOOKING_UP,
  RIG_EARTH,
  RIG_TWIN,
} from './cloudSystemRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import { sensorRadiance } from './radiance.ts'
import { sceneBackend, sceneLayout } from './sceneLayout.ts'
import { warmCompile, warmRenderer } from './warmup.ts'

/*
 * Rule 61 for the clouds (§4.5): after the system's warm-up and the
 * sensor's, the first frame of every lever set phase 0's batches draw
 * builds no pipeline, render or compute. Three compiles a compute pipeline
 * synchronously at its first dispatch, so a census of render pipelines
 * alone would pass with every kernel compiling inside the first frame.
 *
 * A miss is named by the label three gives the pipeline it built —
 * `renderPipeline_<material>_<id>`, `computePipeline_compute_<kernel>` —
 * recorded at the device for the frame it happened in.
 *
 * The composite has three forms, and each has a first frame: pass B, pass B
 * through the lean edit, and the composite alone over the scene target's
 * resolved rows, whose pipeline is keyed on that target's shape and so is a
 * second one for the same material. The frame one form gives way to another
 * is a first frame too.
 *
 * Two chains: one over a body alone, and one with a second clouded body in
 * its sky, where the levers that name a body have something to name. A
 * forced served body and a forced second one each take a path a frame with
 * neither does not: another body's far bake, the composite's second march.
 */

const WIDTH = 64
const HEIGHT = 48

let gpu: GpuSession
let rig: CloudRig
let pair: CloudRig
let shared: CloudRig

/** A chain warmed as the boot warms one, its sensor's own first frame behind it. */
async function warmed(chain: CloudRig): Promise<CloudRig> {
  await chain.sensor.warm()
  await chain.system!.warm()
  // The sensor's own first frame, which compiles its meter's kernels.
  chain.frame()
  await gpu.read(chain.target)
  return chain
}

beforeAll(async () => {
  gpu = await openGpu(WIDTH, HEIGHT)
  rig = await warmed(
    cloudRig(gpu, WIDTH, HEIGHT, {
      ceiling: 50,
      levers: { weather: 'overcast' },
    }),
  )
  // The second body straight up, 20,000 km off, as `cloudSecondBody`'s.
  const twin = {
    looking: LOOKING_UP,
    sun: { x: 0.3, y: -0.5, z: 0.8 },
    twin: { distance: 20_000_000, toward: { x: 0, y: 1, z: 0 } },
    levers: { weather: 'fog' },
  } as const
  pair = await warmed(cloudRig(gpu, WIDTH, HEIGHT, twin))
  shared = await warmed(cloudRig(gpu, WIDTH, HEIGHT, { ...twin, air: true }))
}, 180_000)

afterAll(() => {
  rig?.dispose()
  pair?.dispose()
  shared?.dispose()
  gpu?.dispose()
})

/** The labels of the pipelines the device builds while `run` runs. */
function built(run: () => void): string[] {
  const device = (gpu.renderer.backend as unknown as { device: GPUDevice })
    .device as unknown as Record<
    string,
    (descriptor: GPUObjectDescriptorBase) => unknown
  >
  const methods = [
    'createRenderPipeline',
    'createRenderPipelineAsync',
    'createComputePipeline',
    'createComputePipelineAsync',
  ] as const
  const labels: string[] = []
  const held = methods.map((method) => device[method]!)
  methods.forEach((method, k) => {
    device[method] = (descriptor) => {
      labels.push(descriptor.label ?? method)
      return held[k]!.call(device, descriptor)
    }
  })
  try {
    run()
  } finally {
    methods.forEach((method, k) => {
      device[method] = held[k]!
    })
  }
  return labels
}

/** Every lever set the targets, memory, error and images batches draw. */
function leverSets(): [string, Partial<CloudLevers>][] {
  const sets: [string, Partial<CloudLevers>][] = []
  sets.push(['the defaults', {}])
  for (const force of ['reset', 'cut', 'scrub', 'warp', 'fly'] as const)
    sets.push([`force ${force}`, { force }])
  sets.push(['thin', { composite: 'thin' }])
  sets.push(['residual', { composite: 'residual' }])
  sets.push(['stats', { stats: true }])
  sets.push(['deck hidden', { on: false, deck: 'hidden' }])
  // The composite's other two forms: pass B through the lean edit, and the
  // composite alone over the resolved rows, which nothing over the clouds
  // in this scene keeps from drawing.
  sets.push(['lean', { over: 'lean' }])
  sets.push(['chain', { over: 'chain' }])
  return sets
}

/**
 * The lever sets that name a body, on the chain with two in its sky: each
 * forced where the frame would have chosen it, then the two exchanged, so
 * the far body is the one the trace serves and the near one is composited
 * as a disk.
 */
function bodySets(): [string, Partial<CloudLevers>, [string, string | null]][] {
  return [
    ['neither forced', {}, [RIG_EARTH, RIG_TWIN]],
    ['served forced', { served: RIG_EARTH }, [RIG_EARTH, RIG_TWIN]],
    ['second forced', { second: RIG_TWIN }, [RIG_EARTH, RIG_TWIN]],
    [
      'the two exchanged',
      { served: RIG_TWIN, second: RIG_EARTH },
      [RIG_TWIN, RIG_EARTH],
    ],
    [
      'the second forced onto the served body, which leaves none',
      { served: RIG_EARTH, second: RIG_EARTH },
      [RIG_EARTH, null],
    ],
  ]
}

describe('the first frame of every lever set after the warm-up', () => {
  it.each(leverSets())('%s builds no pipeline', async (_, levers) => {
    rig.levers = {
      ...DEFAULT_CLOUD_LEVERS,
      weather: 'overcast',
      on: true,
      ...levers,
    }
    const labels = built(() => rig.frame())
    await gpu.read(rig.target)
    expect(labels).toEqual([])
  })

  it('builds no pipeline on the frame the chain form gives way to pass B, or on the one it comes back', async () => {
    // An overlay over the clouds, warmed where the scene's own are: against
    // the scene's layout, by the camera that tests its layer.
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
    try {
      mesh.visible = false
      rig.levers = {
        ...DEFAULT_CLOUD_LEVERS,
        weather: 'overcast',
        on: true,
        over: 'chain',
      }
      const labels: string[][] = []
      for (const shown of [false, true, false, true]) {
        mesh.visible = shown
        labels.push(built(() => rig.frame()))
      }
      await gpu.read(rig.target)
      expect(labels).toEqual([[], [], [], []])
    } finally {
      rig.scene.remove(mesh)
      mesh.geometry.dispose()
      material.dispose()
    }
  })

  it.each(bodySets())(
    'with a second clouded body, %s builds no pipeline',
    async (_, levers, [served, second]) => {
      pair.levers = {
        ...DEFAULT_CLOUD_LEVERS,
        weather: 'fog',
        on: true,
        ...levers,
      }
      const labels = built(() => pair.frame())
      await gpu.read(pair.target)
      // The control: the set drew the bodies it names, or it tested nothing.
      const report = pair.system!.report
      expect([report.served, report.second]).toEqual([served, second])
      expect(labels).toEqual([])
    },
  )

  /*
   * The one frame that does build a pipeline. The rig's second body is
   * found under the served body's record, so the two have one haze and the
   * air's cache hands both the same pair of tables. The composite binds
   * each body's air through texture nodes of its own, over stand-ins of its
   * own (rule 57), and was compiled with four distinct textures behind
   * them; the frame that points both bodies at one pair leaves two
   * textures behind four nodes, and three builds the composite's program
   * again for it. Two bodies of one haze in one sky are two moons of one
   * recipe, so this is a frame a player can draw.
   *
   * Held as it is, so the suite says where rule 61 is not met and the
   * frame that meets it changes this test.
   */
  it('with a second clouded body under the served body’s own air tables, builds the composite’s pipeline once', async () => {
    shared.levers = { ...DEFAULT_CLOUD_LEVERS, weather: 'fog', on: true }
    const first = built(() => shared.frame())
    await gpu.read(shared.target)
    const report = shared.system!.report
    expect([report.served, report.second]).toEqual([RIG_EARTH, RIG_TWIN])
    expect(first).toHaveLength(1)
    expect(first[0]).toMatch(/^renderPipeline_cloud composite_\d+$/)
    // And only once: every later frame draws with what that one built.
    const later = built(() => {
      for (let k = 0; k < 3; k += 1) shared.frame()
    })
    await gpu.read(shared.target)
    expect(later).toEqual([])
  })
})
