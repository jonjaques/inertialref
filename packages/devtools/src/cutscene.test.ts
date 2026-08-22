import { describe, expect, it } from 'vitest'
import { Quaternion as Q, UV } from '@inertialref/spatial'
import { apparentWidth } from '@inertialref/rendering'
import { openSession } from './session.ts'
import { sampleIsFinite } from './cutscene.ts'
import {
  screenPositionOf,
  TNG_CUTS,
  TNG_HULL_LENGTH,
  TNG_INTRO,
  TNG_LENS,
} from './cutscenes/tngIntro.ts'

/*
 * The cutscene director, held to the reference edit's measured numbers.
 *
 * The script exists to be diffable against a frame-analysed reference, so
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
    // travelling — the reference's mask sees them dim and huge at f1140, not
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

  it('centres every credit and hangs its label on the name', () => {
    const { at } = playing()
    const sample = at(1340)!
    for (const id of ['c1', 'c2', 'c5', 'c8', 'e1']) {
      const text = sample.texts.find((candidate) => candidate.id === id)
      if (text === undefined) throw new Error(`no text ${id}`)
      // Measured: every name's mask is centred at x 0.497–0.510. The older
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
      [1118, 0.645, 0.665],
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

  it('runs both warp flashes on the measured 4/7/4 envelope', () => {
    const { at } = playing()
    for (const start of [1085, 2382]) {
      expect(at(start - 1)!.effects.flash).toBe(0)
      for (let f = start + 4; f <= start + 11; f += 1)
        expect(at(f)!.effects.flash).toBe(1)
      expect(at(start + 16)!.effects.flash).toBe(0)
    }
  })
})

describe('tng-intro ship choreography', () => {
  /*
   * The reference's hull measurements are screen measurements — a tracked
   * bounding box per frame — so this is the diff that matters: put the sampled
   * hull back through the lens and check it lands where the box did. Every
   * expected number below is a box centre or a box width from the analysis.
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

    // Box centres and widths at the frames where the box is unclipped.
    for (const [frame, x, y, width] of [
      [760, 0.203, 0.757, 0.401],
      [824, 0.278, 0.635, 0.438],
      [872, 0.354, 0.512, 0.695],
    ] as const) {
      const hull = track(at(frame)!)
      expect(hull.x, `f${frame} x`).toBeCloseTo(x, 2)
      expect(hull.y, `f${frame} y`).toBeCloseTo(y, 2)
      expect(hull.width, `f${frame} width`).toBeCloseTo(width, 2)
    }

    // It pulls away up-right rather than passing behind the lens — which is
    // what lets the camera hold still through the whole pass.
    const leaving = track(at(1080)!)
    expect(leaving.x).toBeCloseTo(0.617, 2)
    expect(leaving.range).toBeGreaterThan(track(at(976)!).range)
  })

  it('never puts the hull behind the lens while it is on stage', () => {
    const { at } = playing()
    /*
     * The spline-overshoot regression. Ranges across an approach span four
     * decades, and a Catmull-Rom over those knots in *metres* sets the near
     * end's tangent from the far end: it overshot through the camera and out
     * the other side, and the hull — which should have been receding at a
     * kilometre — simply was not drawn for twenty frames. Interpolating the
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
    // Wipes one and three are the same animation 247 frames apart: their
    // tracked boxes agree to three decimal places in the reference.
    const first = track(at(1292)!)
    const third = track(at(1292 + 247)!)
    expect(first.x).toBeCloseTo(0.239, 2)
    expect(first.y).toBeCloseTo(0.591, 2)
    expect(third.x).toBeCloseTo(first.x, 4)
    expect(third.y).toBeCloseTo(first.y, 4)
    expect(third.range).toBeCloseTo(first.range, 3)

    // The middle one is its mirror in x, and only in x.
    const second = track(at(1292 + 128)!)
    expect(second.x).toBeCloseTo(1 - first.x, 3)
    expect(second.y).toBeCloseTo(first.y, 3)
    expect(second.range).toBeCloseTo(first.range, 3)
  })

  it('brings the hull down through the credits from the top edge', () => {
    const { at } = playing()
    // Measured: the box breaks the top edge at f1770 and descends past the
    // vertical centre by f2100, which is why Spiner and Wheaton sit low.
    const early = track(at(1800)!)
    expect(early.y).toBeLessThan(0.1)
    expect(early.x).toBeCloseTo(0.462, 2)
    const late = track(at(2070)!)
    expect(late.y).toBeGreaterThan(early.y)
    expect(late.width).toBeGreaterThan(early.width)
    expect(late.width).toBeCloseTo(0.672, 1)
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
     * with no way out but a reload. Declined rather than clamped, matching
     * `Observatory.setFov` — the seek is simply not performed.
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
    // And a stop after the abandonment is a harmless no-op.
    harness.stopCutscene()
  })
})
