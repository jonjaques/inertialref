import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import {
  easeIn,
  easeOut,
  expApproach,
  fadeEnvelope,
  frameTwoTargets,
  lookAlong,
  routeOrientation,
  routePosition,
  smooth,
  warpFlashEnvelope,
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
     * calls a title visible once its mask clears a colour floor the text only
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
  it('matches the measured 4/7/4 shape and is symmetric', () => {
    const start = 1085
    expect(warpFlashEnvelope(start, start - 1).flash).toBe(0)
    expect(warpFlashEnvelope(start, start + 16).flash).toBe(0)
    // Whiteout holds at 1 through the middle seven frames.
    for (let f = start + 4; f <= start + 11; f += 1) {
      expect(warpFlashEnvelope(start, f).flash).toBe(1)
    }
    // Build and resolve mirror each other about the centre of the window.
    for (const dt of [0.5, 1, 2, 3, 3.5]) {
      expect(warpFlashEnvelope(start, start + dt).flash).toBeCloseTo(
        warpFlashEnvelope(start, start + 15 - dt).flash,
        9,
      )
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
  it('holds the end orientations and stays normalised', () => {
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
