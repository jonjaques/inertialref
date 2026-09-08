import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  CAMERA_MODES,
  DEFAULT_SENSOR_SETTINGS,
  resolveCameraPolicy,
} from './exposure.ts'
import { LENS_PRESETS } from './lens.ts'
import { surfaceColour, surfaceVisibilityGain } from './surfaceColour.ts'

const channel = fc.double({ min: 0.001, max: 1, noNaN: true })
const colour = fc.record({ r: channel, g: channel, b: channel })

describe('surface source colour and visibility', () => {
  it('keeps mapped brightness in the map while preserving the swatch’s hue', () => {
    fc.assert(
      fc.property(colour, channel, (swatch, brightness) => {
        const tint = surfaceColour({ texture: 'map', colour: swatch })
        const dimmer = surfaceColour({
          texture: 'map',
          colour: {
            r: swatch.r * brightness,
            g: swatch.g * brightness,
            b: swatch.b * brightness,
          },
        })
        expect(Math.max(tint.r, tint.g, tint.b)).toBe(1)
        for (const key of ['r', 'g', 'b'] as const) {
          expect(dimmer[key]).toBeCloseTo(tint[key], 12)
          expect(tint[key] / tint.r).toBeCloseTo(swatch[key] / swatch.r, 10)
        }
      }),
    )
  })

  it('keeps a mapless swatch’s physical reflectance unchanged', () => {
    fc.assert(
      fc.property(colour, (swatch) => {
        expect(surfaceColour({ texture: null, colour: swatch })).toBe(swatch)
      }),
    )
  })

  it('does not create light from a black source', () => {
    const black = { r: 0, g: 0, b: 0 }
    expect(surfaceColour({ texture: 'map', colour: black })).toEqual(black)
  })

  it.each(CAMERA_MODES)('separates %s processing from reflectance', (mode) => {
    const policy = resolveCameraPolicy(
      { ...DEFAULT_SENSOR_SETTINGS, mode },
      LENS_PRESETS.flight,
    )
    expect(
      surfaceVisibilityGain(0.044, 0.3, policy.processing === 'enhanced'),
    ).toBe(mode === 'enhanced' ? 0.12 / 0.044 : 1)
  })

  it('bounds the lift, preserves distant points, and is continuous at the albedo threshold', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1.5, noNaN: true }),
        fc.double({ min: 0, max: Math.PI / 2, noNaN: true }),
        (albedo, angle) => {
          const gain = surfaceVisibilityGain(albedo, angle, true)
          expect(gain).toBeGreaterThanOrEqual(1)
          expect(gain).toBeLessThanOrEqual(12)
          expect(surfaceVisibilityGain(albedo, 0.02, true)).toBe(1)
          expect(surfaceVisibilityGain(albedo, angle, false)).toBe(1)
        },
      ),
    )
    expect(surfaceVisibilityGain(0.12 - 1e-12, 0.3, true)).toBeCloseTo(1, 9)
    expect(surfaceVisibilityGain(0.12, 0.3, true)).toBe(1)
  })
})
