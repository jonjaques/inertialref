import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  CLOUD_HISTOGRAM_BINS,
  CLOUD_SETTLE_FRAMES,
  cloudHistogramBin,
  cloudHistogramEdge,
  type CloudRadiance,
  cloudRadianceDifference,
  type CloudRenderReport,
  cloudReportIdle,
  cloudsSettled,
} from './clouds.ts'

describe('the cloud histograms’ bins', () => {
  it('put every error between its bin’s edges, a sixteenth of a decade wide', () => {
    fc.assert(
      fc.property(fc.double({ min: 1.01e-4, max: 0.98, noNaN: true }), (e) => {
        const bin = cloudHistogramBin(e)
        // An edge is a power of ten, so float64 may put a value one ulp
        // either side of it into either neighbor.
        const ulp = 4 * Number.EPSILON * e
        expect(cloudHistogramEdge(bin)).toBeLessThanOrEqual(e + ulp)
        expect(cloudHistogramEdge(bin + 1)).toBeGreaterThan(e - ulp)
      }),
    )
  })

  it('hold everything under 10⁻⁴ in the first and everything from 10^(−1/16) up in the last', () => {
    expect(cloudHistogramBin(0)).toBe(0)
    expect(cloudHistogramBin(1e-9)).toBe(0)
    expect(cloudHistogramBin(1)).toBe(CLOUD_HISTOGRAM_BINS - 1)
    expect(cloudHistogramBin(1e9)).toBe(CLOUD_HISTOGRAM_BINS - 1)
    expect(cloudHistogramEdge(0)).toBe(1e-4)
    expect(cloudHistogramEdge(CLOUD_HISTOGRAM_BINS)).toBe(1)
    // 1% is an edge, which the runner reports exactly.
    expect(cloudHistogramEdge(32)).toBe(0.01)
  })
})

/** A drawing system's report: on, nothing owed, `sinceReset` frames since its last reset. */
function drawing(
  sinceReset: number,
  pending: Partial<CloudRenderReport['pending']> = {},
): Omit<CloudRenderReport, 'settle'> {
  const { settle: _settle, ...idle } = cloudReportIdle()
  return {
    ...idle,
    on: true,
    regime: 'converging',
    sinceReset,
    pending: { ...idle.pending, ...pending },
  }
}

describe('cloudsSettled', () => {
  it('is null where there is nothing to wait for: no system, the levers off, WebGL', () => {
    expect(cloudsSettled(null)).toBeNull()
    expect(cloudsSettled(cloudReportIdle())).toBeNull()
    expect(cloudsSettled(cloudReportIdle('webgl'))).toBeNull()
  })

  it('waits four whole interleave cycles after a reset', () => {
    for (let frames = 0; frames < CLOUD_SETTLE_FRAMES; frames += 1)
      expect(cloudsSettled(drawing(frames))).toEqual({
        pending: true,
        history: `${frames}/32`,
        caches: 'ready',
      })
    expect(cloudsSettled(drawing(CLOUD_SETTLE_FRAMES))).toEqual({
      pending: false,
      history: '32/32',
      caches: 'ready',
    })
    expect(cloudsSettled(drawing(400))?.history).toBe('32/32')
  })

  it('waits on every cache that owes work, and names each', () => {
    const settle = cloudsSettled(drawing(40, { far: true, maps: true }))
    expect(settle).toEqual({
      pending: true,
      history: '32/32',
      caches: 'maps, far',
    })
    for (const cache of Object.keys(cloudReportIdle().pending))
      expect(cloudsSettled(drawing(40, { [cache]: true }))?.pending).toBe(true)
  })
})

describe('the idle report', () => {
  it('is available and off for a system that exists, and unavailable on WebGL', () => {
    expect(cloudReportIdle()).toMatchObject({
      available: true,
      reason: null,
      on: false,
      regime: 'off',
      settle: null,
      bytes: { total: 0 },
    })
    expect(cloudReportIdle('webgl')).toMatchObject({
      available: false,
      reason: 'webgl',
      on: false,
    })
  })
})

/** A capture over `width` × `height` texels from luminances and marks. */
function capture(
  width: number,
  height: number,
  luminance: readonly number[],
  cloud: readonly number[],
): CloudRadiance {
  return {
    width,
    height,
    luminance: Float32Array.from(luminance),
    cloud: Uint8Array.from(cloud),
  }
}

/** Two captures of one extent: luminances in scene units, and marks. */
const pair = fc
  .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 12 }))
  .chain(([width, height]) => {
    const texels = width * height
    // Scene luminances, flushed to zero under 10⁻⁶: a float32 subnormal
    // scaled down underflows to zero, which no frame's radiance reaches.
    const luminances = fc.array(
      fc
        .float({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true })
        .map((v) => (v < 1e-6 ? 0 : v)),
      { minLength: texels, maxLength: texels },
    )
    const marks = fc.array(fc.integer({ min: 0, max: 1 }), {
      minLength: texels,
      maxLength: texels,
    })
    return fc
      .tuple(luminances, marks, luminances, marks)
      .map(([la, ma, lb, mb]) => [
        capture(width, height, la, ma),
        capture(width, height, lb, mb),
      ])
  })

describe('the radiance difference', () => {
  it('is the RMS over the mean, over the texels either capture holds cloud at', () => {
    // Texel 0 cloudy in a, 1 in b, 2 in neither: 3's difference is not counted.
    const a = capture(2, 2, [1, 2, 3, 100], [1, 0, 0, 0])
    const b = capture(2, 2, [3, 2, 3, 0], [0, 1, 0, 0])
    const d = cloudRadianceDifference(a, b)
    expect(d.texels).toBe(2)
    expect(d.rmse).toBeCloseTo(Math.sqrt(4 / 2), 12)
    expect(d.mean).toBeCloseTo((1 + 3 + 2 + 2) / 4, 12)
    expect(d.relative).toBeCloseTo(Math.sqrt(2) / 2, 12)
  })

  it('is symmetric, zero between a capture and itself, and the same for both captures scaled alike', () => {
    fc.assert(
      fc.property(
        pair,
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        ([a, b], k) => {
          const ab = cloudRadianceDifference(a!, b!)
          const ba = cloudRadianceDifference(b!, a!)
          expect(ba).toEqual(ab)
          const self = cloudRadianceDifference(a!, a!)
          expect(self.rmse).toBe(0)
          if (self.relative !== null) expect(self.relative).toBe(0)
          const scale = (c: CloudRadiance) => ({
            ...c,
            luminance: c.luminance.map((v) => v * k),
          })
          const scaled = cloudRadianceDifference(scale(a!), scale(b!))
          expect(scaled.texels).toBe(ab.texels)
          if (ab.relative === null || scaled.relative === null)
            expect(scaled.relative).toBe(ab.relative)
          // Float32 luminances: scaling rounds each to its own 2⁻²⁴.
          else expect(scaled.relative).toBeCloseTo(ab.relative, 4)
        },
      ),
    )
  })

  it('reads nothing at a texel neither capture holds cloud at', () => {
    fc.assert(
      fc.property(
        pair,
        fc.float({ min: 0, max: 1e4, noNaN: true }),
        ([a, b], v) => {
          const clear = [...a!.cloud.keys()].find(
            (i) => a!.cloud[i] === 0 && b!.cloud[i] === 0,
          )
          fc.pre(clear !== undefined)
          const moved = { ...a!, luminance: Float32Array.from(a!.luminance) }
          moved.luminance[clear!] = v
          expect(cloudRadianceDifference(moved, b!)).toEqual(
            cloudRadianceDifference(a!, b!),
          )
        },
      ),
    )
  })

  it('has no ratio where nothing holds cloud or nothing is lit', () => {
    const dark = capture(1, 2, [0, 0], [1, 1])
    expect(cloudRadianceDifference(dark, dark).relative).toBeNull()
    const clear = capture(1, 2, [5, 6], [0, 0])
    expect(cloudRadianceDifference(clear, clear)).toEqual({
      texels: 0,
      rmse: 0,
      mean: 0,
      relative: null,
    })
  })

  it('refuses two captures of different extents, and a capture whose arrays are not its extent', () => {
    const a = capture(2, 1, [1, 1], [1, 1])
    expect(() =>
      cloudRadianceDifference(a, capture(1, 2, [1, 1], [1, 1])),
    ).toThrow(/differ in extent/)
    expect(() =>
      cloudRadianceDifference(a, capture(2, 1, [1, 1, 1], [1, 1])),
    ).toThrow(/holds 3 luminances/)
  })
})
