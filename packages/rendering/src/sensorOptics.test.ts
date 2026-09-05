import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { depthOfField, LENS_PRESETS, pixelPitch } from './lens.ts'
import {
  defocusDiameter,
  shutterFraction,
  whiteBalance,
} from './sensorOptics.ts'

describe('the photographic sensor', () => {
  it('puts the readout’s near and far limits on the same blur circle', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.1, max: 1000, noNaN: true }), (focus) => {
        const lens = { ...LENS_PRESETS.flight, focus }
        const viewport = { width: 1920, height: 1080 }
        const band = depthOfField(lens, viewport)
        expect(
          Math.abs(defocusDiameter(lens, viewport, band.near)),
        ).toBeCloseTo(1.5, 8)
        if (Number.isFinite(band.far))
          expect(defocusDiameter(lens, viewport, band.far)).toBeCloseTo(1.5, 8)
        expect(defocusDiameter(lens, viewport, focus)).toBeCloseTo(0, 10)
      }),
    )
  })
  it('uses the infinity limit and physical pixel pitch', () => {
    const lens = LENS_PRESETS.flight
    const viewport = { width: 1920, height: 1080 }
    const expected =
      lens.focalLength ** 2 / (lens.fStop * 2000 * pixelPitch(lens, viewport))
    expect(defocusDiameter(lens, viewport, 2)).toBeCloseTo(-expected)
    expect(defocusDiameter(lens, viewport, Infinity)).toBe(0)
    expect(Number.isFinite(defocusDiameter(lens, viewport, 0))).toBe(true)
  })
  it('holds the shutter closed on a pause, seek or disabled stance', () => {
    expect(shutterFraction(1 / 120, 1 / 60, true)).toBe(0.5)
    expect(shutterFraction(30, 1 / 60, true)).toBe(1)
    expect(shutterFraction(30, 0, true)).toBe(0)
    expect(shutterFraction(30, -1, true)).toBe(0)
    expect(shutterFraction(30, 1 / 60, false)).toBe(0)
    expect(shutterFraction(1 / 60, 100_000 / 60, true)).toBeCloseTo(0.00001)
  })
  it('keeps D65 neutral and declares a finite, reversible balance', () => {
    expect(whiteBalance(6500)).toEqual([1, 1, 1])
    for (const k of [2000, 3000, 10000, 12000]) {
      const gains = whiteBalance(k)
      expect(gains.every((gain) => gain > 0 && Number.isFinite(gain))).toBe(
        true,
      )
    }
    expect(whiteBalance(3000)[2]).toBeGreaterThan(whiteBalance(3000)[0]!)
  })
})
