import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CLOUD_CACHES,
  CLOUD_FAR_KINDS,
  CLOUD_PLACEMENTS,
  CLOUD_SUN_DEPTHS,
  type CloudLevers,
  DEFAULT_CLOUD_LEVERS,
} from './cloudLevers.ts'
import { type CloudRig, cloudRig } from './cloudSystemRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

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
 */

const WIDTH = 64
const HEIGHT = 48

let gpu: GpuSession
let rig: CloudRig

beforeAll(async () => {
  gpu = await openGpu(WIDTH, HEIGHT)
  rig = cloudRig(gpu, WIDTH, HEIGHT, {
    ceiling: 50,
    levers: { scenario: 'overcast' },
  })
  await rig.sensor.warm()
  await rig.system!.warm()
  // The sensor's own first frame, which compiles its meter's kernels.
  rig.frame()
  await gpu.read(rig.target)
}, 180_000)

afterAll(() => {
  rig?.dispose()
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

/** Every lever set the decisions, sweep, targets and error batches draw. */
function leverSets(): [string, Partial<CloudLevers>][] {
  const sets: [string, Partial<CloudLevers>][] = []
  for (const placement of CLOUD_PLACEMENTS)
    for (const cache of CLOUD_CACHES)
      for (const sunDepth of CLOUD_SUN_DEPTHS)
        for (const far of CLOUD_FAR_KINDS)
          sets.push([
            `${placement} ${cache} ${sunDepth} ${far}`,
            { placement, cache, sunDepth, far },
          ])
  for (const force of ['reset', 'cut', 'scrub', 'warp', 'fly'] as const)
    sets.push([`force ${force}`, { force }])
  sets.push(['thin', { composite: 'thin' }])
  sets.push(['residual', { composite: 'residual' }])
  sets.push(['stats', { stats: true }])
  sets.push(['sweep', { fixedSteps: 64, sweepReads: 2, sweepExtra: 'curl' }])
  sets.push([
    'sweep in RGBA8',
    { fixedSteps: 64, sweepReads: 4, noiseFormat: 'rgba8' },
  ])
  sets.push(['deck hidden', { on: false, deck: 'hidden' }])
  return sets
}

describe('the first frame of every lever set after the warm-up', () => {
  it.each(leverSets())('%s builds no pipeline', async (_, levers) => {
    rig.levers = {
      ...DEFAULT_CLOUD_LEVERS,
      scenario: 'overcast',
      on: true,
      ...levers,
    }
    const labels = built(() => rig.frame())
    await gpu.read(rig.target)
    expect(labels).toEqual([])
  })
})
