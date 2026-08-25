import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Quaternion as Q, UV, Vec, type Vec3, vec3 } from '@inertialref/spatial'
import {
  easeIn,
  easeOut,
  expApproach,
  fadeEnvelope,
  frameTwoTargets,
  type LinePath,
  linePosition,
  lineVelocity,
  lookAlong,
  orientationAlong,
  routeOrientation,
  routePosition,
  smooth,
  warpFlashEnvelope,
  withAttitude,
} from './cinematic.ts'

/* Small helpers for the property tests. */
const unitVec = fc
  .record({
    x: fc.double({ min: -1, max: 1, noNaN: true }),
    y: fc.double({ min: -1, max: 1, noNaN: true }),
    z: fc.double({ min: -1, max: 1, noNaN: true }),
  })
  .filter((v) => Vec.length(v) > 1e-3)
  .map((v) => Vec.normalize(v))

describe('easings', () => {
  it('hit their endpoints and stay inside [0,1]', () => {
    for (const ease of [smooth, easeIn, easeOut]) {
      expect(ease(0)).toBe(0)
      expect(ease(1)).toBe(1)
      fc.assert(
        fc.property(fc.double({ min: -2, max: 3, noNaN: true }), (t) => {
          const v = ease(t)
          return v >= 0 && v <= 1
        }),
      )
    }
  })

  it('are monotone on [0,1]', () => {
    for (const ease of [smooth, easeIn, easeOut]) {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          (a, b) => {
            const [lo, hi] = a < b ? [a, b] : [b, a]
            return ease(lo) <= ease(hi) + 1e-12
          },
        ),
      )
    }
  })
})

describe('expApproach', () => {
  it('starts at d0, ends at d1, and closes by a constant ratio', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.double({ min: 1e-3, max: 1, noNaN: true }),
        (d0, ratio) => {
          const d1 = d0 * ratio
          expect(expApproach(d0, d1, 0)).toBeCloseTo(d0, 6)
          expect(expApproach(d0, d1, 1)).toBeCloseTo(d1, 6)
          // Constant fractional closing: equal steps in t shrink the distance
          // by equal factors — the property that makes the fly-through read.
          const r1 = expApproach(d0, d1, 0.5) / expApproach(d0, d1, 0.25)
          const r2 = expApproach(d0, d1, 0.75) / expApproach(d0, d1, 0.5)
          expect(r1).toBeCloseTo(r2, 6)
        },
      ),
    )
  })
})

describe('fadeEnvelope', () => {
  const window = {
    firstVisible: 1326,
    fullOpacity: 1332,
    fadeOutStart: 1392,
    lastVisible: 1398,
  }

  it('is 0 outside, 1 through the hold, and continuous', () => {
    /*
     * `firstVisible` is a threshold crossing, not a fade start: the reference
     * calls a title visible once its mask clears a color floor the text only
     * reaches near full opacity. So the ramp *begins* before it — measured
     * against a captured render, treating the two as the same put every credit
     * four frames late — and the assertion is that the envelope is already
     * four-fifths up on the measured frame, and dark before the ramp.
     */
    expect(fadeEnvelope(window, 1321)).toBe(0)
    expect(fadeEnvelope(window, 1326)).toBeCloseTo(0.809, 3)
    // The trailing edge keeps the measured frame exactly: the same capture
    // found the fades late going in and on time coming out.
    expect(fadeEnvelope(window, 1400)).toBe(0)
    expect(fadeEnvelope(window, 1332)).toBeCloseTo(1, 6)
    expect(fadeEnvelope(window, 1392)).toBeCloseTo(1, 6)
    // Continuity: over a small step the opacity moves by a small amount. The
    // bound is the fade's own slope — a 6-frame smoothstep never moves faster
    // than 1.5/6 per frame.
    fc.assert(
      fc.property(fc.double({ min: 1316, max: 1404, noNaN: true }), (f) => {
        const step = 0.01
        const delta = Math.abs(
          fadeEnvelope(window, f + step) - fadeEnvelope(window, f),
        )
        return delta <= (1.5 / 6) * step + 1e-9
      }),
    )
  })

  it('never leaves [0,1] for any window shape', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 20 }),
        fc.double({ min: -100, max: 2400, noNaN: true }),
        (start, rise, hold, fall, frame) => {
          const w = {
            firstVisible: start,
            fullOpacity: start + rise,
            fadeOutStart: start + rise + hold,
            lastVisible: start + rise + hold + fall,
          }
          const v = fadeEnvelope(w, frame)
          return v >= 0 && v <= 1
        },
      ),
    )
  })
})

describe('warpFlashEnvelope', () => {
  it('is a rounded hump that opens before its start frame', () => {
    const start = 1085
    /*
     * The measured shape, as a fraction of the flash's own peak whole-frame
     * mean: 0.36 at t=0, 0.81 at t=3, 1.00 at t=7-8, 0.83 at t=11, 0.10 at
     * t=15. Two facts fall out of that and both are asserted here, because a
     * capture found each of them the expensive way.
     *
     * The reference's f1085 is a *threshold crossing*, not the frame the light
     * begins — the same distinction `THRESHOLD_FRACTION` draws for the titles —
     * so the envelope is already a third of the way up at t=0. And the top is
     * round: the previous envelope held exactly 1 for eight frames, and a
     * constant carries nothing for the host to shape, so the render plateaued
     * flat where the reference rises and falls by 17% across the same window.
     */
    expect(warpFlashEnvelope(start, start - 4).flash).toBe(0)
    expect(warpFlashEnvelope(start, start + 17).flash).toBe(0)
    expect(warpFlashEnvelope(start, start).flash).toBeGreaterThan(0.25)
    expect(warpFlashEnvelope(start, start).flash).toBeLessThan(0.45)

    // One peak, in the measured window, and nothing flat around it.
    const at = (dt: number) => warpFlashEnvelope(start, start + dt).flash
    expect(at(7)).toBe(1)
    expect(at(4)).toBeGreaterThan(0.85)
    expect(at(4)).toBeLessThan(1)
    expect(at(11)).toBeGreaterThan(0.7)
    expect(at(11)).toBeLessThan(1)

    // Monotone up to the peak and monotone down after it, at quarter frames —
    // a hump with a dent in it would still pass the endpoints above.
    for (let dt = -3.5; dt < 6; dt += 0.25) {
      expect(at(dt + 0.25), `rising at t=${dt}`).toBeGreaterThanOrEqual(at(dt))
    }
    for (let dt = 9; dt < 16.5; dt += 0.25) {
      expect(at(dt + 0.25), `falling at t=${dt}`).toBeLessThanOrEqual(at(dt))
    }
  })
})

describe('routePosition', () => {
  const beat = (frame: number, x: number, y: number, z: number) => ({
    frame,
    position: UV.fromMeters(x, y, z),
  })

  it('passes through every beat and holds outside the ends', () => {
    const beats = [
      beat(0, 0, 0, 0),
      beat(100, 5e9, 1e6, 0),
      beat(250, 8e9, -2e6, 3e9),
      beat(400, 8.5e9, 0, 9e9),
    ]
    for (const b of beats) {
      expect(
        UV.distance(routePosition(beats, b.frame), b.position),
      ).toBeLessThan(1)
    }
    expect(UV.distance(routePosition(beats, -50), beats[0]!.position)).toBe(0)
    expect(UV.distance(routePosition(beats, 999), beats[3]!.position)).toBe(0)
  })

  it('is continuous across beat boundaries at AU scale', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            x: fc.double({ min: -1e12, max: 1e12, noNaN: true }),
            y: fc.double({ min: -1e10, max: 1e10, noNaN: true }),
            z: fc.double({ min: -1e12, max: 1e12, noNaN: true }),
          }),
          { minLength: 3, maxLength: 6 },
        ),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        (points, where) => {
          const beats = points.map((p, i) => beat(i * 120, p.x, p.y, p.z))
          const frame = where * 120 * (points.length - 1)
          const a = routePosition(beats, frame)
          const b = routePosition(beats, frame + 0.001)
          // The bound is the route's own speed: the largest leg is ~2e12 m
          // over 120 frames, so a millframe step moves at most ~2e7 m even
          // with Hermite overshoot; continuity failure would be AU-sized.
          return UV.distance(a, b) < 1e8
        },
      ),
    )
  })
})

describe('routeOrientation', () => {
  it('holds the end orientations and stays normalized', () => {
    const a = Q.fromAxisAngle(vec3(0, 1, 0), 0.3)
    const b = Q.fromAxisAngle(vec3(1, 0, 0), -0.9)
    const beats = [
      { frame: 10, orientation: a },
      { frame: 60, orientation: b },
    ]
    expect(Q.approxEquals(routeOrientation(beats, 0), a, 1e-9)).toBe(true)
    expect(Q.approxEquals(routeOrientation(beats, 99), b, 1e-9)).toBe(true)
    fc.assert(
      fc.property(fc.double({ min: 0, max: 70, noNaN: true }), (f) => {
        const q = routeOrientation(beats, f)
        const n = Math.hypot(q.x, q.y, q.z, q.w)
        return Math.abs(n - 1) < 1e-6
      }),
    )
  })
})

describe('frameTwoTargets', () => {
  it('puts the primary target exactly at its screen position', () => {
    fc.assert(
      fc.property(
        unitVec,
        unitVec,
        fc.double({ min: 0.2, max: 0.8, noNaN: true }),
        fc.double({ min: 0.2, max: 0.8, noNaN: true }),
        (dirA, dirB, x, y) => {
          // Two targets a few degrees apart, or the framing is degenerate.
          fc.pre(Math.abs(Vec.dot(dirA, dirB)) < 0.999)
          const camera = UV.fromMeters(1e10, -3e9, 5e8)
          const fov = 45
          const aspect = 16 / 9
          const primary = {
            at: UV.translate(camera, Vec.scale(dirA, 1e9)),
            x,
            y,
          }
          const secondary = {
            at: UV.translate(camera, Vec.scale(dirB, 2e9)),
            x: 0.3,
            y: 0.5,
          }
          const q = frameTwoTargets(camera, primary, secondary, fov, aspect)

          // Project the primary through the resulting orientation and read
          // back its screen position.
          const view = Q.rotateInverse(
            q,
            Vec.normalize(UV.difference(primary.at, camera)),
          )
          fc.pre(view.z < -1e-6)
          const tanHalf = Math.tan((fov * Math.PI) / 360)
          const sx = (view.x / -view.z / (tanHalf * aspect) + 1) / 2
          const sy = (1 - view.y / -view.z / tanHalf) / 2
          return Math.abs(sx - x) < 1e-6 && Math.abs(sy - y) < 1e-6
        },
      ),
    )
  })

  it('keeps the secondary on the correct side of the primary', () => {
    // The solver cannot promise the secondary's exact position — the camera's
    // standoff fixes the pair's angular separation — but the screen-space
    // *direction* from primary to secondary must match, or a match cut framed
    // with it would mirror the composition.
    const camera = UV.fromMeters(0, 0, 0)
    const primary = { at: UV.fromMeters(0, 0, -1e9), x: 0.66, y: 0.55 }
    const secondary = { at: UV.fromMeters(-2e8, 1e8, -1e9), x: 0.45, y: 0.43 }
    const q = frameTwoTargets(camera, primary, secondary, 45, 16 / 9)
    const tanHalf = Math.tan((45 * Math.PI) / 360)
    const screenOf = (at: { x: number; y: number; z: number }) => {
      const view = Q.rotateInverse(q, Vec.normalize(at))
      return {
        x: (view.x / -view.z / (tanHalf * (16 / 9)) + 1) / 2,
        y: (1 - view.y / -view.z / tanHalf) / 2,
      }
    }
    const a = screenOf(UV.difference(primary.at, camera))
    const b = screenOf(UV.difference(secondary.at, camera))
    expect(b.x).toBeLessThan(a.x)
    expect(b.y).toBeLessThan(a.y)
  })
})

describe('lookAlong', () => {
  it('aims −Z along forward with +Y leaning to the hint', () => {
    fc.assert(
      fc.property(unitVec, unitVec, (forward, hint) => {
        fc.pre(Math.abs(Vec.dot(forward, hint)) < 0.99)
        const q = lookAlong(forward, hint)
        const aimed = Q.rotate(q, vec3(0, 0, -1))
        const up = Q.rotate(q, vec3(0, 1, 0))
        return Vec.dot(aimed, forward) > 1 - 1e-9 && Vec.dot(up, hint) > -1e-9
      }),
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Straight paths                                                             */
/* ------------------------------------------------------------------------- */

const POLE = vec3(0, 1, 0)
const DIRECTION = Vec.normalize(vec3(-0.28, 0.06, 0.96))
const ANCHOR = vec3(120, -30, -80)

/**
 * A cruise-shaped approach: 4 km out, nearly holding range through the middle,
 * then covering the last 1.4 km in a hundred frames — f676–f896 in miniature.
 * The advance is negative because `direction` is the direction of flight and
 * the anchor is where the pass *ends*: the hull closes on it from −4000 m.
 */
const CRUISE: LinePath = {
  anchor: ANCHOR,
  direction: DIRECTION,
  advance: [
    { frame: 676, t: -4000 },
    { frame: 760, t: -1800 },
    { frame: 792, t: -1400 },
    { frame: 896, t: -60 },
  ],
}

/** Four decades in forty frames, unevenly spaced — the wipe approach's shape. */
const DECADES: LinePath = {
  anchor: ANCHOR,
  direction: DIRECTION,
  advance: [
    { frame: 0, t: -40000 },
    { frame: 10, t: -4000 },
    { frame: 20, t: -400 },
    { frame: 30, t: -60 },
    { frame: 40, t: -40 },
  ],
}

/** Signed distance along the line, recovered from an evaluated position. */
const advanceAt = (path: LinePath, frame: number): number =>
  Vec.dot(Vec.sub(linePosition(path, frame), path.anchor), path.direction)

/** How far off the anchor-direction line an evaluated position sits. */
const offLine = (path: LinePath, frame: number): number => {
  const d = Vec.sub(linePosition(path, frame), path.anchor)
  return Vec.length(
    Vec.sub(d, Vec.scale(path.direction, Vec.dot(d, path.direction))),
  )
}

/**
 * The same non-uniform Catmull-Rom the routes use, in the channel's own units
 * — i.e. what `linePosition` would be if it did not take the log first. Here
 * to make the overshoot test an assertion against the actual failure rather
 * than against a smooth-looking curve.
 */
const linearSpline = (
  frames: readonly number[],
  values: readonly number[],
  frame: number,
): number => {
  const n = frames.length
  if (frame <= (frames[0] as number)) return values[0] as number
  if (frame >= (frames[n - 1] as number)) return values[n - 1] as number
  let i = 0
  while (i + 1 < n && frame >= (frames[i + 1] as number)) i += 1
  const f1 = frames[i] as number
  const f2 = frames[i + 1] as number
  const f0 = frames[Math.max(0, i - 1)] as number
  const f3 = frames[Math.min(n - 1, i + 2)] as number
  const v0 = values[Math.max(0, i - 1)] as number
  const v1 = values[i] as number
  const v2 = values[i + 1] as number
  const v3 = values[Math.min(n - 1, i + 2)] as number
  const span = f2 - f1
  const t = (frame - f1) / span
  const m1 = ((v2 - v0) * span) / (f2 - f0)
  const m2 = ((v3 - v1) * span) / (f3 - f1)
  const t2 = t * t
  const t3 = t2 * t
  return (
    (2 * t3 - 3 * t2 + 1) * v1 +
    (t3 - 2 * t2 + t) * m1 +
    (-2 * t3 + 3 * t2) * v2 +
    (t3 - t2) * m2
  )
}

describe('linePosition', () => {
  it('never leaves the line, and closes monotonically', () => {
    let previous = Number.NEGATIVE_INFINITY
    let range = Number.POSITIVE_INFINITY
    for (let frame = 676; frame <= 896; frame += 0.25) {
      /*
       * The property the whole design buys, and the one a screen-space spline
       * cannot promise: the hull is on the line at every frame, not only at
       * the knots. The bound is double rounding in a 4 km projection, which
       * measures about 1e-12 m — a micron is six orders of margin and still
       * some thirty orders below anything the frame can show.
       */
      expect(offLine(CRUISE, frame)).toBeLessThan(1e-6)
      const t = advanceAt(CRUISE, frame)
      expect(t).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = t
      // Monotone range as well as monotone advance: the pass ends before its
      // closest approach, so distance from the lens falls all the way through.
      const r = Vec.length(linePosition(CRUISE, frame))
      expect(r).toBeLessThanOrEqual(range + 1e-9)
      range = r
    }
    expect(previous).toBeCloseTo(-60, 6)
  })

  it('splines the advance in log space, so four decades cannot overshoot', () => {
    const frames = DECADES.advance.map((beat) => beat.frame)
    const values = DECADES.advance.map((beat) => beat.t)
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    for (let frame = 0; frame <= 40; frame += 0.25) {
      const t = advanceAt(DECADES, frame)
      expect(t).toBeGreaterThanOrEqual(lo - 1e-6)
      expect(t).toBeLessThanOrEqual(hi + 1e-6)
    }
    /*
     * The failure being asserted against is specific rather than aesthetic.
     * Over these same knots the interpolant in meters reaches +28.7 m at f15 —
     * the far side of the anchor, with the hull through the lens and gone —
     * because its tangent at the near end is set by the far one. In log space
     * the hull is still 1.2 km out and closing, which is where a four-decade
     * approach with these knots physically is.
     */
    expect(linearSpline(frames, values, 15)).toBeGreaterThan(0)
    expect(advanceAt(DECADES, 15)).toBeLessThan(-400)
    expect(advanceAt(DECADES, 15)).toBeGreaterThan(-4000)
  })

  it('holds outside the ends', () => {
    expect(
      Vec.distance(linePosition(DECADES, -50), linePosition(DECADES, 0)),
    ).toBe(0)
    expect(
      Vec.distance(linePosition(DECADES, 999), linePosition(DECADES, 40)),
    ).toBe(0)
    // The held value is the authored knot, up to the exp∘log round trip —
    // a couple of ulps, which on 40 km is tens of nanometers.
    expect(advanceAt(DECADES, -50)).toBeCloseTo(-40000, 6)
    expect(Vec.length(lineVelocity(DECADES, -50))).toBe(0)
    expect(Vec.length(lineVelocity(DECADES, 999))).toBe(0)
  })

  it('refuses an advance that crosses the anchor rather than clamping it', () => {
    const crossing = {
      ...CRUISE,
      advance: [
        { frame: 0, t: -100 },
        { frame: 10, t: 100 },
      ],
    }
    expect(() => linePosition(crossing, 5)).toThrow(/one side of the anchor/)
    expect(() => lineVelocity(crossing, 5)).toThrow(/one side of the anchor/)
    // Touching the anchor is a crossing too: log(0) is not a range, and the
    // alternative to refusing is a hull frozen on the anchor for the rest of
    // the pass.
    const touching = {
      ...CRUISE,
      advance: [
        { frame: 0, t: -100 },
        { frame: 10, t: 0 },
      ],
    }
    expect(() => linePosition(touching, 5)).toThrow(/one side of the anchor/)
  })
})

describe('lineVelocity', () => {
  it('is parallel to the line and points the way the advance runs', () => {
    for (let frame = 0.5; frame <= 39.5; frame += 0.25) {
      const v = lineVelocity(DECADES, frame)
      const along = Vec.dot(v, DIRECTION)
      // The bound is rounding on a vector whose length reaches 8 km/frame at
      // the far end of the profile; the perpendicular component measures 1e-12.
      expect(Vec.length(Vec.sub(v, Vec.scale(DIRECTION, along)))).toBeLessThan(
        1e-9,
      )
      // The advance rises (−40 000 → −40 m), so travel is along +direction.
      expect(along).toBeGreaterThan(0)
    }
    // Reversing the pass — negate `direction` and every `t` — describes the
    // identical line, and the velocity flips with it.
    const reversed: LinePath = {
      anchor: ANCHOR,
      direction: Vec.negate(DIRECTION),
      advance: DECADES.advance.map((beat) => ({ ...beat, t: -beat.t })),
    }
    expect(
      Vec.distance(linePosition(reversed, 15), linePosition(DECADES, 15)),
    ).toBeLessThan(1e-6)
    expect(Vec.dot(lineVelocity(reversed, 15), DIRECTION)).toBeGreaterThan(0)
  })

  it('is the derivative of the position, not a difference of the frame', () => {
    for (let frame = 1; frame <= 39; frame += 0.37) {
      const h = 0.01
      const analytic = lineVelocity(DECADES, frame)
      const measured = Vec.scale(
        Vec.sub(
          linePosition(DECADES, frame + h),
          linePosition(DECADES, frame - h),
        ),
        1 / (2 * h),
      )
      const relative =
        Vec.distance(analytic, measured) / Math.max(Vec.length(analytic), 1e-12)
      // The bound is the *central difference's* own truncation, which is
      // O(h²) and measures 5e-6 here — not the derivative's, which is exact.
      expect(relative).toBeLessThan(1e-4)
    }
  })
})

describe('orientationAlong', () => {
  it('is one constant attitude, with the nose on the line', () => {
    const q = orientationAlong(CRUISE, POLE)
    expect(Vec.dot(Q.rotate(q, vec3(0, 0, -1)), DIRECTION)).toBeGreaterThan(
      1 - 1e-12,
    )
    // From just inside the first beat: on it and before it the pass is held,
    // so the velocity is zero and has no heading to agree with.
    for (let frame = 676.5; frame <= 896; frame += 5) {
      // Constant is the entire point, and the signature is what enforces it:
      // there is no frame to pass. Sampling asserts the consequence — the nose
      // sits on the velocity at every frame, which is what "sliding" means
      // when it fails.
      expect(Q.equals(orientationAlong(CRUISE, POLE), q)).toBe(true)
      const heading = Vec.normalize(lineVelocity(CRUISE, frame))
      expect(Vec.dot(Q.rotate(q, vec3(0, 0, -1)), heading)).toBeGreaterThan(
        1 - 1e-12,
      )
    }
  })
})

describe('a mirrored pass', () => {
  /*
   * The reference shot its fly-through wipe once and played it three times,
   * the middle one flipped — so `LinePath`'s claim that a mirrored pass is
   * "the same path with the lateral components of `anchor` and `direction`
   * negated" is not a convenience, it is the measurement. This is that claim.
   *
   * The bound is zero, and it is zero for a reason rather than by luck.
   * Negation is exact in IEEE-754 and every operation between an input and
   * these outputs is sign-symmetric: `anchor + direction · t` flips its x
   * termwise, the advance profile never sees x at all, and `lookAlong`
   * normalizes against a length whose x contributes only as x². So the
   * assertion is equality, not a tolerance — a tolerance here would hide
   * exactly the kind of drift that made a mirrored pass need its own beat
   * list in the first place.
   */
  const flip = (v: Vec3): Vec3 => vec3(-v.x, v.y, v.z)
  const axis = (path: LinePath, local: Vec3): Vec3 =>
    Q.rotate(orientationAlong(path, POLE), local)

  it('reflects position, velocity and the nose exactly, and hands the roll over', () => {
    fc.assert(
      fc.property(
        unitVec,
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -5, max: 45, noNaN: true }),
        (direction, ax, ay, az, frame) => {
          // A pass flown straight up the pole has no horizon to level and
          // `lookAlong` falls back to a hint that is not itself mirror-
          // symmetric, so the reflected frame would differ by a half turn of
          // roll. The same exclusion the `lookAlong` property makes.
          fc.pre(Math.abs(Vec.dot(direction, POLE)) < 0.99)
          const path: LinePath = {
            anchor: vec3(ax, ay, az),
            direction,
            advance: DECADES.advance,
          }
          const mirrored: LinePath = {
            anchor: flip(path.anchor),
            direction: flip(direction),
            advance: path.advance,
          }
          expect(
            Vec.distance(
              flip(linePosition(path, frame)),
              linePosition(mirrored, frame),
            ),
          ).toBe(0)
          expect(
            Vec.distance(
              flip(lineVelocity(path, frame)),
              lineVelocity(mirrored, frame),
            ),
          ).toBe(0)
          expect(
            Vec.distance(
              flip(axis(path, vec3(0, 0, -1))),
              axis(mirrored, vec3(0, 0, -1)),
            ),
          ).toBe(0)
          expect(
            Vec.distance(
              flip(axis(path, vec3(0, 1, 0))),
              axis(mirrored, vec3(0, 1, 0)),
            ),
          ).toBe(0)
          /*
           * And the third axis comes back *negated*, because a reflection is
           * improper: the mirrored hull's right hand is its left. That is not
           * a curiosity — it is why an authored bank has to change sign with
           * the mirror, and a mirrored pass that keeps its bank rolls the
           * wrong way while every other channel agrees.
           */
          expect(
            Vec.distance(
              Vec.negate(flip(axis(path, vec3(1, 0, 0)))),
              axis(mirrored, vec3(1, 0, 0)),
            ),
          ).toBe(0)
        },
      ),
    )
  })
})

describe('withAttitude', () => {
  // The bank-away's last authored facing, as `tngIntro.ts` writes it.
  const base = lookAlong(vec3(-0.62, -0.15, -0.77), POLE)

  it('is the identity at zero and reproduces the authored banks exactly', () => {
    expect(Q.equals(withAttitude(base, 0, 0), base)).toBe(true)
    /*
     * The migration has to be a numerical no-op or every authored bank in
     * `tngIntro.ts` quietly changes meaning. `facingBeats` builds one as a
     * Z-axis rotation right-multiplied onto `lookAlong`; so does this, in the
     * same order and with no renormalization, so the two agree exactly rather
     * than within a tolerance. These are the numbers actually in the script.
     */
    for (const deg of [-18, -14, -8, 4, 5, 8]) {
      const authored = Q.multiply(
        base,
        Q.fromAxisAngle(vec3(0, 0, 1), (deg * Math.PI) / 180),
      )
      expect(Q.equals(withAttitude(base, deg, 0), authored)).toBe(true)
    }
  })

  it('banks about the nose and pitches about the derived frame', () => {
    const forward = Q.rotate(base, vec3(0, 0, -1))
    const up = Q.rotate(base, vec3(0, 1, 0))
    // A bank is roll: it moves the horizon, not the flight direction.
    const banked = withAttitude(base, 20, 0)
    expect(Vec.dot(Q.rotate(banked, vec3(0, 0, -1)), forward)).toBeGreaterThan(
      1 - 1e-12,
    )
    expect(Vec.dot(Q.rotate(banked, vec3(0, 1, 0)), up)).toBeCloseTo(
      Math.cos((20 * Math.PI) / 180),
      12,
    )
    // Positive pitch is nose up, measured against the derived frame's own up.
    const pitched = withAttitude(base, 0, 12)
    const nose = Q.rotate(pitched, vec3(0, 0, -1))
    expect(Vec.dot(nose, forward)).toBeCloseTo(
      Math.cos((12 * Math.PI) / 180),
      12,
    )
    expect(Vec.dot(nose, up)).toBeCloseTo(Math.sin((12 * Math.PI) / 180), 12)
  })
})
