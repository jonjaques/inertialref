import { afterAll, beforeAll, expect, it } from 'vitest'
import { blackbodyColor } from '@inertialref/universe'
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
  const color = uniform(vec3(1))
  const graph = renderOutput(
    vec4(color.mul(scale), 1),
    CustomToneMapping,
    LinearSRGBColorSpace,
  )
  for (const temperature of [3000, 10000]) {
    const rgb = blackbodyColor(temperature)
    color.value.set(rgb.r, rgb.g, rgb.b)
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

it('spends the extended range on the star, not on the sky beside it', async () => {
  const scale = uniform(1)
  const graph = renderOutput(
    vec4(vec3(1).mul(scale), 1),
    CustomToneMapping,
    LinearSRGBColorSpace,
  )
  const drawn = async (headroom: number, light: number): Promise<number> => {
    installToneCurve(gpu.renderer, headroom).natural.value = 0
    scale.value = light
    const [r, g, b] = (await gpu.drawGraph(graph, { float: true })).at(20, 20)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  for (const headroom of [2, 16]) {
    // Below the shoulder an HDR capture is the SDR one.
    for (const light of [0.05, 0.3, 0.6])
      expect(await drawn(headroom, light)).toBeCloseTo(await drawn(1, light), 6)
    // The calibrated star disk takes the display's peak...
    expect(await drawn(headroom, 8)).toBeGreaterThan(0.97 * headroom)
    // ...and Earth's noon aureole three degrees off it, at 2.8 times the
    // surface white, does not: the graded lift drew it at 0.85 of the peak
    // on a 2× display, beside a disk at 0.98.
    expect(await drawn(headroom, 2.8)).toBeLessThan(0.75 * headroom)
    let previous = 0
    for (let light = 0.25; light <= 64; light *= 1.25) {
      const value = await drawn(headroom, light)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  }
  installToneCurve(gpu.renderer, 1)
})

it('draws a light far past the display brighter than the glow around it, at its own hue', async () => {
  // A 2° sun through the air is a deep orange at a hundred times the
  // surface white; the aureole beside it a pale orange at three. Scaled down
  // until its reddest channel fits, the disk drew at a luminance of 0.55
  // beside an aureole at 0.79 — the brightest thing in the sky drawn as a
  // dark spot in its own glow. A camera clips the disk toward white.
  installToneCurve(gpu.renderer, 1).natural.value = 0
  const scale = uniform(1)
  const color = uniform(vec3(1))
  const graph = renderOutput(
    vec4(color.mul(scale), 1),
    CustomToneMapping,
    LinearSRGBColorSpace,
  )
  const drawn = async (rgb: readonly number[], light: number) => {
    color.value.set(rgb[0]!, rgb[1]!, rgb[2]!)
    scale.value =
      light / (0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!)
    return (await gpu.drawGraph(graph, { float: true })).at(20, 20).slice(0, 3)
  }
  const lum = ([r, g, b]: readonly number[]) =>
    0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  const disk = [1, 0.47, 0.07]
  const aureole = [1, 0.75, 0.5]
  const diskDrawn = await drawn(disk, 100)
  const aureoleDrawn = await drawn(aureole, 3)
  expect(lum(diskDrawn)).toBeGreaterThan(lum(aureoleDrawn))
  expect(degreesApart(hue(diskDrawn), hue(disk))).toBeLessThan(0.05)
  // Below the top of the curve nothing is bleached: a mid-tone keeps its
  // saturation exactly.
  const mid = await drawn(disk, 0.3)
  expect(mid[1]! / mid[0]!).toBeCloseTo(0.47, 4)
})

it('applies the display gamma up to white and leaves the headroom alone', async () => {
  // A power on the displayed range up to white: a midtone at gamma 2 is the
  // square root of itself at gamma 1. Above white is a star's headroom, and
  // where a disk clips must not move with the viewer's room.
  const tone = installToneCurve(gpu.renderer, 2)
  tone.natural.value = 0
  tone.gamma.value = 1
  const scale = uniform(1)
  const graph = renderOutput(
    vec4(vec3(scale), 1),
    CustomToneMapping,
    LinearSRGBColorSpace,
  )
  const drawn = async (light: number, gamma: number) => {
    scale.value = light
    tone.gamma.value = gamma
    return (await gpu.drawGraph(graph, { float: true })).at(20, 20)[1]!
  }
  const midtone = await drawn(0.18, 1)
  expect(midtone).toBeGreaterThan(0.1)
  expect(midtone).toBeLessThan(0.9)
  expect(await drawn(0.18, 2)).toBeCloseTo(Math.sqrt(midtone), 4)
  expect(await drawn(0.18, 0.5)).toBeCloseTo(midtone * midtone, 4)
  const bright = await drawn(1000, 1)
  expect(bright).toBeGreaterThan(1)
  expect(await drawn(1000, 2)).toBeCloseTo(bright, 5)
  tone.gamma.value = 1
})
