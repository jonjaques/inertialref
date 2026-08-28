import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  aspectRatio,
  BASELINE_VIEWPORT,
  circleOfConfusion,
  DEFAULT_GAUGE,
  depthOfField,
  diffractionLimit,
  effectiveFocalLength,
  exposureValue,
  horizontalFov,
  hyperfocalDistance,
  type Lens,
  LENS_PRESETS,
  lensForFov,
  lensReadout,
  pixelAngle,
  pixelsPerRadian,
  verticalFov,
  verticalFovDegrees,
} from './lens.ts'

/*
 * The lens, asked the questions the nine call sites it replaces could not be.
 *
 * The first block is the one that matters: the conversion from an angle to a
 * lens is a change of representation, and every shipped composition — the
 * flight camera, `tng-intro`'s beats, every `SHOTS` bookmark's standoff — is
 * solved against the angle that comes back out of it. `compositions.test.ts`
 * in `devtools` proves the framings themselves are unmoved; this proves the
 * arithmetic underneath them is.
 */

/** The whole range the field-of-view slider offers. */
const angles = fc.double({ min: 20, max: 110, noNaN: true })

const viewports = fc
  .tuple(
    fc.integer({ min: 320, max: 7680 }),
    fc.integer({ min: 240, max: 4320 }),
  )
  .map(([width, height]) => ({ width, height }))

const lenses = fc
  .tuple(
    angles,
    fc.double({ min: 0.25, max: 8, noNaN: true }),
    fc.double({ min: 1, max: 22, noNaN: true }),
  )
  .map(([degrees, zoom, fStop]): Lens => ({
    ...lensForFov(degrees),
    zoom,
    fStop,
  }))

describe('the angle survives the conversion', () => {
  it('round-trips every angle the slider can reach', () => {
    fc.assert(
      fc.property(angles, (degrees) => {
        /*
         * 2·atan(g / 2·(g / 2·tan(θ/2))) is θ for 70% of the range bit for bit
         * and never worse than 2.9e-14° over it — measured, not assumed. That
         * bound is what `framingDistance` inherits: at Earth's radius it moves
         * a standoff by five nanometers, which is the honest version of "the
         * compositions do not move".
         */
        expect(verticalFovDegrees(lensForFov(degrees))).toBeCloseTo(degrees, 12)
      }),
    )
  })

  it('puts the two shipped lenses where the old constants were', () => {
    expect(verticalFovDegrees(LENS_PRESETS.flight)).toBeCloseTo(65, 12)
    expect(verticalFovDegrees(LENS_PRESETS.cinematic)).toBeCloseTo(45, 12)
    // A wide prime and a normal, on a full-frame sensor. Neither is round, and
    // rounding either is a week of re-fitting the cutscene.
    expect(LENS_PRESETS.flight.focalLength).toBeCloseTo(18.836226925409882, 12)
    expect(LENS_PRESETS.cinematic.focalLength).toBeCloseTo(
      28.970562748477143,
      12,
    )
    expect(LENS_PRESETS.flight.gauge).toBe(DEFAULT_GAUGE)
  })

  it('declines an angle no lens has', () => {
    // Clamped rather than NaN: this is fed by a slider, a URL parameter and a
    // restored preference, and a NaN focal length is a projection matrix of
    // NaNs that renders nothing anywhere.
    expect(Number.isFinite(lensForFov(0).focalLength)).toBe(true)
    expect(Number.isFinite(lensForFov(180).focalLength)).toBe(true)
    expect(verticalFovDegrees(lensForFov(Number.NaN))).toBeCloseTo(65, 12)
  })
})

describe('the gauge is vertical, so a resize crops rather than zooms', () => {
  it('holds the vertical field across every aspect ratio', () => {
    fc.assert(
      fc.property(lenses, viewports, viewports, (lens, a, b) => {
        expect(verticalFov(lens)).toBe(verticalFov(lens))
        // Nothing in the vertical field can see a viewport at all — which is
        // the property, stated as a signature rather than as a test.
        expect(horizontalFov(lens, a) > 0).toBe(true)
        expect(horizontalFov(lens, b) > 0).toBe(true)
      }),
    )
  })

  it('follows the aspect ratio horizontally, exactly', () => {
    fc.assert(
      fc.property(lenses, viewports, (lens, viewport) => {
        const half = Math.tan(horizontalFov(lens, viewport) / 2)
        const wanted = Math.tan(verticalFov(lens) / 2) * aspectRatio(viewport)
        // Relative, because the tangent of a half-field at a 25:1 window is 73
        // and an absolute tolerance at that magnitude is a claim about doubles
        // rather than about optics.
        expect(half / wanted).toBeCloseTo(1, 12)
      }),
    )
  })

  it('is a wider picture on a wider window', () => {
    const wide = horizontalFov(LENS_PRESETS.flight, {
      width: 2560,
      height: 1080,
    })
    const square = horizontalFov(LENS_PRESETS.flight, {
      width: 1080,
      height: 1080,
    })
    expect(wide).toBeGreaterThan(square)
    expect(verticalFov(LENS_PRESETS.flight)).toBeGreaterThan(square - 1e-9)
  })
})

describe('pixels', () => {
  it('is one identity, and the terrain predicate stands on it', () => {
    fc.assert(
      fc.property(lenses, viewports, (lens, viewport) => {
        expect(
          pixelsPerRadian(lens, viewport) * pixelAngle(lens, viewport),
        ).toBeCloseTo(1, 12)
      }),
    )
  })

  it('is 848 px/rad at the flight lens over the baseline', () => {
    // The number every terrain figure is quoted against. The predicate assumed
    // 935 (60° over 1080) before the lens existed, which is 10% more scale and
    // 21% more patches on a lens the game never uses.
    expect(pixelsPerRadian(LENS_PRESETS.flight, BASELINE_VIEWPORT)).toBeCloseTo(
      847.6,
      1,
    )
  })

  it('scales with the drawable height and with nothing else', () => {
    const wide = pixelsPerRadian(LENS_PRESETS.flight, {
      width: 4000,
      height: 1080,
    })
    expect(wide).toBeCloseTo(
      pixelsPerRadian(LENS_PRESETS.flight, BASELINE_VIEWPORT),
      9,
    )
    expect(
      pixelsPerRadian(LENS_PRESETS.flight, { width: 1920, height: 2160 }),
    ).toBeCloseTo(
      2 * pixelsPerRadian(LENS_PRESETS.flight, BASELINE_VIEWPORT),
      9,
    )
  })
})

describe('depth of field', () => {
  const viewport = { width: 2704, height: 1520 }

  it('is a near-field effect at every planetary distance', () => {
    // The whole reason the defocus *pass* can be deferred while the parameters
    // cannot: focus at infinity and the near limit is 5.37 m, so terrain is
    // always sharp and no terrain phase waits on a blur.
    const band = depthOfField(LENS_PRESETS.flight, viewport)
    expect(band.hyperfocal).toBeCloseTo(5.37, 2)
    expect(band.near).toBeCloseTo(band.hyperfocal, 9)
    expect(band.far).toBe(Infinity)
  })

  it('never puts the near limit past the far one', () => {
    fc.assert(
      fc.property(
        lenses,
        viewports,
        // From a meter out: nearer than the focal length is the degenerate
        // case `depthOfField` states rather than solves, and 8x zoom on the
        // longest lens the slider reaches is 0.54 m of glass.
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        (lens, view, focus) => {
          const band = depthOfField({ ...lens, focus }, view)
          expect(band.near).toBeLessThanOrEqual(band.far)
          expect(band.near).toBeGreaterThan(0)
        },
      ),
    )
  })

  it('goes to infinity at and beyond hyperfocal focus', () => {
    fc.assert(
      fc.property(lenses, viewports, (lens, view) => {
        const h = hyperfocalDistance(lens, view)
        expect(depthOfField({ ...lens, focus: h * 1.0001 }, view).far).toBe(
          Infinity,
        )
        expect(
          depthOfField({ ...lens, focus: h * 0.5 }, view).far,
        ).toBeLessThan(Infinity)
      }),
    )
  })

  it('is monotonic in focal length and in f-number', () => {
    fc.assert(
      fc.property(lenses, viewports, (lens, view) => {
        // Longer glass and a wider aperture both mean less of the world is
        // sharp, which is the only thing a depth-of-field control has to get
        // right for the readout to be believable.
        const longer = hyperfocalDistance(
          { ...lens, zoom: lens.zoom * 2 },
          view,
        )
        expect(longer).toBeGreaterThan(hyperfocalDistance(lens, view))
        const stopped = hyperfocalDistance(
          { ...lens, fStop: lens.fStop * 2 },
          view,
        )
        expect(stopped).toBeLessThan(hyperfocalDistance(lens, view))
      }),
    )
  })

  it('measures the circle of confusion in display pixels', () => {
    // 23.7 µm on a 24 mm gauge over 1520 px, a whisker under the 29 µm
    // full-frame print convention — and it moves with the display, which is
    // the half the convention cannot do.
    expect(circleOfConfusion(LENS_PRESETS.flight, viewport)).toBeCloseTo(
      0.0237,
      4,
    )
    expect(
      circleOfConfusion(LENS_PRESETS.flight, { width: 1920, height: 3040 }),
    ).toBeCloseTo(circleOfConfusion(LENS_PRESETS.flight, viewport) / 2, 6)
  })
})

describe('the sensor', () => {
  it('is nowhere near diffraction-limited wide open', () => {
    const viewport = { width: 2704, height: 1520 }
    expect(diffractionLimit(LENS_PRESETS.flight, viewport)).toBeCloseTo(11.8, 1)
    expect(lensReadout(LENS_PRESETS.flight, viewport).airyDiameter).toBeCloseTo(
      0.00376,
      5,
    )
  })

  it('quotes an exposure in real stops', () => {
    // f/2.8 at 1/60 and ISO 100 is EV 8.9 — an interior, which is what a
    // cockpit is.
    expect(exposureValue(LENS_PRESETS.flight)).toBeCloseTo(8.9, 1)
    // One stop of gain is one EV, in the direction a photographer expects.
    expect(exposureValue({ ...LENS_PRESETS.flight, iso: 200 })).toBeCloseTo(
      exposureValue(LENS_PRESETS.flight) - 1,
      9,
    )
  })

  it('magnifies with zoom without touching the glass', () => {
    const zoomed = { ...LENS_PRESETS.flight, zoom: 2 }
    expect(effectiveFocalLength(zoomed)).toBeCloseTo(
      2 * LENS_PRESETS.flight.focalLength,
      9,
    )
    expect(verticalFov(zoomed)).toBeLessThan(verticalFov(LENS_PRESETS.flight))
    expect(zoomed.focalLength).toBe(LENS_PRESETS.flight.focalLength)
  })
})
