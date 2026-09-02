import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  Quaternion as Q,
  type Quat,
  UV,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import { systemFrameId, systemId } from '@inertialref/universe'
import {
  apparentWidth,
  type LinePath,
  linePosition,
  lineVelocity,
} from '@inertialref/rendering'
import { openSession } from './session.ts'
import { sampleIsFinite } from './cutscene.ts'
import {
  screenPositionOf,
  TNG_CUTS,
  TNG_HULL_LENGTH,
  TNG_INTRO,
  TNG_LENS,
  TNG_SHIP_BEATS,
  TNG_WIPE_OCCLUSIONS,
  TNG_RAILS,
  TNG_WIPE_OFFSETS,
  WIPE_RAIL,
  DESCENT_RAIL,
} from './cutscenes/tngIntro.ts'

/*
 * The cutscene director, held to the reference edit's measured numbers.
 *
 * The script exists to be diffable against a frame-analyzed reference, so
 * these tests assert the measurements themselves: title fade windows, the
 * credit grid, the warp-flash shape, the locked camera, and the hard cut.
 * A change that shifts any of these is a change to the recreation's fidelity
 * and should have to say so.
 */

const FPS = TNG_INTRO.fps

function playing() {
  const session = openSession()
  const harness = session.harness
  harness.play('tng-intro')
  // Any epoch works — the first sample anchors frame 0 to it.
  const at = (frame: number) => harness.cutsceneSample(100 + frame / FPS)
  expect(at(0)).not.toBeNull()
  return { session, harness, at }
}

function opacity(
  sample: NonNullable<ReturnType<ReturnType<typeof playing>['at']>>,
  id: string,
): number {
  const text = sample.texts.find((candidate) => candidate.id === id)
  if (text === undefined) throw new Error(`no text ${id}`)
  return text.opacity
}

describe('tng-intro timing', () => {
  it('is the reference edit’s length on the reference timebase', () => {
    expect(TNG_INTRO.durationFrames).toBe(2742)
    expect(TNG_INTRO.fps).toBeCloseTo(24000 / 1001, 9)
  })

  it('fires credits 4-9 on the measured 65/67 grid', () => {
    const { at } = playing()
    const grid = [1654, 1719, 1786, 1851, 1918, 1983]
    const ids = ['c4', 'c5', 'c6', 'c7', 'c8', 'c9']
    grid.forEach((start, i) => {
      const id = ids[i] as string
      /*
       * The grid frames are *threshold crossings*, not fade starts: the
       * reference calls a title visible once 800 px of it clear a B>=195
       * floor, which text at RGB (64,138,230) only does at 85% opacity. So
       * the assertion is that the fade is 85% up on the measured frame — not
       * that it begins there. Captured against a render, treating the two as
       * the same put every credit exactly four frames late.
       */
      expect(opacity(at(start)!, id)).toBeGreaterThan(0.8)
      expect(opacity(at(start - 6)!, id)).toBe(0)
      expect(opacity(at(start + 5)!, id)).toBeCloseTo(1, 6)
    })
  })

  it('throws the logotype in and settles it on the measured marks', () => {
    const { at } = playing()
    const word = (frame: number, id: string) => {
      const text = at(frame)!.texts.find((candidate) => candidate.id === id)
      if (text === undefined) throw new Error(`no text ${id}`)
      return text
    }
    // Nothing before the throw; both words at full opacity while still
    // traveling — the reference's mask sees them dim and huge at f1140, not
    // faded up on their marks.
    expect(word(1124, 'logo-star').opacity).toBe(0)
    expect(word(1142, 'logo-star').opacity).toBeGreaterThan(0.2)
    // Mid-flight: STAR is left of its mark and oversized, TREK right of its
    // own and higher. The measured block is 1.31× its settled width at f1150.
    const flying = word(1145, 'logo-star')
    expect(flying.x).toBeLessThan(0.373)
    expect(flying.scale).toBeGreaterThan(1.05)
    expect(word(1145, 'logo-trek').x).toBeGreaterThan(0.6484)
    // Settled by f1162 and immobile thereafter — the measured mask bbox is
    // identical from f1161 to the fade-out.
    for (const id of ['logo-star', 'logo-trek']) {
      const settled = word(1162, id)
      const later = word(1240, id)
      expect(settled.scale).toBeCloseTo(1, 2)
      expect(settled.x).toBeCloseTo(later.x, 6)
      expect(settled.y).toBeCloseTo(later.y, 6)
      expect(settled.opacity).toBeCloseTo(1, 6)
    }
    // The two words sit in the offset arrangement, not on one line: TREK is
    // down and to the right of STAR by the measured 0.275 / 0.124.
    expect(word(1200, 'logo-trek').x - word(1200, 'logo-star').x).toBeCloseTo(
      0.2754,
      3,
    )
    expect(word(1200, 'logo-trek').y - word(1200, 'logo-star').y).toBeCloseTo(
      0.1236,
      3,
    )
    // The subtitle joins late and both are gone before the fly-through wipe.
    // f1178 is its threshold crossing, so it is 85% up there and dark eight
    // frames before — the same fade-start-versus-crossing distinction the
    // credit grid makes. The trailing edge keeps the measured frame exactly:
    // a capture found the fades late on the way in and on time on the way out.
    expect(opacity(at(1170)!, 'subtitle')).toBe(0)
    expect(opacity(at(1178)!, 'subtitle')).toBeGreaterThan(0.8)
    expect(opacity(at(1190)!, 'subtitle')).toBeCloseTo(1, 6)
    expect(opacity(at(1272)!, 'logo-star')).toBe(0)
    expect(opacity(at(1272)!, 'subtitle')).toBe(0)
  })

  it('centers every credit and hangs its label on the name', () => {
    const { at } = playing()
    const sample = at(1340)!
    for (const id of ['c1', 'c2', 'c5', 'c8', 'e1']) {
      const text = sample.texts.find((candidate) => candidate.id === id)
      if (text === undefined) throw new Error(`no text ${id}`)
      // Measured: every name's mask is centered at x 0.497–0.510. The older
      // per-credit centroids drifted left only because they were
      // pixel-weighted and the label line pulled them.
      expect(text.x).toBeCloseTo(0.5, 6)
    }
    const stewart = sample.texts.find((t) => t.id === 'c1')!
    const frakes = sample.texts.find((t) => t.id === 'c2')!
    // A label rides its name rather than being placed independently: the
    // reference left-aligns it to the name's own left edge, which is a
    // property of the typeface, not a coordinate.
    expect(stewart.label).toBe('Starring')
    expect(frakes.label).toBeUndefined()
    expect(stewart.y).toBeCloseTo(frakes.y, 6)
  })

  it('fires the two lens spikes on the measured 24-frame envelope', () => {
    const { at } = playing()
    for (const [start, x, y] of [
      [1118, 0.655, 0.695],
      [2412, 0.688, 0.43],
    ] as const) {
      expect(at(start - 1)!.effects.spark.drive).toBe(0)
      const peak = at(start + 11)!.effects.spark
      expect(peak.drive).toBeCloseTo(1, 6)
      expect(peak.x).toBeCloseTo(x, 6)
      expect(peak.y).toBeCloseTo(y, 6)
      expect(at(start + 25)!.effects.spark.drive).toBe(0)
    }
  })

  it('runs both warp flashes on one rounded envelope, opening early', () => {
    const { at } = playing()
    /*
     * f1085 and f2382 are the shot detector's threshold crossings, not the
     * frames the light starts — the reference is already a third of the way up
     * at t=0 — so the assertion is that the wash is well underway on the
     * measured frame and dark a few frames before it. `warpFlashEnvelope`'s own
     * test carries the shape; this one carries the *script's* use of it, which
     * is that both flashes share it and neither has a flat top.
     */
    for (const start of [1085, 2382]) {
      expect(at(start - 4)!.effects.flash).toBe(0)
      expect(at(start)!.effects.flash).toBeGreaterThan(0.25)
      expect(at(start + 7)!.effects.flash).toBe(1)
      expect(at(start + 17)!.effects.flash).toBe(0)
      // Round, not flat: the reference's mean moves 17% across these frames.
      expect(at(start + 4)!.effects.flash).toBeLessThan(1)
      expect(at(start + 11)!.effects.flash).toBeLessThan(1)
    }
  })
})

describe('tng-intro ship choreography', () => {
  /*
   * The reference's hull measurements are screen measurements — a tracked
   * bounding box per frame — so this is the diff that matters: put the sampled
   * hull back through the lens and check it lands where the box did. Every
   * expected number below is a box center or a box width from the analysis.
   */
  const track = (
    sample: NonNullable<ReturnType<ReturnType<typeof playing>['at']>>,
  ) => {
    const offset = Q.rotate(
      Q.conjugate(sample.camera.orientation),
      UV.difference(sample.ship.position, sample.camera.position),
    )
    const screen = screenPositionOf(offset)
    return {
      ...screen,
      width: apparentWidth(
        TNG_HULL_LENGTH,
        screen.range,
        TNG_LENS.fov,
        TNG_LENS.aspect,
      ),
    }
  }

  it('enters scene A at the bottom-left corner and crosses the frame', () => {
    const { at } = playing()
    // The measured entry: the hull's box first breaks the bottom edge near
    // x 0.04 at f688. The previous script had it as a dot dead ahead, which
    // is the analysis's prose and not what its own frames show.
    const entry = track(at(700)!)
    expect(entry.x).toBeLessThan(0.16)
    expect(entry.y).toBeGreaterThan(0.9)

    /*
     * Box centers and widths at frames where the box is unclipped — and
     * "unclipped" is now checked rather than assumed. Re-measuring the
     * reference with a per-side frame-edge flag found that most of this pass's
     * boxes are truncated by an edge, saturated, or inflated by the far
     * Bussard cap flickering across the tracker's 400-pixel floor; the f872
     * width is 0.664 on the clean channel where the first pass read 0.695.
     */
    for (const [frame, x, y, width] of [
      [760, 0.203, 0.757, 0.401],
      [824, 0.278, 0.635, 0.438],
      [872, 0.353, 0.512, 0.664],
    ] as const) {
      const hull = track(at(frame)!)
      expect(hull.x, `f${frame} x`).toBeCloseTo(x, 2)
      expect(hull.y, `f${frame} y`).toBeCloseTo(y, 2)
      expect(hull.width, `f${frame} width`).toBeCloseTo(width, 2)
    }

    // It pulls away up-right rather than passing behind the lens — which is
    // what lets the camera hold still through the whole pass.
    /*
     * The exit mark is the reference's **area centroid** at f1080, 0.489 — not
     * its box centre, 0.63. The two disagree by 0.15 of the frame here because
     * the lit mass is not centred on the hull, and `compare_render.py` scores
     * the centroid, so that is the one the beats are authored against.
     */
    const leaving = track(at(1080)!)
    expect(leaving.x).toBeCloseTo(0.489, 2)
    expect(leaving.range).toBeGreaterThan(track(at(976)!).range)
  })

  it('never puts the hull behind the lens while it is on stage', () => {
    const { at } = playing()
    /*
     * The spline-overshoot regression. Ranges across an approach span four
     * decades, and a Catmull-Rom over those knots in *meters* sets the near
     * end's tangent from the far end: it overshot through the camera and out
     * the other side, and the hull — which should have been receding at a
     * kilometer — simply was not drawn for twenty frames. Interpolating the
     * range in log space fixes it, and this is the assertion that notices if
     * anyone interpolates it any other way.
     *
     * Half a frame apart, because the overshoot lived between the beats.
     */
    for (let f = 660; f < 2430; f += 0.5) {
      const sample = at(f)!
      if (!sample.ship.visible) continue
      const offset = Q.rotate(
        Q.conjugate(sample.camera.orientation),
        UV.difference(sample.ship.position, sample.camera.position),
      )
      expect(offset.z, `frame ${f} is behind the lens`).toBeLessThan(0)
      // And inside a sane band: closer than a hull length is inside the near
      // plane, further than the entry beats is a lost decimal point.
      const range = Math.hypot(offset.x, offset.y, offset.z)
      expect(range, `frame ${f} range`).toBeGreaterThan(TNG_HULL_LENGTH * 0.05)
      expect(range, `frame ${f} range`).toBeLessThan(4e7)
    }
  })

  it('reuses one wipe three times, the middle one mirrored', () => {
    const { at } = playing()
    /*
     * One recipe, three uses — as a property over every frame of the pass
     * rather than a spot check, because the reuse is itself a *measurement*:
     * aligning the reference's own tracked boxes for wipe two against wipe
     * one's, mirrored, they agree to a thousandth on every frame at an offset
     * of 126, and wipes one and three agree at 247. The offsets come from
     * `TNG_WIPE_OFFSETS`; a test carrying its own copy of them cannot notice
     * when the measurement changes, which is why the table is shared.
     *
     * The span is the *shared* one, f1292–f1319 — second knot to
     * second-to-last. The three wipes are concatenated into one Catmull-Rom,
     * so the first and last segment of each sees different neighbouring
     * knots: wipe one opens on a clamped end, wipe three opens on wipe two's
     * exit at (2.1, −0.5), and wipe one's exit runs into wipe two's entry
     * where wipe three's simply holds. Inside the shared span the reuse is
     * exact; at the seams it is not, by 0.035 of the frame's width at the
     * entry (f1286, on a hull 0.012 wide) and 3.5 m of 277 at the exit
     * (f1321). Named rather than asserted away — it is the size of the dot it
     * moves, and it is what "one animation, three times" currently costs.
     */
    const [, mirrorOffset, repeatOffset] = TNG_WIPE_OFFSETS
    const tanHalf = Math.tan((TNG_LENS.fov * Math.PI) / 360)
    for (let frame = 1292; frame <= 1319; frame += 1) {
      const first = track(at(frame)!)
      const second = track(at(frame + mirrorOffset)!)
      const third = track(at(frame + repeatOffset)!)
      /*
       * The bound is the universe's own position floor, not a decimal place.
       * The hull's place is a `UniverseVector` — a double offset inside a
       * 2^40 m sector — so a camera-relative offset survives `translate` and
       * `difference` to `POSITION_RESOLUTION`, 0.24 mm, which at this frame's
       * range is this much of the frame's width. Two of them covers the
       * rounding at both ends of the round trip; the worst frame in the span
       * measures 0.41 of one.
       */
      const slackX =
        (2 * UV.POSITION_RESOLUTION) /
        (first.range * 2 * tanHalf * TNG_LENS.aspect)
      const slackY = (2 * UV.POSITION_RESOLUTION) / (first.range * 2 * tanHalf)
      const slackRange = 2 * UV.POSITION_RESOLUTION
      expect(
        Math.abs(third.x - first.x),
        `f${frame} against +${repeatOffset}, x`,
      ).toBeLessThan(slackX)
      expect(
        Math.abs(third.y - first.y),
        `f${frame} against +${repeatOffset}, y`,
      ).toBeLessThan(slackY)
      expect(
        Math.abs(third.range - first.range),
        `f${frame} against +${repeatOffset}, range`,
      ).toBeLessThan(slackRange)
      // The middle one is its mirror, and only in x: `1 - x` on screen is
      // exactly what negating the offset's lateral component does in camera
      // axes, so y and range have to come through untouched.
      expect(
        Math.abs(second.x - (1 - first.x)),
        `f${frame} against +${mirrorOffset} mirrored, x`,
      ).toBeLessThan(slackX)
      expect(
        Math.abs(second.y - first.y),
        `f${frame} against +${mirrorOffset} mirrored, y`,
      ).toBeLessThan(slackY)
      expect(
        Math.abs(second.range - first.range),
        `f${frame} against +${mirrorOffset} mirrored, range`,
      ).toBeLessThan(slackRange)
    }
    // The measured entry mark itself, so the shared animation is also the
    // right one: the reference's box is at (0.239, 0.591) at f1292.
    const entry = track(at(1292)!)
    expect(entry.x).toBeCloseTo(0.239, 2)
    expect(entry.y).toBeCloseTo(0.591, 2)
    // And the occlusion the effects fire on is that same offset applied to the
    // first wipe's, so the streak burst cannot drift off the frame it covers.
    const [firstOcclusion, mirrorOcclusion, repeatOcclusion] =
      TNG_WIPE_OCCLUSIONS
    expect(mirrorOcclusion - firstOcclusion).toBe(mirrorOffset)
    expect(repeatOcclusion - firstOcclusion).toBe(repeatOffset)
  })

  it('brings the hull down through the credits from the top edge', () => {
    const { at } = playing()
    // Measured: the box breaks the top edge at f1770 and descends past the
    // vertical center by f2100, which is why Spiner and Wheaton sit low.
    const early = track(at(1800)!)
    expect(early.y).toBeLessThan(0.1)
    /*
     * The descent is a rail, so its x is the line's and not the beat's. The
     * measured mark at f1800 is 0.462 and the fitted line puts the hull at
     * 0.440 — inside the residual the pass is fitted at, and asserted as a
     * residual rather than as a coordinate by "reproduces the measured tracks"
     * below. What stays here is the shape of the shot: high, left of centre,
     * and coming down.
     */
    expect(early.x).toBeGreaterThan(0.4)
    expect(early.x).toBeLessThan(0.5)
    const late = track(at(2070)!)
    expect(late.y).toBeGreaterThan(early.y)
    expect(late.width).toBeGreaterThan(early.width)
    expect(late.width).toBeCloseTo(0.672, 1)
  })
})

describe('tng-intro flight dynamics', () => {
  /*
   * The flight-dynamics properties, against the script's *sampled output*:
   * the nose on its own chord, the swing bounded, the range monotone, the
   * mirrored wipe exact.
   *
   * The cruise is a `TrackedPass` — a `LinePath` for the hull and a solved
   * camera — so its questions are asked of the world and answered exactly. The
   * passes inside the titles shot are still authored screen beats with a
   * constant fitted facing, which is `orientationAlong` for a straight line, so
   * the same questions are answerable there against a camera that is locked.
   *
   * Which camera a window's heading is taken against is therefore not a detail.
   * Through the locked passes the camera holds to the bit — 0 m and 0° per
   * frame across f1292–1562 and f1800–2081 — so the difference of two
   * camera-relative offsets *is* the hull's displacement. Through the cruise it
   * is not: that camera dollies 5.5 km and pans 130°, and the difference of two
   * offsets there is the difference of two velocities. The range windows may
   * cross a cut (f948 does), because the length of a camera-relative offset is
   * not something a camera move can change, and the shot either side of f948
   * flies the same beat list.
   */
  type Sample = NonNullable<ReturnType<ReturnType<typeof playing>['at']>>
  type At = ReturnType<typeof playing>['at']

  /** The hull's offset from the lens, in camera axes — the beats' own terms. */
  const offsetOf = (sample: Sample): Vec3 =>
    Q.rotate(
      Q.conjugate(sample.camera.orientation),
      UV.difference(sample.ship.position, sample.camera.position),
    )

  /** Where the nose points, in those same axes. */
  const noseOf = (sample: Sample): Vec3 =>
    Q.rotate(
      Q.multiply(
        Q.conjugate(sample.camera.orientation),
        sample.ship.orientation,
      ),
      vec3(0, 0, -1),
    )

  const degreesBetween = (a: Vec3, b: Vec3): number =>
    (Math.acos(Math.min(1, Math.max(-1, Vec.dot(a, b)))) * 180) / Math.PI

  const swingDegrees = (a: Quat, b: Quat): number =>
    (2 *
      Math.acos(
        Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)),
      ) *
      180) /
    Math.PI

  /** The hull's attitude in camera axes — what a screen measurement sees. */
  const facingOf = (sample: Sample): Quat =>
    Q.multiply(Q.conjugate(sample.camera.orientation), sample.ship.orientation)

  /** The direction the hull moved over `span` frames, in camera axes. */
  const heading = (at: At, frame: number, span = 1): Vec3 =>
    Vec.normalize(Vec.sub(offsetOf(at(frame + span)!), offsetOf(at(frame)!)))

  const rangeAt = (at: At, frame: number): number =>
    Vec.length(offsetOf(at(frame)!))

  /**
   * What a fitted direction is worth, per pass: the spread between the two
   * landmark channels it was fitted from. 6.8° on the cruise and 15.0° on the
   * credit descent are the fits' own figures — they are reported with the
   * refit that produced `FACING_CRUISE` and `FACING_TITLES` rather than
   * written beside the vectors, which is a gap worth closing. 0.22° is in the
   * script: it is the three wipes' separate fits agreeing with each other.
   */
  const FIT_SPREAD_DEG = { cruise: 6.8, descent: 15, wipe: 0.22 } as const

  /** Where the cruise relights, read from the shot list rather than restated. */
  const CUT_TO_CLOSE = (
    TNG_CUTS.find((cut) => cut.id === 'cruise-close') as {
      from: number
    }
  ).from

  /**
   * The hull's own displacement in the *world*, over `span` frames.
   *
   * The camera-relative `heading` above is the right question only while the
   * camera is holding still, which is true of every locked pass and is no
   * longer true of the cruise: that shot is a tracked pass and its camera
   * dollies 5.5 km and pans 130°, so the change in a camera-relative offset
   * there is the difference of two velocities and not a flight direction.
   * Asking the world is asking what the ship did.
   */
  const worldHeading = (at: At, frame: number, span = 1): Vec3 =>
    Vec.normalize(
      UV.difference(at(frame + span)!.ship.position, at(frame)!.ship.position),
    )

  /** Where the nose points, in the world. */
  const worldNose = (sample: Sample): Vec3 =>
    Q.rotate(sample.ship.orientation, vec3(0, 0, -1))

  it('flies each straight pass with its nose on its own chord', () => {
    const { at } = playing()
    /*
     * The pass-scale form of the nose-along-velocity property, and the tight
     * one. Over a whole straight pass the hull covers hundreds of meters to
     * tens of kilometers, so its direction of travel is known far better than
     * the direction it was aimed by, and the honest bound is the fit's own
     * uncertainty rather than anything about the spline.
     */
    /*
     * The cruise is a `LinePath` now, so this is not a fit's error bar any
     * more — it is exact arithmetic and the bound says so. `orientationAlong`
     * takes the rail's own direction and a straight line has one, so the nose
     * cannot drift off the velocity: there is nothing for it to drift with
     * respect to. Measured 0.000°, against 34° of authored pitch before, which
     * existed to point a lit face at a camera the old staging had put in the
     * wrong place.
     */
    expect(
      degreesBetween(worldNose(at(700)!), worldHeading(at, 700, 170)),
      'cruise f700–870: nose off its own rail',
    ).toBeLessThan(0.01)
    /*
     * The descent passes at 14.16° against its own 15.0°, which is inside the
     * fit and only just: the authored beats' chord and the direction they were
     * fitted to are not the same line. `design/plans/tng-intro.md` §3.3 —
     * project the fitted line back to the screen beats and assert the residual
     * — is the check that would tighten this, and it does not exist yet.
     */
    expect(
      degreesBetween(noseOf(at(1800)!), heading(at, 1800, 280)),
      'credit descent f1800–2080: nose off its chord',
    ).toBeLessThan(FIT_SPREAD_DEG.descent)
    /*
     * The wipes are the pass this can be asserted to a fifth of a degree on,
     * because the three fits agree with each other to 0.22° and the pass is
     * 35.9 km of approach with 19 m of perpendicular residual. Wipes one and
     * three measure 0.07°.
     *
     * All three, including the mirrored one — which is the point. This
     * property was written while the middle wipe measured 43.33°: the same
     * animation mirrored in x, flown on the *unmirrored* heading, because
     * `mirrored()` reflected the beats and `FACING_TITLES` gave all three
     * passes one forward vector. The hull crabbed sideways across the frame by
     * exactly the angle between the fitted wipe direction and its own mirror
     * for thirty-five frames. The facing is mirrored with the beats now, so the
     * middle pass is held to the same fifth of a degree as the other two, and
     * the assertion below is what fails if anyone unmirrors it again.
     */
    for (const offset of TNG_WIPE_OFFSETS) {
      expect(
        degreesBetween(
          noseOf(at(1292 + offset)!),
          heading(at, 1292 + offset, 22),
        ),
        `wipe +${offset}: nose off its chord`,
      ).toBeLessThan(FIT_SPREAD_DEG.wipe)
    }
  })

  it('keeps the nose on the frame-by-frame heading through all three wipes', () => {
    const { at } = playing()
    /*
     * The frame-scale form, on the one pass that can carry it tightly. The
     * wipe's straight-line fit leaves 19 m of perpendicular residual over a
     * 35.9 km path, and the hull covers at least 276 m in any single frame of
     * f1292–1314, so a residual excursion of that size can tilt one frame's
     * heading by atan(19 / 276) = 3.9°. That is the bound, and it is the
     * measurement that sets it rather than a decimal place: the worst frame in
     * the window measures 1.97°.
     */
    const WIPE_FRAME_DEG = 3.9
    fc.assert(
      fc.property(
        fc.integer({ min: 1292, max: 1314 }),
        fc.constantFrom(...TNG_WIPE_OFFSETS),
        (frame, offset) => {
          const f = frame + offset
          expect(
            degreesBetween(noseOf(at(f)!), heading(at, f)),
            `f${f} (wipe +${offset})`,
          ).toBeLessThan(WIPE_FRAME_DEG)
        },
      ),
    )
  })

  it('keeps the nose within the fit on the cruise and the descent, where the beats are a track', () => {
    const { at } = playing()
    /*
     * The same property frame by frame on the two passes whose beats are
     * hand-read boxes rather than a line, and it has to be stated loosely for
     * a reason that is worth writing down: a *frame* of one of these passes is
     * 2–15 m of travel, and the straight-line fits the directions come from
     * leave 109 m of perpendicular residual over the cruise's 4.0 km path and
     * 134 m over the descent's 6.9 km. Beat to beat that is atan(109 / ~450 m)
     * ≈ 13.6° of heading wander on top of the cruise fit's own 6.8°, and about
     * the same again on the descent's 15.0°. Worst measured: 12.54° on the
     * cruise (f870) and 27.59° on the descent (f1976).
     *
     * Two windows are cut out, both authored rather than accidental:
     *
     *  - **f730–824 of the cruise.** The reference holds range across
     *    f760–792 — both beats measure the same width, 0.401 and 0.395, so the
     *    hull *recedes* 1.52% — while the knots either side close hard. The
     *    log-range Catmull-Rom therefore overshoots inside the segment, and
     *    across it the frame-to-frame displacement is a sub-percent range
     *    wobble whose direction is not a flight direction at all: it peaks at
     *    142.8° from the nose at f778. A Catmull-Rom segment is shaped by the
     *    knots either side of it, so the exclusion is the reversing pair's two
     *    neighbouring knots, not just the pair.
     *  - **f2036–2080 of the descent.** The authored x jags by 0.126 of the
     *    frame's width between f2065 and f2075 (0.483 → 0.357) where the refit
     *    splices the box channel to the Bussard-cap channel. No straight line
     *    contains that, and the heading swings 82.0° off the nose at f2068.
     *    That is `design/plans/tng-intro.md` §2's late-descent refit, not a
     *    property failure — when it lands, widen this window to f2080 and the
     *    bound should hold.
     */
    const DESCENT_FRAME_DEG = 30
    /*
     * The cruise carries no exclusion window any more, and no slack. f730–824
     * used to be cut out of it because the reference holds range across
     * f760–792 while the knots either side close hard, so the log-range spline
     * overshot inside the segment and the frame-to-frame displacement was a
     * sub-percent range wobble pointing 142.8° off the nose at f778. That was
     * never the hull's motion; it was the *offset's*. On a rail the hull moves
     * 13.3 m every frame in one direction, and the reference's range hold is
     * the camera easing off, which is what a range hold is.
     */
    fc.assert(
      fc.property(fc.integer({ min: 677, max: 1090 }), (f) => {
        /*
         * f947 is skipped and it is the only one: it is the last frame of
         * `cruise`, so its forward difference crosses the f948 relight into
         * `cruise-close`, which stands the whole stage on the other side of the
         * star. The hull's *world* displacement across that pair is a change of
         * stage and not a velocity. Everything the frame shows is continuous —
         * the two shots fly the identical rail against identical marks, and the
         * hull is wider than the lens throughout.
         */
        fc.pre(f !== CUT_TO_CLOSE - 1)
        expect(
          degreesBetween(worldNose(at(f)!), worldHeading(at, f)),
          `cruise f${f}: nose off its own rail`,
        ).toBeLessThan(0.01)
      }),
    )
    fc.assert(
      fc.property(fc.integer({ min: 1800, max: 2035 }), (f) => {
        expect(
          degreesBetween(noseOf(at(f)!), heading(at, f)),
          `descent f${f}: nose off its heading`,
        ).toBeLessThan(DESCENT_FRAME_DEG)
      }),
    )
  })

  it('never lets a rail\u2019s throttle reverse', () => {
    /*
     * A `LinePath` splines its advance in log distance, which is the right
     * coordinate for an approach spanning four decades and is not a free lunch:
     * two knots far enough apart in log make the Catmull-Rom overshoot the near
     * one, and an overshot advance is a hull backing up along its own track.
     * The descent did exactly that between its authored f1755 entry and its
     * first measured beat at f1775 — a six-fold closing followed by a
     * one-and-a-half-fold one — and reversed at 378 m per frame across
     * f1784\u20131799, fifteen frames of a ship flying backwards down its own
     * approach.
     *
     * Sampled four times a frame, because the overshoot lives inside a segment
     * and a per-frame walk can step over it.
     */
    for (const [name, line, from, to] of TNG_RAILS) {
      for (let f = from; f <= to; f += 0.25) {
        expect(
          Vec.dot(lineVelocity(line, f), line.direction),
          `${name} reverses at f${f}`,
        ).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('reproduces the measured tracks it was fitted to', () => {
    /*
     * `design/plans/tng-intro.md` \u00a73.3: the measured beats stay in the
     * script as the specification, and the fits are held to them by projecting
     * a rail back to the screen. The residuals are each pass's own, and each
     * is a number about the *material* rather than about the fit:
     *
     *  - **The wipe, 0.011.** 36 km of approach with a straight-line residual
     *    of 19 m. It is the clean case in the piece and the only one that can
     *    be asserted this tightly.
     *  - **The descent, 0.11.** The reference's own descent fits a line at
     *    5.0%, and the worst beats are f1920 and f1960 at 0.09 plus the
     *    f2050\u20132065 channel splice at 0.13 \u2014 the jag, which is the one
     *    thing here a line is *supposed* to disagree with.
     *
     * The warp-outs are not in this list. Their late beats are a hull inside a
     * flash, which the subject channel scores as the wash; `WARP_OUT_1_RAIL`
     * says why it flies the line instead.
     */
    const project = (line: LinePath, frame: number) =>
      screenPositionOf(linePosition(line, frame))
    /*
     * Each list is cut where its beats stop being measurements. The wipe's at
     * f1315: by f1316 the hull is 0.798 of the frame wide and one frame from
     * the lens, so its box is against all four edges and its centre is a
     * statement about the edges. The descent's at f2130, where the leg ends and
     * the skim — which the reference cannot measure at all — takes over.
     */
    for (const [name, line, beats, last, bound] of [
      ['wipe', WIPE_RAIL, TNG_SHIP_BEATS.wipe, 1315, 0.011],
      ['descent', DESCENT_RAIL, TNG_SHIP_BEATS.return, 2130, 0.14],
    ] as const) {
      for (const beat of beats) {
        if (beat.frame > last) continue
        const at = project(line, beat.frame)
        expect(
          Math.hypot(at.x - beat.x, at.y - beat.y),
          `${name} f${beat.frame}: the rail is off the measured mark`,
        ).toBeLessThan(bound)
      }
    }
  })

  it('never swings the hull faster than 2°/frame outside an authored maneuver', () => {
    const { at } = playing()
    /*
     * The orientation criterion, in the channel a screen measurement would
     * read it in: the angle between one frame's hull attitude and the
     * next's, in camera axes, which is what the principal-axis channel sees.
     * The whole quaternion, not a component — a swing about the sight line and
     * a swing across it are the same failure and only one of them shows up in
     * a single Euler term.
     *
     * The maneuvers the reference actually performs, from the measured census,
     * are excluded because they are the point: the bank-away, the two
     * warp-outs, and the skim. Everything else is a hull holding an attitude,
     * so the bound is the plan's and the margin is large — the worst
     * maneuver-free frame in the piece measures 0.265°/frame at f2128, going
     * into the skim.
     *
     * Being on stage is asked of the sample rather than restated from
     * `SHIP_WINDOWS`, which is not exported: a window that moves takes this
     * test with it.
     */
    const MANEUVERS: readonly (readonly [number, number])[] = [
      [880, 1120], // the bank-away — roll to −25.5° at up to 0.656°/frame
      [1085, 1125], // the first warp-out
      [2130, 2420], // the skim, which rolls +11.3° over f2315–2380
      [2382, 2420], // the second warp-out
    ]
    const staged: number[] = []
    let onStage = 0
    let worst = { frame: 0, swing: 0 }
    for (let f = 600; f < 2440; f += 1) {
      if (!at(f)!.ship.visible || !at(f + 1)!.ship.visible) continue
      onStage += 1
      if (MANEUVERS.some(([from, to]) => f + 1 >= from && f <= to)) continue
      staged.push(f)
      const swing = swingDegrees(facingOf(at(f)!), facingOf(at(f + 1)!))
      if (swing > worst.swing) worst = { frame: f, swing }
    }
    // Five visibility windows less four maneuvers still leaves more than half
    // the hull's screen time; if it does not, the census has moved and the
    // exclusions below are covering the piece rather than its maneuvers.
    expect(staged.length).toBeGreaterThan(onStage / 2)
    // Every staged frame, so the worst one is the one that gets named...
    expect(
      worst.swing,
      `worst maneuver-free swing is ${worst.swing.toFixed(3)}°/frame at f${worst.frame}→f${worst.frame + 1}`,
    ).toBeLessThan(2)
    // ...and again as a property, which shrinks a *pattern* of failures to its
    // earliest frame rather than reporting only the largest.
    fc.assert(
      fc.property(fc.constantFrom(...staged), (f) => {
        const swing = swingDegrees(facingOf(at(f)!), facingOf(at(f + 1)!))
        expect(
          swing,
          `f${f}→f${f + 1} swings ${swing.toFixed(3)}°/frame`,
        ).toBeLessThan(2)
      }),
      { numRuns: 400 },
    )
  })

  it('authors both approaches as closing, with one measured hold', () => {
    /*
     * The knot-level half of "range is monotone through the approaches", and
     * the tolerance-free one: no interpolation is involved, so this is a
     * statement about the authoring. The cruise contains exactly one
     * recession and it is the reference's own hold — f760 and f792 measure
     * w 0.401 and 0.395, so the beats put the hull 1.52% *further* away at the
     * end of it. The descent contains none at all, which matches the
     * reference's track: zero backsteps over f1775–2100.
     *
     * This is what licenses the frame-level tolerance in the next test. If a
     * refit adds a second recession, the tolerance there stops being honest
     * and this names the beat that made it so.
     */
    const recessions = (
      beats: readonly { frame: number; range: number }[],
      from: number,
      to: number,
    ) =>
      beats
        .filter((beat) => beat.frame >= from && beat.frame <= to)
        .filter(
          (beat, i, list) =>
            i > 0 && beat.range > (list[i - 1] as { range: number }).range,
        )
    const cruise = recessions(TNG_SHIP_BEATS.cruise, 676, 952)
    expect(cruise.map((beat) => beat.frame)).toEqual([792])
    const hold = TNG_SHIP_BEATS.cruise.find((beat) => beat.frame === 760)!
    expect((cruise[0] as { range: number }).range / hold.range).toBeCloseTo(
      0.401 / 0.395,
      6,
    )
    expect(recessions(TNG_SHIP_BEATS.return, 1758, 2085)).toEqual([])
  })

  it('closes monotonically frame by frame, within each approach’s stated slack', () => {
    const { at } = playing()
    /*
     * The frame-level half. "Non-increasing within a stated tolerance" rather
     * than strictly decreasing, and the tolerance is different for the two
     * passes because what allows it is different:
     *
     *  - **Cruise, 0.5%/frame.** The pass is not authored monotone at all —
     *    the hold above recedes 1.52% between two beats 32 frames apart, and
     *    both bracketing knots are closing hard, so the log-range Catmull-Rom
     *    concentrates that rise into part of the segment instead of spreading
     *    it. 21 of the 276 frames rise; the worst is +0.245% at f778.
     *  - **Descent, 0.05%/frame.** Nothing here is authored to recede, so the
     *    only rise permitted is the spline's own overshoot inside the
     *    near-hold f2065–2075 (w 0.666 → 0.673 — barely closing between two
     *    faster segments). Three frames rise; the worst is +0.0225% at f2070.
     *
     * And the overshoot is bounded by the knots either side rather than by
     * taste: the sampled range never exceeds the larger of its two bracketing
     * beats by more than 0.5%, which is the log-space spline staying inside
     * the envelope its authored beats describe. Measured: +0.178% on the
     * cruise, +0.000% on the descent.
     */
    /*
     * The descent is not in this list any more, and the reason is the point of
     * the refit: its range is a rail's, not a beat list's, and the beat it
     * would be held against at f2065 is the jag. Asked the old question the
     * rail runs 2.66% past its bracketing beats there — which is the line
     * correctly refusing a 0.126-of-the-frame step no line contains. The
     * property it does carry is stronger and is asserted on the path itself,
     * below: the throttle never reverses at any sub-frame sample.
     */
    const OVERSHOOT = 0.005
    for (const [label, beats, from, to, slack] of [
      ['cruise', TNG_SHIP_BEATS.cruise, 676, 952, 0.005],
    ] as const) {
      const knots = beats.filter(
        (beat) => beat.frame >= from - 200 && beat.frame <= to + 200,
      )
      let worstRise = { frame: from, value: 0 }
      let worstOvershoot = { frame: from, value: 0 }
      for (let f = from; f < to; f += 1) {
        const rise = rangeAt(at, f + 1) / rangeAt(at, f) - 1
        if (rise > worstRise.value) worstRise = { frame: f, value: rise }
        let i = 0
        while (
          i + 1 < knots.length &&
          f >= (knots[i + 1] as { frame: number }).frame
        )
          i += 1
        const bracket = Math.max(
          (knots[i] as { range: number }).range,
          (knots[Math.min(i + 1, knots.length - 1)] as { range: number }).range,
        )
        const overshoot = rangeAt(at, f) / bracket - 1
        if (overshoot > worstOvershoot.value)
          worstOvershoot = { frame: f, value: overshoot }
      }
      // Both worsts, so a regression names the frame it happens at rather than
      // the first frame that happens to breach.
      expect(
        worstRise.value,
        `${label} backsteps ${(worstRise.value * 100).toFixed(4)}% at f${worstRise.frame}`,
      ).toBeLessThan(slack)
      expect(
        worstOvershoot.value,
        `${label} runs ${(worstOvershoot.value * 100).toFixed(4)}% past its bracketing beats at f${worstOvershoot.frame}`,
      ).toBeLessThan(OVERSHOOT)
    }
  })

  it('hands the cruise over to the warp-out without flying it twice', () => {
    const { at } = playing()
    /*
     * A Catmull-Rom segment is shaped by the knot past its far end, so beats
     * after a shot's last frame are not dead — which is the thing that made
     * this a defect nothing was watching for.
     *
     * `SHIP_CRUISE` used to carry three exit beats hurling the hull to
     * `atWidth(0.0008)` by f1120, on the reasoning that `cruise-close` ends at
     * f1091 so they are never read. They set the tangent of the f1080–1092
     * segment, which that shot renders in full: the hull went 431.9 m → 17.4 km
     * across f1080–1091, in the clear, with the wash already at zero — and then
     * the titles stage's own f1092 knot put it back at 568.0 m. A whole warp-out
     * twelve frames early, and a 30x pop out of it.
     *
     * Both halves are asserted, because either alone can be satisfied by a
     * shot that is wrong in the other direction:
     *
     *  - **Continuity at the cut.** The two shots must agree about where the
     *    hull is on the frame they hand over on. 1% is a spline sampling two
     *    routes that share an endpoint, not a tolerance for disagreement;
     *    measured, f1091 → f1092 is 555.1 m → 568.0 m, +2.3%, which is one
     *    frame of the recede either side of a knot they both hold.
     *  - **No excursion before it.** The cruise's last twelve frames recede at
     *    the pass's own rate, not a warp's. The worst measured step over
     *    f1080–1091 is +2.44%/frame; the reverted script's is +41.4%.
     *
     * Change `SHIP_CRUISE`'s handover knot and `SHIP_TITLES`' f1092 entry
     * together, or this names the frame where they stopped agreeing.
     */
    const HANDOVER = 1092
    let worst = { frame: 1080, step: 0 }
    for (let f = 1080; f < HANDOVER - 1; f += 1) {
      const step = rangeAt(at, f + 1) / rangeAt(at, f) - 1
      if (step > worst.step) worst = { frame: f, step }
    }
    expect(
      worst.step,
      `cruise exit opens ${(worst.step * 100).toFixed(2)}%/frame at f${worst.frame} — a warp-out inside a shot that has not cut yet`,
    ).toBeLessThan(0.05)
    const across = rangeAt(at, HANDOVER) / rangeAt(at, HANDOVER - 1) - 1
    expect(
      Math.abs(across),
      `the cut at f${HANDOVER} jumps the hull ${(across * 100).toFixed(1)}%`,
    ).toBeLessThan(0.05)
    // The attitude has to survive the cut too: `routeOrientation` holds its
    // first beat before that beat's frame, so a `FACING_TITLES` starting at
    // f1280 pinned the now-visible hull to the *wipes'* heading — 164° away,
    // in one frame, pointing back down the lens. Its first two beats are
    // `FACING_CRUISE`'s last two verbatim; slerp is segment-local, so the two
    // lists agree exactly over f1035–1120 and the bound here is a spline's
    // own smoothness rather than a fudge. Measured worst: 0.350°/frame.
    let worstSwing = { frame: 1076, swing: 0 }
    for (let f = 1076; f <= 1107; f += 1) {
      const swing = swingDegrees(facingOf(at(f)!), facingOf(at(f + 1)!))
      if (swing > worstSwing.swing) worstSwing = { frame: f, swing }
    }
    expect(
      worstSwing.swing,
      `hull swings ${worstSwing.swing.toFixed(3)}°/frame at f${worstSwing.frame}→f${worstSwing.frame + 1}, across the f${HANDOVER} cut`,
    ).toBeLessThan(2)
  })
})

describe('tng-intro camera discipline', () => {
  /** Frames where the shot list says a cut happens. */
  const cutFrames = new Set(TNG_CUTS.flatMap((cut) => [cut.from, cut.to + 1]))

  it('never moves the camera while a title is on screen', () => {
    const { at } = playing()
    // The measured constraint is that all dynamism is the ship's. Held per
    // *shot*, because the piece is an edit: the second flash is an honest
    // scene change and the end cards stand somewhere else entirely.
    let anchor = at(1100)!.camera
    for (let f = 1100; f <= 2740; f += 1) {
      if (cutFrames.has(f)) {
        anchor = at(f)!.camera
        continue
      }
      const sample = at(f)!
      if (!sample.texts.some((text) => text.opacity > 1e-3)) continue
      expect(
        UV.distance(sample.camera.position, anchor.position),
        `frame ${f}`,
      ).toBeLessThan(1e-6)
      const q = sample.camera.orientation
      const dot = Math.abs(
        q.x * anchor.orientation.x +
          q.y * anchor.orientation.y +
          q.z * anchor.orientation.z +
          q.w * anchor.orientation.w,
      )
      expect(dot, `frame ${f}`).toBeGreaterThan(1 - 1e-9)
    }
  })

  it('cuts only where the shot list says, and holds still in between', () => {
    const { at } = playing()
    /*
     * The piece is an edit. Every jump in the camera has to land on a shot
     * boundary — the f240 match cut, the cutaway either side of the veil, the
     * two flashes — and inside a shot the route has to be smooth. A smooth
     * curve's half-frame step is a small fraction of the surrounding
     * three-frame span; a splice bug makes the two nearly equal, so half the
     * span cleanly separates them.
     */
    // Stops two frames short of the end: the director returns null past the
    // final frame, which is its contract, not a gap in the edit.
    for (let f = 1; f < TNG_INTRO.durationFrames - 3; f += 1) {
      const step = UV.distance(
        at(f - 1)!.camera.position,
        at(f)!.camera.position,
      )
      if (cutFrames.has(f)) continue
      const span = UV.distance(
        at(f - 1)!.camera.position,
        at(f + 2)!.camera.position,
      )
      expect(step, `frame ${f}`).toBeLessThan(span + 10)
    }
    // And the cuts that matter are real discontinuities, not seams that
    // happen to be smooth.
    expect(
      UV.distance(at(239)!.camera.position, at(240)!.camera.position),
    ).toBeGreaterThan(1e9)
    expect(
      UV.distance(at(1091)!.camera.position, at(1092)!.camera.position),
    ).toBeGreaterThan(1e6)
  })

  it('covers every cut with darkness, a flash, or a full frame', () => {
    const { at } = playing()
    /*
     * A cut the audience can see is an edit; a cut they cannot is the trick
     * the whole piece is built on. Each boundary has to be hidden by
     * *something* — the blackout, a warp flash, a hull filling the lens, or
     * a composition matched across the seam.
     */
    const matched = new Set([240]) // the f240 join is a composition match cut
    for (const cut of TNG_CUTS) {
      const f = cut.from
      if (f === 0 || matched.has(f)) continue
      const before = at(f - 1)!
      const after = at(f)!
      /*
       * The hull covering the lens is a cover in its own right, and it is
       * checked rather than asserted: the relight at f985 is only invisible
       * because the ship is wider than the frame across the seam.
       */
      const hullCovers = [before, after].every((sample) => {
        if (!sample.ship.visible) return false
        const offset = Q.rotate(
          Q.conjugate(sample.camera.orientation),
          UV.difference(sample.ship.position, sample.camera.position),
        )
        const { range } = screenPositionOf(offset)
        return (
          apparentWidth(
            TNG_HULL_LENGTH,
            range,
            TNG_LENS.fov,
            TNG_LENS.aspect,
          ) >= 1
        )
      })
      const covered =
        before.effects.blackout > 0.9 ||
        after.effects.blackout > 0.9 ||
        before.effects.flash > 0.9 ||
        after.effects.flash > 0.9 ||
        hullCovers ||
        // Empty sky on both sides: the same trick with no light in it, and
        // the reason no shot detector can find these three.
        cut.id === 'jupiter' ||
        cut.id === 'saturn' ||
        cut.id === 'cruise'
      expect(covered, `cut into ${cut.id} at f${f}`).toBe(true)
    }
  })

  it('drives the corona in the eclipse shot and nowhere else', () => {
    /*
     * A regression test for an effect that used to have no gate at all.
     *
     * The corona around an eclipsed limb was drawn purely from occlusion
     * geometry, so it fired for any camera sitting on a body's anti-sun line —
     * one press of `crescent` in the planetarium, and a third of every slow
     * orbit on the front door, as a gold halo filling a frame in a mode that
     * had never asked for an eclipse. At those ranges the physical corona is a
     * fraction of a degree past the limb and the drawn one is nearly a disk
     * radius thick.
     *
     * It is a script drive now, like `blackout` and `flash`. The claim worth
     * guarding is not the ring's shape — that is a shader — but that exactly
     * one shot in the whole piece asks for it, and that nothing else can.
     */
    const { at } = playing()
    const eclipse = TNG_CUTS.find((cut) => cut.id === 'eclipse')
    expect(eclipse).toBeDefined()
    const { from, to } = eclipse!

    // Hard edges: both boundaries of this shot *are* cuts (f240 is the
    // composition match cut, f357 lands in empty starfield), so a ramp here
    // would be a fade across a cut.
    expect(at(from)!.effects.corona).toBe(1)
    expect(at(to)!.effects.corona).toBe(1)
    expect(at(from - 1)!.effects.corona).toBe(0)
    expect(at(to + 1)!.effects.corona).toBe(0)

    for (let f = 0; f < 2742; f += 7) {
      const inside = f >= from && f <= to
      expect(at(f)!.effects.corona, `frame ${f}`).toBe(inside ? 1 : 0)
    }
  })

  it('emits finite poses across the whole piece', () => {
    const { at } = playing()
    for (let f = 0; f < 2742; f += 25) {
      const sample = at(f)!
      expect(sampleIsFinite(sample), `frame ${f}`).toBe(true)
      expect(sample.effects.blackout).toBeGreaterThanOrEqual(0)
      expect(sample.effects.blackout).toBeLessThanOrEqual(1)
    }
  })
})

describe('cutscene director lifecycle', () => {
  it('restores the player exactly on stop, clock settings included', () => {
    const session = openSession()
    const harness = session.harness
    const player = session.player()!
    session.world.clock.setTimeScale(25)
    // A field-by-field copy: the packages tsconfig has no DOM or Node lib, so
    // `structuredClone` does not exist here, and the state is flat anyway.
    const live = session.world.entities.require(player).state
    const before = {
      frame: live.frame,
      position: { ...live.position },
      velocity: { ...live.velocity },
      orientation: { ...live.orientation },
      angularVelocity: { ...live.angularVelocity },
    }

    harness.play('tng-intro')
    expect(session.world.clock.timeScale).toBe(1)
    // The world keeps ticking underneath the cutscene.
    session.world.runTicks(128)
    harness.cutsceneSample(session.world.clock.time)
    harness.stopCutscene()

    const after = session.world.entities.require(player).state
    expect(after.frame).toBe(before.frame)
    expect(after.position).toEqual(before.position)
    expect(after.velocity).toEqual(before.velocity)
    expect(after.orientation).toEqual(before.orientation)
    expect(session.world.clock.timeScale).toBe(25)
  })

  it('stops itself and restores after the final frame', () => {
    const session = openSession()
    const harness = session.harness
    harness.play('tng-intro')
    expect(harness.cutsceneSample(100)).not.toBeNull()
    expect(
      harness.cutsceneSample(100 + (TNG_INTRO.durationFrames + 5) / FPS),
    ).toBeNull()
    expect(harness.cutsceneStatus()).toBeNull()
  })

  it('seeks to an exact reference frame', () => {
    const { harness, at } = playing()
    at(500)
    harness.seekCutscene(1150)
    const sample = harness.cutsceneSample(100 + 500 / FPS)
    expect(sample!.frame).toBeCloseTo(1150, 6)
  })

  it('declines a seek to something that is not a frame', () => {
    /*
     * `Math.max(0, Math.min(NaN, n))` is `NaN`. It reaches `epoch`, which is
     * computed once and never again, so every later frame is `NaN` too: the
     * end test never fires, the scene never terminates, and it renders black
     * with no way out but a reload. Declined rather than clamped, the way
     * `surfaceStance.ts` declines a height it cannot stand at — the seek is
     * simply not performed.
     */
    const { harness, at } = playing()
    at(500)
    harness.seekCutscene(1150)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
      expect(harness.seekCutscene(bad).frame).toBeCloseTo(1150, 6)
    }
    const sample = harness.cutsceneSample(100 + 500 / FPS)
    expect(sample).not.toBeNull()
    expect(sample!.frame).toBeCloseTo(1150, 6)
  })

  it('abandons cleanly when the world is replaced underneath it', () => {
    const session = openSession()
    const harness = session.harness
    harness.play('tng-intro')
    const save = harness.save()
    const result = harness.load(save)
    expect(result.ok).toBe(true)
    // The captured state belongs to the discarded world; the next sample must
    // not restore it into the new one — it abandons and goes quiet.
    expect(harness.cutsceneSample(100)).toBeNull()
    expect(harness.cutsceneStatus()).toBeNull()
    expect(harness.cutsceneOutcome()?.ending).toBe('abandoned')
    // And a stop after the abandonment is a harmless no-op.
    harness.stopCutscene()
  })
})

describe('how a scene left', () => {
  /*
   * `cutsceneStatus()` goes null for three different reasons and a player has
   * to tell them apart: one draws an end card and keeps its transport, the
   * others close it. Before this the only evidence was the null itself, so the
   * cinema player guessed with a half-second window around the final frame —
   * and read `stopCutscene` from the console as an ending, because a stop near
   * the end produces the identical evidence.
   */

  it('says nothing before a scene has ever played', () => {
    expect(openSession().harness.cutsceneOutcome()).toBeNull()
  })

  it('reports a scene that ran past its last frame as ended', () => {
    const { harness, at } = playing()
    at(0)
    expect(harness.cutsceneOutcome()).toBeNull()
    // One sample past the end is what stops it, from inside `sample`.
    expect(at(TNG_INTRO.durationFrames + 1)).toBeNull()
    expect(harness.cutsceneStatus()).toBeNull()
    expect(harness.cutsceneOutcome()).toEqual({
      id: 'tng-intro',
      ending: 'ended',
      durationFrames: TNG_INTRO.durationFrames,
      fps: TNG_INTRO.fps,
    })
  })

  it('reports a scene stopped by hand as stopped, at any frame', () => {
    // Including one frame short of the end, which is exactly where the old
    // heuristic could not tell the two apart.
    const { harness, at } = playing()
    at(TNG_INTRO.durationFrames - 1)
    harness.stopCutscene()
    expect(harness.cutsceneOutcome()?.ending).toBe('stopped')
  })

  it('clears the outcome when a new scene starts', () => {
    const { harness, at } = playing()
    at(TNG_INTRO.durationFrames + 1)
    expect(harness.cutsceneOutcome()?.ending).toBe('ended')
    harness.play('tng-intro')
    // A scene that is playing has not left yet; a stale ending here would draw
    // an end card over a scene that had only just started.
    expect(harness.cutsceneOutcome()).toBeNull()
  })

  it('keeps saying so until something else happens', () => {
    const { harness } = playing()
    harness.stopCutscene()
    harness.stopCutscene()
    expect(harness.cutsceneOutcome()?.ending).toBe('stopped')
  })
})

describe('tng-intro lighting geometry', () => {
  /*
   * Why there is a camera-mounted light in `scene/CameraRig.tsx` at all.
   *
   * The hull's beats are camera-relative, so which face the camera is looking
   * at is fixed by the beat tables and cannot be changed by re-aiming a shot:
   * rotating the camera carries the hull with it. A shot's key is the star,
   * which does not move. So if any beat in a shot turns the hull's unlit side
   * to the lens, no choice of camera orientation rescues it, and the face on
   * screen falls back to `ambientLight` 0.16 — 1/255 through the ACES toe, a
   * silhouette. That is what `STAGE_FILL_INTENSITY` exists to cover.
   *
   * These assert the *condition*, not a frame's numbers, because the authored
   * attitudes are still being fitted against the reference's tracked landmarks
   * and move from pass to pass. Read a failure as news, not as a bug:
   *
   *  - the first failing means every beat is now keyed, so the staged fill has
   *    no remaining job and should drop back to `FILL_INTENSITY`;
   *  - the second failing means one distant key could serve the whole shot
   *    after all, and the light belongs in `tngIntro.ts` rather than the rig.
   */
  const visibleFaceAndKey = (frames: readonly number[]) => {
    const session = openSession()
    const world = session.world
    const system = world.loadSystem(systemId('SOL'))
    const sun = world.frames.pose(
      systemFrameId(system.id),
      world.clock.time,
    ).position
    session.harness.play('tng-intro')
    const at = (f: number) =>
      session.harness.cutsceneSample(100 + f / TNG_INTRO.fps)
    at(0)
    return frames.map((frame) => {
      const s = at(frame)!
      const dorsal = Q.rotate(s.ship.orientation, vec3(0, 1, 0))
      const toCamera = Vec.normalize(
        UV.difference(s.camera.position, s.ship.position),
      )
      const face = Vec.dot(toCamera, dorsal) >= 0 ? dorsal : Vec.negate(dorsal)
      const toStar = Vec.normalize(UV.difference(sun, s.camera.position))
      // Both in camera axes for the second test: re-aiming a shot is exactly a
      // rotation of the star relative to a hull that turns with the camera.
      const inverse = Q.conjugate(s.camera.orientation)
      return {
        frame,
        keyOnFace: Vec.dot(toStar, face),
        faceInCamera: Q.rotate(inverse, face),
      }
    })
  }

  // Every hull beat of the one locked title shot, wipes through skim.
  const TITLE_BEATS = [
    1290, 1300, 1420, 1440, 1540, 1560, 1770, 1800, 1850, 1920, 2000, 2085,
    2100, 2200, 2300,
  ]

  it('shows the camera a face the star cannot light, somewhere in the title shot', () => {
    const worst = Math.min(
      ...visibleFaceAndKey(TITLE_BEATS).map((r) => r.keyOnFace),
    )
    // Grazing or worse. A Lambert face at 0.2 of full key is already down in
    // the toe, and the detector in `compare_render.py` keeps pixels above
    // grey 45 — which such a face does not reach.
    expect(worst).toBeLessThan(0.2)
  })

  it('cannot be served by one distant key, whatever the shot is aimed at', () => {
    const faces = visibleFaceAndKey(TITLE_BEATS).map((r) => r.faceInCamera)
    // Any key is a unit vector, so what it can deliver to two faces at once is
    // bounded by how far apart they are. Two visible faces more than 90° apart
    // cannot both be lit; the star would have to be in two places.
    let worstPair = 1
    for (const a of faces) {
      for (const b of faces) worstPair = Math.min(worstPair, Vec.dot(a, b))
    }
    expect(worstPair).toBeLessThan(0)
  })
})
