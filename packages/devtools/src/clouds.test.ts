import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  CLOUD_HISTOGRAM_BINS,
  cloudHistogramBin,
  cloudHistogramEdge,
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
