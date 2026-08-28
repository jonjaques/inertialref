import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, vec3 } from '@inertialref/spatial'
import {
  FLIGHT_FOV,
  FOV_MAX,
  FOV_MIN,
  framingDistance,
  LENS_PRESETS,
  lensForFov,
  standoffRadii,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { openSession } from './session.ts'
import { placeShot, SHOTS } from './shots.ts'
import { TNG_INTRO, TNG_LENS } from './cutscenes/tngIntro.ts'

/*
 * Every shipped composition, held to the angle the lens gives back.
 *
 * This is the test that protects work nobody can redo cheaply. `tng-intro`'s
 * beats are fitted frame by frame against a reference edit and their criteria
 * are tests; the `SHOTS` bookmarks are each composed against a specific
 * photograph. The lens is a change of *representation* — 65° becomes 18.84 mm
 * on a 24 mm gauge — and the whole argument for keeping the odd focal lengths
 * rather than rounding to tidy ones is that the angle comes back out unchanged.
 * If it does not, the way that shows up is every framed body standing off by a
 * fraction of a percent for a reason that appears nowhere in the diff.
 *
 * "Unchanged" is stated with the number that makes it true rather than as an
 * adjective: the round trip through `atan(tan(θ/2))` is bit-exact for 70% of
 * the slider's range and never worse than 2.9e-14° over it, which is one part
 * in 1e15 of a framing distance — 7.5 nanometers at Earth's radius.
 */

/** What a framing distance may move by, relative. One part in a quadrillion. */
const FRAMING_TOLERANCE = 1e-14

describe('the angle the compositions were solved at', () => {
  it('is bit-identical for the cinematic lens', () => {
    // The one that cannot be allowed to drift at all: `tngIntro` solves every
    // beat against this number and a test holds each beat to a measured frame.
    expect(verticalFovDegrees(LENS_PRESETS.cinematic)).toBe(TNG_LENS.fov)
  })

  it('is within one ulp for the flight lens', () => {
    // 65.00000000000001. Not zero, and saying so is the point — the honest
    // claim is the bound below, not "bit-identical" applied to both.
    expect(verticalFovDegrees(LENS_PRESETS.flight)).toBeCloseTo(65, 12)
    expect(
      Math.abs(verticalFovDegrees(LENS_PRESETS.flight) - 65) / 65,
    ).toBeLessThan(FRAMING_TOLERANCE)
  })

  it('leaves every framing distance where it was', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 20, max: 110, noNaN: true }),
        fc.double({ min: 1e3, max: 7e8, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (degrees, radius, fill) => {
          const before = framingDistance(radius, degrees, fill)
          const after = framingDistance(
            radius,
            verticalFovDegrees(lensForFov(degrees)),
            fill,
          )
          expect(Math.abs(after - before) / before).toBeLessThan(
            FRAMING_TOLERANCE,
          )
        },
      ),
    )
  })
})

describe('the shot bookmarks', () => {
  it('are placed in body radii, so no lens can move them', () => {
    /*
     * The strongest form this claim can take, and it is a property of the
     * composition rather than of the conversion: a bookmark's standoff is a
     * multiple of the body's own radius, so the lens does not enter the
     * arithmetic at all. That is deliberate — `compositions.ts` argues it at
     * length — and it is exactly why the bookmarks survived a phase that moved
     * every other number about the camera. Pinned here because "the lens is not
     * an input" is easy to break by adding one.
     *
     * Stated over the seven that *declare* radii rather than over the whole
     * list, which is the honest form of it now that the two lists are one: a
     * drawn framing names a fill and is supposed to move with the lens, and
     * asserting otherwise over it would be asserting the opposite of its
     * design. The count is pinned so that a composition converted from radii
     * to fill cannot quietly leave this test with nothing to check.
     */
    const radius = 6_371_000
    const fixed = SHOTS.filter((shot) => shot.standoff.kind === 'radii')
    expect(fixed).toHaveLength(7)
    for (const shot of fixed) {
      for (const fov of [FOV_MIN, FLIGHT_FOV, FOV_MAX]) {
        const placed = placeShot(shot, radius, vec3(1, 0, 0), Infinity, fov)
        expect(Vec.length(placed.position) / radius).toBeCloseTo(
          standoffRadii(shot, fov),
          6,
        )
      }
    }
  })
})

describe('the cutscene', () => {
  it('takes every frame through the lens it was fitted at', () => {
    /*
     * Sampled across the whole edit rather than at one frame: the script has
     * eleven shots, and a lens applied per shot would be eleven chances to
     * introduce a second one. `toBe`, not `toBeCloseTo` — 45° round-trips
     * exactly, and the beats below it are solved against the literal number.
     */
    const session = openSession()
    const harness = session.harness
    harness.play('tng-intro')
    const fps = TNG_INTRO.fps
    for (let frame = 0; frame < TNG_INTRO.durationFrames; frame += 37) {
      const sample = harness.cutsceneSample(100 + frame / fps)
      expect(sample).not.toBeNull()
      expect(verticalFovDegrees(sample!.lens)).toBe(TNG_LENS.fov)
    }
    session.dispose()
  })
})
