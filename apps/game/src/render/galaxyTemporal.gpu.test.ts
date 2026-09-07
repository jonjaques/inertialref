import { afterAll, beforeAll, expect, it } from 'vitest'
import { uniform, vec4 } from 'three/tsl'
import { Quaternion as Q, UV, vec3 } from '@inertialref/spatial'
import { PARSEC } from '@inertialref/shared'
import { LENS_PRESETS, verticalFov } from '@inertialref/rendering'
import { GalaxyTemporalVolume } from './galaxyTemporal.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'
let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(64, 48)
})
afterAll(() => gpu?.dispose())
it('fills every phase, reprojects rotation, and forgets a cut or resize', async () => {
  const volume = new GalaxyTemporalVolume(
    (_origin, direction) => vec4(direction.normalize().mul(0.2).add(0.3), 1000),
    { stride: 2 },
  )
  const pose = { position: UV.fromMeters(0, 0, 0), orientation: Q.IDENTITY }
  try {
    volume.configure(pose, LENS_PRESETS.flight, 1)
    await volume.warm(gpu.renderer)
    for (let i = 0; i < 4; i++) volume.render(gpu.renderer, 64, 48)
    const fixed = await gpu.drawGraph(volume.sample(), {
      float: true,
      width: 64,
      height: 48,
    })
    const half = Math.tan(verticalFov(LENS_PRESETS.flight) / 2)
    for (let y = 3; y < 45; y += 7)
      for (let x = 3; x < 61; x += 9) {
        const dx = (((2 * (x + 0.5)) / 64 - 1) * half * 64) / 48,
          dy = (1 - (2 * (y + 0.5)) / 48) * half
        const length = Math.hypot(dx, dy, 1)
        const expected = [
          0.3 + (0.2 * dx) / length,
          0.3 + (0.2 * dy) / length,
          0.3 - 0.2 / length,
        ]
        for (let c = 0; c < 3; c++)
          expect(Math.abs(fixed.at(x, y)[c]! - expected[c]!)).toBeLessThan(
            0.001,
          )
      }
    expect(volume.report.refreshed).toBe(4)
    volume.configure(
      { ...pose, orientation: Q.fromAxisAngle(vec3(0, 1, 0), 0.02) },
      LENS_PRESETS.flight,
      1,
    )
    volume.render(gpu.renderer, 64, 48)
    expect(volume.report.resets).toBe(1)
    volume.configure(
      { ...pose, orientation: Q.fromAxisAngle(vec3(0, 1, 0), Math.PI) },
      LENS_PRESETS.flight,
      1,
    )
    volume.render(gpu.renderer, 64, 48)
    expect(volume.report.resets).toBe(2)
    volume.render(gpu.renderer, 80, 48)
    expect(volume.report.resets).toBe(3)
    volume.configure(pose, LENS_PRESETS.flight, 2)
    volume.render(gpu.renderer, 80, 48)
    expect(volume.report.resets).toBe(4)
  } finally {
    volume.dispose()
  }
  expect(volume.report.bytes).toBe(0)
})

it('rejects depth disocclusion and large translation without retaining old color', async () => {
  const depth = uniform(100)
  const volume = new GalaxyTemporalVolume((_origin, direction) =>
    vec4(
      depth.lessThan(200).select(direction.x.mul(0.1).add(0.6), 0.05),
      0.1,
      depth.greaterThan(200).select(0.7, 0.02),
      depth,
    ),
  )
  const pose = { position: UV.fromMeters(0, 0, 0), orientation: Q.IDENTITY }
  try {
    volume.configure(pose, LENS_PRESETS.flight, 1)
    await volume.warm(gpu.renderer)
    volume.render(gpu.renderer, 65, 49)
    depth.value = 500
    volume.render(gpu.renderer, 65, 49)
    const read = () =>
      gpu.drawGraph(volume.sample(), { float: true, width: 65, height: 49 })
    const uncovered = await read()
    for (let y = 2; y < 47; y += 5)
      for (let x = 2; x < 63; x += 7) {
        expect(uncovered.at(x, y)[0]).toBeCloseTo(0.05, 3)
        expect(uncovered.at(x, y)[2]).toBeCloseTo(0.7, 3)
      }
    // Radiance history is independent of exposure; neither the shutter nor
    // gain changes a physical ray or forces a discarded history.
    const resets = volume.report.resets
    volume.configure(pose, { ...LENS_PRESETS.flight, iso: 6400 }, 1)
    volume.render(gpu.renderer, 65, 49)
    expect(volume.report.resets).toBe(resets)
    depth.value = 100
    volume.configure(
      { ...pose, position: UV.fromMeters(1000 * PARSEC, 0, 0) },
      LENS_PRESETS.flight,
      1,
    )
    volume.render(gpu.renderer, 65, 49)
    const translated = await read()
    expect(translated.at(32, 24)[0]).toBeGreaterThan(0.59)
    expect(translated.at(32, 24)[2]).toBeCloseTo(0.02, 3)
    volume.configure(null, LENS_PRESETS.flight, 1)
    volume.configure(pose, LENS_PRESETS.flight, 1)
    volume.render(gpu.renderer, 65, 49)
    expect(volume.report.resets).toBe(resets + 1)
  } finally {
    volume.dispose()
  }
})

it('retains fine stationary structure across all sixteen interleaved phases', async () => {
  const volume = new GalaxyTemporalVolume((_origin, direction) =>
    vec4(
      direction.x.div(direction.z).mul(90).sin().mul(0.3).add(0.4),
      0.1,
      0.1,
      1000,
    ),
  )
  const pose = { position: UV.fromMeters(0, 0, 0), orientation: Q.IDENTITY }
  try {
    volume.configure(pose, LENS_PRESETS.flight, 1)
    await volume.warm(gpu.renderer)
    for (let i = 0; i < 16; i++) volume.render(gpu.renderer, 64, 48)
    const pixels = await gpu.drawGraph(volume.sample(), {
      float: true,
      width: 64,
      height: 48,
    })
    const half = Math.tan(verticalFov(LENS_PRESETS.flight) / 2)
    for (let x = 4; x < 60; x++) {
      const dx = (((2 * (x + 0.5)) / 64 - 1) * half * 64) / 48
      const expected = 0.4 + 0.3 * Math.sin(-dx * 90)
      expect(Math.abs(pixels.at(x, 24)[0] - expected)).toBeLessThan(0.001)
    }
  } finally {
    volume.dispose()
  }
})
