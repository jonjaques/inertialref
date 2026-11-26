import { expect, it } from 'vitest'
import { context, vec4 } from 'three/tsl'
import { clouds } from 'three-clouds-webgpu'
import { NodeUpdateType, PerspectiveCamera, type Node } from 'three/webgpu'
import { createCloudsAtmosphere } from './cloudsAtmosphere.ts'
import { CLOUD_QUALITIES } from './cloudQuality.ts'
import { openGpu } from './gpuHarness.ts'

it('retires the pending cloud table bake with its atmosphere context', async () => {
  const gpu = await openGpu()
  const atmosphere = createCloudsAtmosphere()
  try {
    const lut = atmosphere.lutNode
    // Build the real storage textures, then start their bake explicitly so
    // the test owns the pending job and can retire it before the first slice.
    lut.updateBeforeType = NodeUpdateType.NONE
    await gpu.drawGraph(lut.getTextureNode('transmittance'))
    const before = gpu.computePipelinesBuilt()
    const pending = lut.updateTextures(gpu.renderer)
    atmosphere.dispose()
    await pending
    expect(gpu.computePipelinesBuilt() - before).toBe(0)
  } finally {
    gpu.dispose()
  }
})

it.each(CLOUD_QUALITIES)(
  'compiles the %s cloud march on the first frame of a new renderer',
  async (preset) => {
    const gpu = await openGpu()
    const atmosphere = createCloudsAtmosphere()
    const pass = clouds({ sceneDepth: null })
    const camera = new PerspectiveCamera(50, 1, 0.1, 1e10)
    pass.camera = camera
    atmosphere.camera = camera
    atmosphere.raymarchScattering = false
    atmosphere.lutNode.updateBeforeType = NodeUpdateType.NONE
    const settings = pass.cloudsContext
    settings.qualityPreset = preset
    settings.shadow.maxFar = 200_000
    gpu.renderer.contextNode = context({
      getAtmosphere: () => atmosphere,
      getClouds: () => settings,
    })
    const layer = pass.composite(vec4(0))
    try {
      await gpu.drawGraph(layer as unknown as Node)
    } finally {
      layer.dispose()
      pass.dispose()
      settings.dispose()
      atmosphere.dispose()
      gpu.dispose()
    }
  },
)
