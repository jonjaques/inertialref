import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { type Lens, LENS_PRESETS, exposureValue } from './lens.ts'
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
  CAMERA_MODES,
  PHOTOGRAPHIC_LOOKS,
  isSensorSettings,
  parseSensorSettings,
  resolveCameraPolicy,
  exposurePinnedToLens,
  type SensorSettings,
} from './exposure.ts'

const automatic: SensorSettings = {
  ...DEFAULT_SENSOR_SETTINGS,
  mode: 'automatic',
}

describe('the sensor exposure', () => {
  it('exposes a small bright disk amid nonempty faint sky', () => {
    const count = histogram([
      ...Array<number>(9900).fill(0.0001),
      ...Array<number>(100).fill(0.3),
    ])
    const target = meterHistogram(count, 1 / 30_000, 9, DEFAULT_SENSOR_SETTINGS)
    const disk = exposureForLuminance((0.3 * 30_000) / 0.6)
    expect(Math.abs(target.ev - disk)).toBeLessThan(0.5)
  })

  it('discards a prior reading when photographic time moves backward', () => {
    const meter = new ExposureMeter()
    const settings = automatic
    meter.update(LENS_PRESETS.flight, settings, 10)
    meter.measure(
      histogram([0.01]),
      1 / SURFACE_LUMINANCE,
      LENS_PRESETS.flight,
      settings,
    )
    expect(meter.update(LENS_PRESETS.flight, settings, 20).metered).toBe(true)
    expect(meter.update(LENS_PRESETS.flight, settings, 0).metered).toBe(false)
  })

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
  meter.update(LENS_PRESETS.flight, automatic, 0)
  const held = meter.update(
    LENS_PRESETS.flight,
    { ...automatic, rate: 0, range: { bright: 0, dark: 0 } },
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

it('keeps Enhanced at its surface calibration independently of look and comfort settings', () => {
  const meter = new ExposureMeter()
  for (const look of PHOTOGRAPHIC_LOOKS) {
    const settings = {
      ...DEFAULT_SENSOR_SETTINGS,
      look,
      range: { bright: 0, dark: 0 },
    }
    meter.measure(
      histogram([0.006]),
      1 / SURFACE_LUMINANCE,
      LENS_PRESETS.flight,
      settings,
    )
    const enhanced = meter.update(LENS_PRESETS.flight, settings, 30)
    expect(enhanced.effectiveEV).toBe(exposureForLuminance(SURFACE_LUMINANCE))
    expect(enhanced.metered).toBe(false)
    expect(enhanced.policy.processing).toBe('enhanced')
  }
})

it('changes photographic looks without selecting a different exposure policy', () => {
  for (const mode of CAMERA_MODES) {
    const baseline = resolveCameraPolicy(
      { ...DEFAULT_SENSOR_SETTINGS, mode },
      LENS_PRESETS.flight,
    )
    for (const look of PHOTOGRAPHIC_LOOKS) {
      const changed = resolveCameraPolicy(
        { ...DEFAULT_SENSOR_SETTINGS, mode, look },
        LENS_PRESETS.flight,
      )
      expect(changed).toEqual({ ...baseline, look })
    }
  }
})

it('uses one photographic processing policy for Automatic and Manual', () => {
  expect(resolveCameraPolicy(automatic, LENS_PRESETS.flight)).toMatchObject({
    processing: 'photographic',
    exposure: 'metered',
    fixedEV: null,
  })
  expect(
    resolveCameraPolicy({ ...automatic, mode: 'manual' }, LENS_PRESETS.flight),
  ).toMatchObject({
    processing: 'photographic',
    exposure: 'fixed',
    fixedEV: exposureValue(LENS_PRESETS.flight),
  })
})

it('pins photographic staging without changing the selected mode', () => {
  for (const mode of CAMERA_MODES) {
    const settings = { ...DEFAULT_SENSOR_SETTINGS, mode }
    const meter = new ExposureMeter()
    const pin = exposurePinnedToLens(LENS_PRESETS.cinematic)
    const frame = meter.update(LENS_PRESETS.cinematic, settings, 10, pin)
    expect(frame.mode).toBe(mode)
    expect(frame.override).toBe('staging')
    expect(frame.policy.processing).toBe('photographic')
    expect(frame.effectiveEV).toBeCloseTo(
      exposureValue(LENS_PRESETS.cinematic),
      12,
    )
    meter.measure(histogram([1000]), 1, LENS_PRESETS.cinematic, settings)
    expect(meter.update(LENS_PRESETS.cinematic, settings, 10, pin)).toEqual(
      frame,
    )
  }
})

it('discards meter targets across a mode switch and after staging is released', () => {
  const meter = new ExposureMeter()
  meter.update(LENS_PRESETS.flight, automatic, 0)
  meter.measure(
    histogram([0.01]),
    1 / SURFACE_LUMINANCE,
    LENS_PRESETS.flight,
    automatic,
  )
  expect(meter.update(LENS_PRESETS.flight, automatic, 1).metered).toBe(true)
  meter.update(LENS_PRESETS.flight, { ...automatic, mode: 'manual' }, 2)
  expect(meter.update(LENS_PRESETS.flight, automatic, 3).metered).toBe(false)
  meter.measure(
    histogram([0.01]),
    1 / SURFACE_LUMINANCE,
    LENS_PRESETS.flight,
    automatic,
  )
  meter.update(LENS_PRESETS.flight, automatic, 4, 0)
  expect(meter.update(LENS_PRESETS.flight, automatic, 5).metered).toBe(false)
})

it('holds Automatic exposure at pause while an asynchronous reading arrives', () => {
  const meter = new ExposureMeter()
  const before = meter.update(LENS_PRESETS.flight, automatic, 10)
  meter.measure(
    histogram([0.01]),
    1 / SURFACE_LUMINANCE,
    LENS_PRESETS.flight,
    automatic,
  )
  const after = meter.update(LENS_PRESETS.flight, automatic, 10)
  expect(after.effectiveEV).toBe(before.effectiveEV)
  expect(after.total).toBe(before.total)
})

it('applies compensation as gain over the lens without changing aperture, shutter or ISO', () => {
  const lens = Object.freeze({ ...LENS_PRESETS.flight })
  const meter = new ExposureMeter()
  const baseline = meter.update(lens, automatic, 0)
  const compensated = meter.update(
    lens,
    { ...automatic, compensation: 2, rate: 0 },
    0,
  )
  expect(compensated.effectiveEV).toBeCloseTo(baseline.effectiveEV - 2, 12)
  expect(compensated.total / baseline.total).toBeCloseTo(4, 12)
  expect(compensated.gain).toBeCloseTo(2 ** -compensated.auto, 12)
  expect(compensated.compensation).toBe(2)
  expect(lens).toEqual(LENS_PRESETS.flight)
})

it('Manual ignores the meter and follows the photographic stop arithmetic', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 1, max: 16, noNaN: true }),
      fc.double({ min: 0.0001, max: 1000, noNaN: true }),
      fc.double({ min: 100, max: 12800, noNaN: true }),
      (fStop, shutter, iso) => {
        const lens = { ...LENS_PRESETS.flight, fStop, shutter, iso } as Lens
        const settings = {
          ...automatic,
          mode: 'manual' as const,
          compensation: 8,
        }
        const meter = new ExposureMeter()
        meter.measure(histogram([1e5]), 1, lens, settings)
        const exposed = meter.update(lens, settings, 0)
        expect(exposed.gain).toBe(1)
        expect(exposed.metered).toBe(false)
        expect(exposed.compensation).toBe(0)
        expect(meter.update(lens, settings, 0)).toEqual(exposed)
        const doubledShutter = meter.update(
          { ...lens, shutter: (shutter * 2) as Lens['shutter'] },
          settings,
          1,
        )
        const doubledIso = meter.update({ ...lens, iso: iso * 2 }, settings, 2)
        const stoppedDown = meter.update(
          { ...lens, fStop: fStop * Math.SQRT2 },
          settings,
          3,
        )
        expect(doubledShutter.total / exposed.total).toBeCloseTo(2, 12)
        expect(doubledIso.total / exposed.total).toBeCloseTo(2, 12)
        expect(stoppedDown.total / exposed.total).toBeCloseTo(0.5, 12)
      },
    ),
  )
})

it('meters a sparse sky and maps all-dark or empty frames to the dark limit', () => {
  const pre = 1 / SURFACE_LUMINANCE
  const sparse = meterHistogram(
    histogram([...Array<number>(10000).fill(0), 0.01, 0.02, 0.04]),
    pre,
    9,
    automatic,
  )
  expect(sparse.samples).toBe(3)
  expect(sparse.luminance).toBeGreaterThan(300)
  expect(sparse.luminance).toBeLessThan(1300)
  for (const samples of [[], [0, 0, 0], [1e-10, 1e-20]]) {
    const reading = meterHistogram(histogram(samples), pre, 9, automatic)
    expect(reading).toEqual({
      ev: 9 - automatic.range.dark,
      samples: 0,
      luminance: 0,
    })
  }
})

it('rejects malformed imports instead of guessing a camera mode', () => {
  expect(isSensorSettings(DEFAULT_SENSOR_SETTINGS)).toBe(true)
  expect(parseSensorSettings(DEFAULT_SENSOR_SETTINGS)).toEqual(
    DEFAULT_SENSOR_SETTINGS,
  )
  for (const invalid of [
    null,
    [],
    {},
    { ...DEFAULT_SENSOR_SETTINGS, mode: 'future' },
    { ...DEFAULT_SENSOR_SETTINGS, look: 'natural' },
    { ...DEFAULT_SENSOR_SETTINGS, compensation: NaN },
    { ...DEFAULT_SENSOR_SETTINGS, compensation: 9 },
    { ...DEFAULT_SENSOR_SETTINGS, response: 'direct' },
    { ...DEFAULT_SENSOR_SETTINGS, range: { bright: 1, dark: 1, spare: 1 } },
  ]) {
    expect(isSensorSettings(invalid)).toBe(false)
    expect(parseSensorSettings(invalid)).toBeNull()
  }
})
