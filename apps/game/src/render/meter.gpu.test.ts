import { afterAll, beforeAll, expect, it } from 'vitest'
import { histogram } from '@inertialref/rendering'
import { FloatType, RenderTarget } from 'three/webgpu'
import { exp2, uv, vec4 } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { createHistogramMeter } from './meter.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(260, 12)
})
afterAll(() => gpu.dispose())

it('counts the actual texture into all 64 bins, including a partial workgroup', async () => {
  const target = new RenderTarget(260, 12, { type: FloatType })
  const pixels = await gpu.drawGraph(
    vec4(exp2(uv().x.mul(36).sub(18)), 0, 0, 1),
    { into: target },
  )
  const meter = createHistogramMeter(target.texture)
  try {
    const actual = await new Promise<Uint32Array>((resolve) =>
      meter.sample(gpu.renderer, 260, 12, resolve),
    )
    const samples: number[] = []
    for (let y = 0; y < 12; y += 4)
      for (let x = 0; x < 260; x += 4) samples.push(pixels.at(x, y)[0] * 0.2126)
    expect([...actual]).toEqual([...histogram(samples)])
    expect(actual.reduce((a, b) => a + b, 0)).toBe(195)
    await gpu.compute(meter.clear)
    expect([
      ...new Uint32Array(await gpu.renderer.getArrayBufferAsync(meter.bins)),
    ]).toEqual(Array<number>(64).fill(0))
  } finally {
    meter.dispose()
    target.dispose()
  }
})
