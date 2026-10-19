import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, type Vec3, vec3 } from '@inertialref/spatial'
import {
  type LinePath,
  linePosition,
  lineVelocity,
  type ScreenBeat,
  screenDirection,
} from '@inertialref/rendering'
import { type FitBeat, fitLinePath } from './linePathFit.ts'
import {
  screenPositionOf,
  TNG_LENS,
  TNG_RAILS,
  TNG_SHIP_BEATS,
  TNG_WARP_OUT_SPIKES,
  TNG_WIPE_OFFSETS,
  TNG_WIPE_RAILS,
  tngScreenDirection,
} from './cutscenes/tngIntro.ts'

/*
 * `fitLinePath`, held to the rails `tng-intro` already flies and to lines it
 * did not see.
 *
 * The script's six straight passes were fitted offline and landed as numbers.
 * Refitting each one from the beats it was fitted to, and finding the landed
 * rail again, is what makes the solver the source of those numbers rather than
 * a second opinion about them. The numbers stay as landed: a choreography change
 * needs a full capture against the reference, and this is not one.
 */

const LENS = { fov: TNG_LENS.fov, aspect: TNG_LENS.aspect }
const rail = (name: string): LinePath => {
  const found = TNG_RAILS.find(([candidate]) => candidate === name)
  if (found === undefined) throw new Error(`no rail ${name}`)
  return found[1]
}
const degrees = (a: Vec3, b: Vec3): number =>
  (Math.acos(Math.min(1, Vec.dot(a, b))) * 180) / Math.PI
const onScreen = (path: LinePath, frame: number) =>
  screenPositionOf(linePosition(path, frame))

/** `cutscene.test.ts`'s throttle audit: four samples a frame, never backward. */
function expectNoReversal(path: LinePath, label: string): void {
  const first = (path.advance[0] as { frame: number }).frame
  const last = (path.advance[path.advance.length - 1] as { frame: number })
    .frame
  for (let f = first; f <= last; f += 0.25)
    expect(
      Vec.dot(lineVelocity(path, f), path.direction),
      `${label} reverses at f${f}`,
    ).toBeGreaterThanOrEqual(0)
}

describe('fitLinePath against the landed rails', () => {
  it('finds both departures exactly, given the spike', () => {
    /*
     * A departure's direction is not fitted: a receding ship converges on the
     * projection of its own velocity, so the lens spike states the heading.
     * What is left is the throttle, and every knot is the root of its beat's
     * range — so the refit is the landed rail to the decimal it was typed to.
     *
     * Warp-out 2's f2386 is the one landed knot with no beat under it, and the
     * solver adds none there because nothing reverses without it. Between
     * f2380 and f2392 the two therefore differ by up to 0.044 of the frame, on
     * a hull inside the second flash that the reference measures as a streak.
     */
    for (const [name, beats, pin, spike] of [
      ['warp-out 1', TNG_SHIP_BEATS.warpOut, 1092, TNG_WARP_OUT_SPIKES[0]],
      [
        'warp-out 2',
        TNG_SHIP_BEATS.return.filter((beat) => beat.frame >= 2380),
        2380,
        TNG_WARP_OUT_SPIKES[1],
      ],
    ] as const) {
      const landed = rail(name)
      const fit = fitLinePath(beats, {
        ...LENS,
        pin,
        reach: 400,
        direction: tngScreenDirection(spike.x, spike.y),
      })
      expect(degrees(fit.path.direction, landed.direction)).toBeLessThan(1e-9)
      for (const knot of landed.advance) {
        const refit = fit.path.advance.find((k) => k.frame === knot.frame)
        if (refit === undefined) continue
        // The landed knots are typed to a tenth of a meter.
        expect(
          Math.abs(refit.t - knot.t),
          `${name} f${knot.frame}`,
        ).toBeLessThan(0.05)
      }
      expectNoReversal(fit.path, name)
    }
  })

  it('refits the three wipes and the descent within their own residuals', () => {
    /*
     * The bounds are `cutscene.test.ts`'s — 0.011 of the frame for the wipe,
     * 0.14 for the descent — applied twice: the refit has to sit that close to
     * the landed rail at every beat, and that close to the marks.
     *
     * Measured, the refit is much closer than the descent's bound asks. The
     * wipe's direction comes back 0.36° from the landed one and its track
     * within 0.005 of the frame; the descent's 0.40° and 0.015, the worst
     * of it at f2065, a channel splice both fits leave out. The descent's
     * knots agree with the landed ones to 4 m in 60 km, and the solver
     * puts its entry fillers at f1760 and f1765 where the landed rail has
     * f1760–1770: the same repair for the same overshoot.
     *
     * The wipe's beats stop at f1315, where the existing test stops reading
     * them, and its landed exit knots past f1316 are staging — the hull is
     * across the lens and its box is the frame — so nothing fits them.
     */
    const wipe = TNG_SHIP_BEATS.wipe.filter((beat) => beat.frame <= 1315)
    const cases: [
      string,
      LinePath,
      readonly ScreenBeat[],
      object,
      number,
      number,
    ][] = [
      ...TNG_WIPE_OFFSETS.map(
        (
          offset,
          index,
        ): [string, LinePath, ScreenBeat[], object, number, number] => [
          `wipe ${index + 1}`,
          TNG_WIPE_RAILS[index] as LinePath,
          wipe.map((beat) => ({
            ...beat,
            frame: beat.frame + offset,
            x: index === 1 ? 1 - beat.x : beat.x,
          })),
          { pin: 1313 + offset, reach: 40000 },
          0.011,
          0.5,
        ],
      ),
      [
        'descent',
        rail('descent'),
        TNG_SHIP_BEATS.return.filter((beat) => beat.frame <= 2130),
        { pin: 2100, reach: 60000, exclude: [2050, 2065] },
        0.14,
        0.5,
      ],
    ]
    for (const [name, landed, beats, options, bound, angle] of cases) {
      const fit = fitLinePath(beats, { ...LENS, ...options } as never)
      expect(
        degrees(fit.path.direction, landed.direction),
        `${name}: direction`,
      ).toBeLessThan(angle)
      for (const beat of beats) {
        const refit = onScreen(fit.path, beat.frame)
        const flown = onScreen(landed, beat.frame)
        expect(
          Math.hypot(refit.x - flown.x, refit.y - flown.y),
          `${name} f${beat.frame}: the refit is off the landed rail`,
        ).toBeLessThan(bound)
      }
      /*
       * And the landed rail is no better a fit than the solver's: over the
       * beats the direction is fitted to, its rms residual against the marks
       * is at least the refit's, to a thousandth of the frame: 0.0066 against
       * 0.0055 on the wipe. The descent's is 0.0521 against 0.0523, because
       * its landed knots sit up to 4 m off the roots of their own ranges and
       * that happens to help; a thousandth of the frame is the slack for it.
       */
      const fitted = beats.filter(
        (beat) =>
          !(('exclude' in options ? options.exclude : []) as number[]).includes(
            beat.frame,
          ),
      )
      let sum = 0
      for (const beat of fitted) {
        const flown = onScreen(landed, beat.frame)
        sum += (flown.x - beat.x) ** 2 + (flown.y - beat.y) ** 2
      }
      expect(fit.rms, `${name}: rms`).toBeLessThanOrEqual(
        Math.sqrt(sum / fitted.length) + 0.001,
      )
      expectNoReversal(fit.path, name)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* Properties                                                                 */
/* ------------------------------------------------------------------------- */

const FOV = 45
const ASPECT = 16 / 9

/**
 * A line in front of the lens and a throttle along it, from parameters. The
 * pin is a screen mark and a range, the direction any unit vector, and the
 * advance a run of positive log steps — so the generated path is a
 * `LinePath` whose every knot is known.
 */
const truthArb = fc
  .record({
    x: fc.double({ min: 0.1, max: 0.9, noNaN: true }),
    y: fc.double({ min: 0.1, max: 0.9, noNaN: true }),
    range: fc.double({ min: 200, max: 30000, noNaN: true }),
    dir: fc.tuple(
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.double({ min: -1, max: 1, noNaN: true }),
    ),
    gaps: fc.array(fc.integer({ min: 1, max: 30 }), {
      minLength: 3,
      maxLength: 9,
    }),
    steps: fc.array(fc.double({ min: 0.005, max: 0.8, noNaN: true }), {
      minLength: 9,
      maxLength: 9,
    }),
    pinAt: fc.nat(),
  })
  .filter(({ dir }) => Math.hypot(...dir) > 0.2)
  .map(({ x, y, range, dir, gaps, steps, pinAt }) => {
    const direction = Vec.normalize(vec3(...dir))
    const pin = Vec.scale(screenDirection(x, y, FOV, ASPECT), range)
    // The anchor far enough back that every advance stays positive.
    const reach = 4 * range
    const frames = [1000]
    for (const gap of gaps) frames.push((frames.at(-1) as number) + gap)
    const pinIndex = pinAt % frames.length
    const logs = frames.map((_, i) => {
      let s = 0
      for (let k = Math.min(i, pinIndex); k < Math.max(i, pinIndex); k += 1)
        s += steps[k] as number
      return i < pinIndex ? -s : s
    })
    const path: LinePath = {
      anchor: Vec.sub(pin, Vec.scale(direction, reach)),
      direction,
      advance: frames.map((frame, i) => ({
        frame,
        t: reach * Math.exp((logs[i] as number) * 0.25),
      })),
    }
    return { path, frames, pinFrame: frames[pinIndex] as number, reach }
  })

/** The path's own beats: where it projects, and how far away it is. */
function sampled(path: LinePath, frames: readonly number[]): FitBeat[] | null {
  const beats: FitBeat[] = []
  for (const frame of frames) {
    const at = linePosition(path, frame)
    const range = Vec.length(at)
    // In front of the lens, and not so oblique the mark is off any frame.
    if (-at.z < 0.2 * range) return null
    /*
     * And not at closest approach. There the range is stationary along the
     * line — a hull 12° either side of broadside is within 2% of the same
     * distance — so a range cannot say where on the line the hull is, and no
     * solver can recover a throttle from it. Every measured pass here is an
     * approach or a departure; the wipe's closest approach is f1317, past the
     * last beat it is fitted to.
     */
    if (Math.abs(Vec.dot(at, path.direction)) < 0.2 * range) return null
    const tanHalf = Math.tan((FOV * Math.PI) / 360)
    beats.push({
      frame,
      x: 0.5 + at.x / -at.z / (2 * tanHalf * ASPECT),
      y: 0.5 - at.y / -at.z / (2 * tanHalf),
      range,
    })
  }
  return beats
}

describe('fitLinePath properties', () => {
  it('grades a nearly flat pooled run beside a steep one', () => {
    /*
     * The case the throttle property found. Ranges scaled by 0.7–1.24 and one mark
     * wobbled pool to
     * a run that barely closes beside one that closes fast, and the junction
     * between them is a slope ratio of thousands. Splitting the steep side at
     * its chord's midpoint keeps both slopes, so the tangent at the junction
     * never falls far enough and the splits run down to a thousandth of a
     * frame; grading the slope takes the ratio to its square root per split.
     */
    const path: LinePath = {
      anchor: vec3(32063.284821953806, 2506.5096545770143, -7564.062002873662),
      direction: vec3(-1, 0, 0),
      advance: [
        { frame: 1000, t: 36519.30198564628 },
        { frame: 1001, t: 36649.1487499609 },
        { frame: 1002, t: 36752.62273939624 },
        { frame: 1003, t: 38655.89426506396 },
        { frame: 1004, t: 38704.24434539992 },
        { frame: 1005, t: 39505.3431548922 },
        { frame: 1006, t: 46471.71458808874 },
      ],
    }
    // Exactly as fast-check reported them: the sub-micron wobbles decide
    // which runs pool, and rounding them away hides the case.
    const scales = [
      1.021166009703678, 1.2427356265078113, 0.7000000000000002,
      0.9295285226040317, 1.0096339666281782, 0.7, 0.7000000000000008,
    ]
    const wobble = [
      -2.2024396195696742e-12, 0, 0, 0, 0, -0.007504506446420943, 0,
      -1.4103301859691444e-13, 0, 0, 0, -1.060238034172878e-8, 0, 0,
    ]
    const frames = [1000, 1001, 1002, 1003, 1004, 1005, 1006]
    const beats = (sampled(path, frames) ?? []).map((beat, i) => ({
      ...beat,
      x: beat.x + (wobble[2 * i] as number),
      y: beat.y + (wobble[2 * i + 1] as number),
      range: beat.range * (scales[i] as number),
    }))
    expect(beats).toHaveLength(7)
    const fit = fitLinePath(beats, {
      fov: FOV,
      aspect: ASPECT,
      reach: 365193.0198564628,
    })
    expectNoReversal(fit.path, 'pooled run')
  })

  it('recovers a line it generated, pinned and free (property)', () => {
    fc.assert(
      fc.property(truthArb, ({ path, frames, pinFrame, reach }) => {
        const beats = sampled(path, frames)
        fc.pre(beats !== null)
        for (const options of [
          { pin: pinFrame, reach },
          { reach: 10 * reach },
        ]) {
          const fit = fitLinePath(beats as FitBeat[], {
            fov: FOV,
            aspect: ASPECT,
            ...options,
          })
          expect(degrees(fit.path.direction, path.direction)).toBeLessThan(1e-4)
          for (const frame of frames) {
            const truth = linePosition(path, frame)
            expect(
              Vec.length(Vec.sub(linePosition(fit.path, frame), truth)) /
                Vec.length(truth),
            ).toBeLessThan(1e-5)
          }
        }
      }),
      { numRuns: 60 },
    )
  })

  it('never reverses the throttle, whatever the ranges say (property)', () => {
    /*
     * Ranges read off a box are noisy and need not be monotone; marks wobble.
     * Whatever line the fit settles on, the throttle it hands back may never
     * fly the hull backward along it at any quarter-frame sample, and its knots
     * are strictly ordered in frame — the log spline needs both.
     */
    fc.assert(
      fc.property(
        truthArb,
        fc.array(fc.double({ min: 0.7, max: 1.3, noNaN: true }), {
          minLength: 10,
          maxLength: 10,
        }),
        fc.array(fc.double({ min: -0.01, max: 0.01, noNaN: true }), {
          minLength: 20,
          maxLength: 20,
        }),
        ({ path, frames, reach }, scales, wobble) => {
          const clean = sampled(path, frames)
          fc.pre(clean !== null)
          const beats = (clean as FitBeat[]).map((beat, i) => ({
            ...beat,
            x: beat.x + (wobble[2 * i] as number),
            y: beat.y + (wobble[2 * i + 1] as number),
            range: beat.range * (scales[i] as number),
          }))
          const fit = fitLinePath(beats, {
            fov: FOV,
            aspect: ASPECT,
            reach: 10 * reach,
          })
          const knots = fit.path.advance
          for (let i = 1; i < knots.length; i += 1)
            expect(knots[i]!.frame).toBeGreaterThan(knots[i - 1]!.frame)
          expectNoReversal(fit.path, 'noisy fit')
        },
      ),
      { numRuns: 60 },
    )
  })
})
