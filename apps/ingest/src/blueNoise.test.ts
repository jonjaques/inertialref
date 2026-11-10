import { describe, expect, it } from 'vitest'
import { BLUE_NOISE } from '@inertialref/rendering'
import {
  BLUE_NOISE_MASK,
  blueNoiseRanks,
  generateBlueNoise,
  type MaskLayout,
  sliceLowEnergy,
  sourceText,
  temporalLowEnergy,
  whiteMask,
  windowMeanVariance,
} from './blueNoise.ts'

/*
 * The committed mask held to what it is for: blue in each slice, blue along
 * each pixel's sequence, and an even histogram in every slice. Each bound is
 * checked against a white mask of the same histogram as well, so a bound
 * loose enough to pass noise fails here, not in a frame.
 *
 * The figures are the mask's own, measured on it, against bounds a white
 * mask cannot reach: a white slice puts its share of the energy in any band,
 * 1 in expectation with a spread of about 1/√bins, and the band under a
 * quarter of Nyquist on a 64-texel slice holds about 200 bins.
 */

const committed = Uint8Array.from(Buffer.from(BLUE_NOISE.bytes, 'base64'))
const layout: MaskLayout = BLUE_NOISE
const white = whiteMask(committed, layout, 'blueNoise.test/white')
const slices = Array.from({ length: layout.slices }, (_, z) => z)

/** The design's bound: a slice's energy under a quarter of Nyquist, as a share of white noise's (phase 1 design §6.1). */
const SPATIAL = 0.1
/** A pixel's sixteen samples at their first harmonic, the slowest drift a sequence can make, as a share of white noise's. */
const TEMPORAL = 0.1
/** The error of eight consecutive samples' mean, the history's window, as a variance over white noise's σ²/8. */
const WINDOW = 0.25

describe('the committed mask', () => {
  it('is the generator’s layout, one byte a texel', () => {
    expect(BLUE_NOISE.width).toBe(BLUE_NOISE_MASK.width)
    expect(BLUE_NOISE.height).toBe(BLUE_NOISE_MASK.height)
    expect(BLUE_NOISE.slices).toBe(BLUE_NOISE_MASK.slices)
    expect(committed).toHaveLength(64 * 64 * 16)
  })

  it('holds every value 0 to 255 equally often in each slice', () => {
    const area = layout.width * layout.height
    for (const z of slices) {
      const counts = new Array<number>(256).fill(0)
      for (const byte of committed.subarray(z * area, (z + 1) * area))
        counts[byte]! += 1
      expect(new Set(counts)).toEqual(new Set([area / 256]))
    }
  })

  it('puts under a tenth of white noise’s energy below a quarter of Nyquist in every slice, where a white mask does not', () => {
    for (const z of slices) {
      expect(sliceLowEnergy(committed, layout, z)).toBeLessThan(SPATIAL)
      expect(sliceLowEnergy(white, layout, z)).toBeGreaterThan(SPATIAL)
    }
  })

  it('spreads each pixel’s consecutive samples: its sequence is blue, where a white mask’s is not', () => {
    expect(temporalLowEnergy(committed, layout)).toBeLessThan(TEMPORAL)
    expect(temporalLowEnergy(white, layout)).toBeGreaterThan(TEMPORAL)
    expect(windowMeanVariance(committed, layout)).toBeLessThan(WINDOW)
    expect(windowMeanVariance(white, layout)).toBeGreaterThan(WINDOW)
  })
})

describe('the generator', () => {
  const small = { ...BLUE_NOISE_MASK, width: 16, height: 16, slices: 4 }

  it('ranks every texel once', () => {
    const ranks = blueNoiseRanks(small)
    expect([...ranks].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 * 16 * 4 }, (_, i) => i),
    )
  })

  it('is deterministic from its seed, and its file holds nothing that differs between runs', () => {
    const once = generateBlueNoise(small)
    expect(generateBlueNoise(small)).toEqual(once)
    expect(sourceText(generateBlueNoise(small), small)).toBe(
      sourceText(once, small),
    )
    expect(generateBlueNoise({ ...small, seed: 'another' })).not.toEqual(once)
  })

  it('makes a blue mask at a size the test can afford', () => {
    const mask = generateBlueNoise(small)
    for (let z = 0; z < small.slices; z += 1)
      expect(sliceLowEnergy(mask, small, z)).toBeLessThan(SPATIAL)
  })
})
