import { afterAll, beforeAll, expect, it } from 'vitest'
import { DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three/webgpu'
import { nodeObject, texture } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { PsfNode } from './psf.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(256, 256)
})
afterAll(() => gpu.dispose())

it('redistributes 1.5% of a point without a threshold or invented light', async () => {
  const pixels = new Float32Array(256 * 256 * 4)
  for (const [x, y] of [
    [127, 127],
    [128, 127],
    [127, 128],
    [128, 128],
  ]) {
    const i = (y! * 256 + x!) * 4
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 100
    pixels[i + 3] = 1
  }
  const image = new DataTexture(pixels, 256, 256, RGBAFormat, FloatType)
  image.minFilter = image.magFilter = LinearFilter
  image.needsUpdate = true
  const psf = new PsfNode(texture(image))
  try {
    const result = await gpu.drawGraph(nodeObject(psf), {
      width: 256,
      height: 256,
      float: true,
    })
    let energy = 0
    let outside = 0
    for (let y = 0; y < 256; y += 1)
      for (let x = 0; x < 256; x += 1) {
        const light = result.at(x, y)[0]
        energy += light
        if (x < 127 || x > 128 || y < 127 || y > 128) outside += light
      }
    // Subtracting the direct core after an rgba16float resolve attributes its
    // rounding to glare: a 0.05% frame error becomes 3.55% of a 1.5% skirt.
    // Measure the kernel by itself, then hold the resolved frame separately.
    psf.scatter.value = 1
    const halo = await gpu.drawGraph(nodeObject(psf), {
      width: 256,
      height: 256,
      float: true,
    })
    let scattered = 0
    for (let i = 0; i < halo.data.length; i += 4) scattered += halo.data[i]!
    expect(Math.abs(scattered / 400 - 1)).toBeLessThan(0.02)
    expect(Math.abs(energy / 400 - 1)).toBeLessThan(0.001)
    expect(outside / 400).toBeGreaterThan(0.012)
    expect(outside / 400).toBeLessThan(0.015 * 1.02)
  } finally {
    psf.dispose()
    image.dispose()
  }
})
