import { expect, it } from 'vitest'
import { NodeUpdateType } from 'three/webgpu'
import { createCloudsAtmosphere } from './cloudsAtmosphere.ts'
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
