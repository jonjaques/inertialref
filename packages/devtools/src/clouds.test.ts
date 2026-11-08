import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  CLOUD_HISTOGRAM_BINS,
  CLOUD_SETTLE_FRAMES,
  cloudHistogramBin,
  cloudHistogramEdge,
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
        history: `${frames}/16`,
        caches: 'ready',
      })
    expect(cloudsSettled(drawing(CLOUD_SETTLE_FRAMES))).toEqual({
      pending: false,
      history: '16/16',
      caches: 'ready',
    })
    expect(cloudsSettled(drawing(400))?.history).toBe('16/16')
  })

  it('waits on every cache that owes work, and names each', () => {
    const settle = cloudsSettled(drawing(40, { far: true, maps: true }))
    expect(settle).toEqual({
      pending: true,
      history: '16/16',
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
