import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { LENS_PRESETS, exposureValue } from './lens.ts'
import {
  DEFAULT_SENSOR_SETTINGS,
  ExposureMeter,
  exposureForLuminance,
  SURFACE_LUMINANCE,
  adaptExposure,
  exposureMultiplier,
  histogram,
  meterHistogram,
  splitExposure,
} from './exposure.ts'

describe('the sensor exposure', () => {
  it('halves collected light for every stop, with an exact pre-exposure split', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -20, max: 40, noNaN: true }),
        fc.double({ min: -20, max: 40, noNaN: true }),
        (ev, previous) => {
          expect(exposureMultiplier(ev + 1)).toBeCloseTo(
            exposureMultiplier(ev) / 2,
            7,
          )
          const split = splitExposure(ev, previous)
          expect((split.pre * split.residual) / split.total).toBeCloseTo(1, 12)
        },
      ),
    )
  })

  it('quotes the lens saturation in cd/m²', () => {
    expect(
      1 / exposureMultiplier(exposureValue(LENS_PRESETS.flight)),
    ).toBeCloseTo(564.48, 8)
  })

  it('adapts at simulated time, composes intervals, and stays still at pause', () => {
    for (const target of [-6, 28]) {
      const first = adaptExposure(9, target, 0.25, 1)
      expect(adaptExposure(first, target, 0.75, 1)).toBeCloseTo(
        adaptExposure(9, target, 1, 1),
        12,
      )
      expect(adaptExposure(first, target, 0, 1)).toBe(first)
      expect(adaptExposure(first, target, -5, 1)).toBe(first)
    }
    expect(adaptExposure(9, 10, 0.4, 1)).toBeCloseTo(10 - Math.exp(-1), 12)
    expect(adaptExposure(9, 8, 3.5, 1)).toBeCloseTo(8 + Math.exp(-1), 12)
  })

  it('meters the lit subject without treating empty sky as a surface', () => {
    const count = histogram([
      ...Array<number>(900).fill(0),
      ...Array<number>(100).fill(0.3),
    ])
    const target = meterHistogram(count, 1 / 30_000, 9, DEFAULT_SENSOR_SETTINGS)
    expect(target.ev).toBeGreaterThan(11)
    expect(target.ev).toBeLessThan(16)
    expect(target.samples).toBe(100)
  })

  it('binds both comfort clamps and treats a clipped pixel as a lower bound', () => {
    const settings = {
      ...DEFAULT_SENSOR_SETTINGS,
      range: { bright: 8, dark: 4 },
    }
    expect(
      meterHistogram(histogram([65_504]), 1, 9, settings).ev,
    ).toBeLessThanOrEqual(17)
    expect(meterHistogram(histogram([1e-10]), 1, 9, settings).ev).toBe(5)
    expect(
      meterHistogram(histogram([Infinity]), 1, 9, settings).ev,
    ).toBeGreaterThan(16)
  })
})

it('applies a tightened comfort range even while adaptation is held', () => {
  const meter = new ExposureMeter()
  meter.update(LENS_PRESETS.flight, DEFAULT_SENSOR_SETTINGS, 0)
  const held = meter.update(
    LENS_PRESETS.flight,
    { ...DEFAULT_SENSOR_SETTINGS, rate: 0, range: { bright: 0, dark: 0 } },
    1,
  )
  expect(held.adapted).toBe(exposureValue(LENS_PRESETS.flight))
  expect(held.pre).toBe(held.total)
})

it('clears the reading and prior gain on reset, and labels only automatic frames metered', () => {
  const meter = new ExposureMeter()
  meter.measure(
    histogram([0.01]),
    1 / SURFACE_LUMINANCE,
    LENS_PRESETS.flight,
    DEFAULT_SENSOR_SETTINGS,
  )
  meter.update(LENS_PRESETS.flight, DEFAULT_SENSOR_SETTINGS, 0)
  meter.update(LENS_PRESETS.flight, DEFAULT_SENSOR_SETTINGS, 10)
  expect(
    meter.update(LENS_PRESETS.flight, DEFAULT_SENSOR_SETTINGS, 10, 0).metered,
  ).toBe(false)
  meter.reset()
  expect(meter.reading).toBeNull()
  const reset = meter.update(LENS_PRESETS.flight, DEFAULT_SENSOR_SETTINGS, 0)
  expect(reset.adapted).toBe(exposureForLuminance(SURFACE_LUMINANCE))
  expect(reset.metered).toBe(false)
})

it('keeps Natural at the production calibration when a dark subject fills the frame', () => {
  const meter = new ExposureMeter()
  meter.measure(
    histogram([0.006]),
    1 / SURFACE_LUMINANCE,
    LENS_PRESETS.flight,
    DEFAULT_SENSOR_SETTINGS,
  )
  meter.update(LENS_PRESETS.flight, DEFAULT_SENSOR_SETTINGS, 0)
  const natural = meter.update(LENS_PRESETS.flight, DEFAULT_SENSOR_SETTINGS, 30)
  expect(natural.adapted).toBe(exposureForLuminance(SURFACE_LUMINANCE))
  expect(natural.metered).toBe(false)
  const neutral = meter.update(
    LENS_PRESETS.flight,
    { ...DEFAULT_SENSOR_SETTINGS, curve: 'neutral' },
    60,
  )
  expect(neutral.adapted).toBeLessThan(natural.adapted - 2)
  expect(neutral.metered).toBe(true)
})
