import { afterAll, beforeAll, expect, it } from 'vitest'
import { blackbodyColour } from '@inertialref/universe'
import {
  ACESFilmicToneMapping,
  CustomToneMapping,
  LinearSRGBColorSpace,
} from 'three/webgpu'
import { renderOutput, uniform, vec3, vec4 } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { installToneCurve } from './tonemap.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
  installToneCurve(gpu.renderer, 1)
})
afterAll(() => gpu.dispose())

// Opponent-plane hue: independent of exposure and achromatic lift.
const hue = ([r, g, b]: readonly number[]) =>
  Math.atan2(Math.sqrt(3) * (g! - b!), 2 * r! - g! - b!)
const degreesApart = (a: number, b: number) =>
  (Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180) / Math.PI

it('preserves the catalog blackbody hue through the entire highlight range', async () => {
  installToneCurve(gpu.renderer, 1).natural.value = 0
  const scale = uniform(1)
  const colour = uniform(vec3(1))
  const graph = renderOutput(
    vec4(colour.mul(scale), 1),
    CustomToneMapping,
    LinearSRGBColorSpace,
  )
  for (const temperature of [3000, 10000]) {
    const rgb = blackbodyColour(temperature)
    colour.value.set(rgb.r, rgb.g, rgb.b)
    const original = hue([rgb.r, rgb.g, rgb.b])
    let worst = 0
    for (const light of [0.1, 0.3, 1, 3, 10, 30, 100]) {
      scale.value = light
      const drawn = await gpu.drawGraph(graph, { float: true })
      worst = Math.max(worst, degreesApart(hue(drawn.at(20, 20)), original))
    }
    console.log(`Sensor hue ${temperature} K: ${worst.toFixed(5)} degrees`)
    expect.soft(worst).toBeLessThan(0.05)
  }
})

it('keeps Natural equal to the production ACES fit at SDR headroom', async () => {
  installToneCurve(gpu.renderer, 1).natural.value = 1
  for (const rgb of [
    [0.01, 0.02, 0.03],
    [0.2, 0.3, 0.1],
    [1, 0.4, 0.02],
    [10, 2, 0.5],
  ]) {
    const input = vec4(vec3(...(rgb as [number, number, number])), 1)
    const natural = await gpu.drawGraph(
      renderOutput(input, CustomToneMapping, LinearSRGBColorSpace),
      { float: true },
    )
    const production = await gpu.drawGraph(
      renderOutput(input, ACESFilmicToneMapping, LinearSRGBColorSpace),
      { float: true },
    )
    for (let channel = 0; channel < 3; channel += 1)
      expect(natural.at(20, 20)[channel]).toBeCloseTo(
        production.at(20, 20)[channel]!,
        6,
      )
  }
})
