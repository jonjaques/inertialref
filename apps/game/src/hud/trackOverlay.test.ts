import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  openSession,
  screenPositionOf,
  TNG_CUTS,
  TNG_HULL_LENGTH,
  TNG_LENS,
} from '@inertialref/devtools'
import { apparentWidth } from '@inertialref/rendering'
import { Quaternion as Q, Vec, vec3 } from '@inertialref/spatial'
import {
  angleBetween,
  CHORD_STEP,
  frameToPixels,
  indexTrack,
  noseOf,
  offsetOf,
  offsetOfSample,
  projectDirection,
  projectHull,
  referenceAt,
  shotAt,
  VELOCITY_STEP,
} from './trackOverlay.ts'

/*
 * The track overlay's arithmetic, in Node.
 *
 * The component is a rAF loop that writes SVG attributes and there is no
 * browser here to run it in — so everything that can be *wrong* lives in
 * `trackOverlay.ts` and is tested here instead: the projection, the pixel
 * mapping, the shape of the checked-in export, and the velocity's independence
 * from the playhead.
 *
 * What is deliberately **not** asserted is the choreography. The overlay exists
 * to show where the render and the reference disagree; a test that pinned those
 * disagreements would go red every time somebody improved one, and would be
 * asserting today's defects. The plan's §7.4 is where the choreography
 * properties belong.
 */

const TRACK = fileURLToPath(
  new URL('../../../../data/reference/tng-subject-track.json', import.meta.url),
)

describe('the reference subject track', () => {
  const track = indexTrack(readFileSync(TRACK, 'utf8'))

  it('carries the frames its own header claims', () => {
    // The header says 1,639 of 2,742 frames were detected; the index must
    // agree, or the overlay is drawing a ghost box for a frame nobody measured.
    expect(track.size).toBe(1639)
  })

  it('is normalized 0..1 with the origin at the top left', () => {
    for (const row of track.values()) {
      expect(row.cx).toBeGreaterThanOrEqual(0)
      expect(row.cx).toBeLessThanOrEqual(1)
      expect(row.cy).toBeGreaterThanOrEqual(0)
      expect(row.cy).toBeLessThanOrEqual(1)
      expect(row.w).toBeGreaterThan(0)
      expect(row.w).toBeLessThanOrEqual(1)
    }
  })

  it('rounds to a frame and reports nothing where the tracker found nothing', () => {
    // f916 is the close pass, tracked and saturated: the hull fills the frame.
    expect(referenceAt(track, 916.4)?.frame).toBe(916)
    expect(referenceAt(track, 915.6)?.frame).toBe(916)
    // f0 is black. A missing row is a real answer, not a gap to interpolate.
    expect(referenceAt(track, 0)).toBeNull()
    expect(referenceAt(null, 916)).toBeNull()
  })
})

describe('projecting the render into the reference frame', () => {
  it('puts a hull dead ahead in the middle of the frame', () => {
    const offset = vec3(0, 0, -1000)
    const hull = projectHull(offset, vec3(0, 0, -1), Vec.ZERO, Vec.ZERO)
    expect(hull.x).toBeCloseTo(0.5, 12)
    expect(hull.y).toBeCloseTo(0.5, 12)
    expect(hull.range).toBeCloseTo(1000, 9)
  })

  it('boxes the hull at the same width the tracker would report', () => {
    const hull = projectHull(
      vec3(0, 0, -2000),
      vec3(0, 0, -1),
      Vec.ZERO,
      Vec.ZERO,
    )
    expect(hull.width).toBeCloseTo(
      apparentWidth(TNG_HULL_LENGTH, 2000, TNG_LENS.fov, TNG_LENS.aspect),
      12,
    )
  })

  it('foreshortens a vector pointing down the view axis to nothing', () => {
    const offset = vec3(0, 0, -1000)
    // Square to the view: full length, and to the right of the frame.
    const across = projectDirection(offset, vec3(1, 0, 0))
    expect(across.foreshortening).toBeCloseTo(1, 6)
    expect(across.dx).toBeGreaterThan(0)
    expect(across.dy).toBeCloseTo(0, 12)
    // Straight away from the lens: a heading with no shadow on screen.
    const away = projectDirection(offset, vec3(0, 0, -1))
    expect(away.foreshortening).toBeCloseTo(0, 6)
  })

  it('declines a probe that would land behind the lens', () => {
    // Close to the camera and pointing back past it: the perspective divide
    // flips sign there and would project the tip to the other side of the frame.
    const behind = projectDirection(vec3(0, 0, -10), vec3(0, 0, 1))
    expect(behind).toEqual({ dx: 0, dy: 0, foreshortening: 0 })
  })

  it('always has something drawable to say, from anywhere in front of the lens', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: fc.double({ min: -1e5, max: 1e5, noNaN: true }),
          y: fc.double({ min: -1e5, max: 1e5, noNaN: true }),
          // Forward is −Z, so anything in front of the lens has a negative z.
          z: fc.double({ min: -1e8, max: -1, noNaN: true }),
        }),
        fc.record({
          x: fc.double({ min: -1, max: 1, noNaN: true }),
          y: fc.double({ min: -1, max: 1, noNaN: true }),
          z: fc.double({ min: -1, max: 1, noNaN: true }),
        }),
        fc.double({ min: 0.001, max: 1000, noNaN: true }),
        (offset, direction, gain) => {
          /*
           * A direction with no length is not a heading, and the generator will
           * otherwise offer subnormals — 5e-324 scales to exactly zero, which
           * is a float underflow rather than anything this function decides.
           * `projectDirection` still answers that case, with a zero vector; it
           * is the scale-invariance half below that cannot hold across it.
           */
          fc.pre(Vec.lengthSquared(direction) > 1e-12)
          const projected = projectDirection(offset, direction)
          expect(Number.isFinite(projected.dx)).toBe(true)
          expect(Number.isFinite(projected.dy)).toBe(true)
          expect(projected.foreshortening).toBeGreaterThanOrEqual(0)
          expect(projected.foreshortening).toBeLessThanOrEqual(1)
          /*
           * A heading, not a speed: only the direction may reach the screen —
           * the magnitude is reported separately, as `speed`.
           *
           * Relative rather than absolute, and 1e-9 rather than exact.
           * `normalize` divides by a length computed from the scaled input, so
           * the two agree to double precision and not to the bit; the deltas
           * here reach magnitude 5 for an extremely off-axis offset, where
           * twelve decimal places is 5e-13 and the real disagreement is 7e-12.
           */
          const scaled = projectDirection(offset, Vec.scale(direction, gain))
          const near = (a: number, b: number): boolean =>
            Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b))
          expect(near(scaled.dx, projected.dx)).toBe(true)
          expect(near(scaled.dy, projected.dy)).toBe(true)
        },
      ),
    )
  })

  it('reads +Y in camera axes as up the frame', () => {
    const up = projectDirection(vec3(0, 0, -1000), vec3(0, 1, 0))
    // y is down in this space, so up the frame is a negative delta.
    expect(up.dy).toBeLessThan(0)
  })

  it('inverts screenPositionOf, which is what makes the boxes comparable', () => {
    const offset = vec3(120, -45, -900)
    const placed = screenPositionOf(offset)
    const hull = projectHull(offset, vec3(0, 0, -1), Vec.ZERO, Vec.ZERO)
    expect(hull.x).toBeCloseTo(placed.x, 12)
    expect(hull.y).toBeCloseTo(placed.y, 12)
  })
})

describe('the pixel mapping', () => {
  it('spends the whole height on the authored frame, whatever the window', () => {
    for (const width of [1509, 900, 2400]) {
      const map = frameToPixels(width, 849)
      expect(map.y(0)).toBeCloseTo(0, 9)
      expect(map.y(1)).toBeCloseTo(849, 9)
      // Centred horizontally: the composition's middle is the window's middle.
      expect(map.x(0.5)).toBeCloseTo(width / 2, 9)
      // And one authored frame is 16:9 of that height, however wide the window.
      expect(map.x(1) - map.x(0)).toBeCloseTo(849 * TNG_LENS.aspect, 9)
    }
  })
})

describe('the shot label', () => {
  it('comes from the cut table the script and its tests read', () => {
    for (const cut of TNG_CUTS) {
      expect(shotAt(cut.from)).toBe(cut.id)
      expect(shotAt(cut.to)).toBe(cut.id)
    }
    expect(shotAt(-1)).toBe('—')
  })
})

describe('the hull against the live script', () => {
  /*
   * The overlay's whole claim, exercised against the real director: sample the
   * scene, project the hull, and check that what comes out is the thing the
   * reference is measured in. `peek` is used the way the component uses it —
   * a central difference either side of the frame on screen — so a regression
   * in either would show up here rather than in a browser.
   */
  const session = openSession({ seed: 'inertialref', workers: null })
  const harness = session.harness
  harness.play('tng-intro')
  // The first sample anchors frame 0 to its epoch; ask for it before anything
  // else or every later frame is offset by the one that was asked for first.
  harness.cutsceneSample(harness.world.clock.renderTime)

  const at = (frame: number) => {
    const sample = harness.cutscenePeek(frame)
    if (sample === null) throw new Error(`no sample at f${frame}`)
    const offset = offsetOfSample(sample)
    const difference = (half: number) => {
      const before = harness.cutscenePeek(frame - half)
      const after = harness.cutscenePeek(frame + half)
      if (before === null || after === null) throw new Error('no neighbours')
      return Vec.scale(
        Vec.sub(offsetOfSample(after), offsetOfSample(before)),
        1 / (2 * half),
      )
    }
    const velocity = difference(CHORD_STEP)
    const nose = noseOf(sample.camera.orientation, sample.ship.orientation)
    return {
      sample,
      velocity,
      hull: projectHull(offset, nose, velocity, difference(VELOCITY_STEP)),
    }
  }

  it('peeking never moves the playhead', () => {
    const before = harness.cutsceneStatus()?.frame
    harness.cutscenePeek(2100)
    harness.cutscenePeek(400)
    expect(harness.cutsceneStatus()?.frame).toBe(before)
  })

  it('places the hull inside the frame through the credit run', () => {
    for (const frame of [916, 1440, 2100]) {
      const { hull } = at(frame)
      expect(Number.isFinite(hull.x)).toBe(true)
      expect(hull.x).toBeGreaterThan(-0.5)
      expect(hull.x).toBeLessThan(1.5)
      expect(hull.range).toBeGreaterThan(0)
      expect(hull.width).toBeGreaterThan(0)
    }
  })

  it('reads the same velocity wherever the playhead happens to be', () => {
    /*
     * The design promise, and the reason the velocity comes from `peek` rather
     * than from the difference of two rendered frames: it is a function of the
     * frame being *asked about*, not of when it was asked. Differencing rAF
     * ticks reads zero while paused — which is every frame of the capture loop
     * this overlay serves — and a spike on the tick after a seek.
     */
    const still = at(1440).velocity
    harness.seekCutscene(120)
    harness.cutsceneSample(harness.world.clock.renderTime)
    const seeked = at(1440).velocity
    expect(seeked.x).toBe(still.x)
    expect(seeked.y).toBe(still.y)
    expect(seeked.z).toBe(still.z)
  })

  it('projects all three vectors to something drawable at every sampled shot', () => {
    /*
     * Not an assertion about the choreography. The nose is *supposed* to be
     * able to leave the flight path — `PITCH_CRUISE` flies the hull nose-down
     * along a climbing track on purpose, and the bank-away from f880 is an
     * authored maneuver — so pinning any angle here would assert a staging
     * decision as if it were a law. What must hold is that whatever the script
     * does, the overlay has something finite to draw: a NaN is an invisible
     * vector rather than a wrong one, which is the failure mode a debug surface
     * can least afford.
     */
    for (const cut of TNG_CUTS) {
      for (const frame of [cut.from, (cut.from + cut.to) / 2, cut.to]) {
        const { hull } = at(frame)
        for (const vector of [hull.nose, hull.velocity, hull.instant]) {
          expect(Number.isFinite(vector.dx)).toBe(true)
          expect(Number.isFinite(vector.dy)).toBe(true)
          expect(vector.foreshortening).toBeGreaterThanOrEqual(0)
          expect(vector.foreshortening).toBeLessThanOrEqual(1)
        }
        expect(Number.isFinite(hull.speed)).toBe(true)
        expect(hull.jitterDeg).toBeGreaterThanOrEqual(0)
        expect(hull.jitterDeg).toBeLessThanOrEqual(180)
      }
    }
  })

  it('reports no jitter where the two windows measure the same straight run', () => {
    /*
     * The chord and the half-frame difference are the same vector whenever the
     * hull is genuinely on a line, and `jitterDeg` is how far apart they have
     * drifted. Synthetic rather than sampled, so it tests the channel and not
     * whichever stretch of the script happens to be straight this week.
     */
    const along = vec3(3, -1, 0)
    // 1e-5°, and the limit is `acos`, not the arithmetic: it is ill-conditioned
    // where its argument approaches ±1, so two parallel unit vectors whose dot
    // product is one ulp short of 1 come back about √ε radians apart. Anti-
    // parallel is the same corner at the other end.
    expect(angleBetween(along, Vec.scale(along, 8))).toBeLessThan(1e-5)
    expect(180 - angleBetween(along, Vec.negate(along))).toBeLessThan(1e-4)
    // A still hull disagrees with nothing; zero rather than NaN.
    expect(angleBetween(Vec.ZERO, along)).toBe(0)
    const still = projectHull(
      vec3(0, 0, -1000),
      vec3(0, 0, -1),
      Vec.ZERO,
      Vec.ZERO,
    )
    expect(still.jitterDeg).toBe(0)
  })

  it('reads the same offset in render space as in universe space', () => {
    /*
     * The component takes the frame on screen from `engine.cinematic`, which is
     * render space, and only its *neighbours* from `peek`, which is universe
     * space. If those two disagreed, the velocity would belong to a different
     * hull from the box it is drawn on. They cannot: render space is a rebase,
     * so a translation common to the camera and the hull cancels in the
     * subtraction — which is what this asserts, with the origin standing in as
     * an arbitrary rebase.
     */
    const sample = harness.cutscenePeek(1440)
    if (sample === null) throw new Error('no sample at f1440')
    const universe = offsetOfSample(sample)
    const rebase = vec3(4096, -8192, 65536)
    const render = offsetOf(
      { position: rebase, orientation: sample.camera.orientation },
      {
        position: Vec.add(
          rebase,
          Q.rotate(sample.camera.orientation, universe),
        ),
      },
    )
    expect(render.x).toBeCloseTo(universe.x, 6)
    expect(render.y).toBeCloseTo(universe.y, 6)
    expect(render.z).toBeCloseTo(universe.z, 6)
    expect(screenPositionOf(render).range).toBeCloseTo(Vec.length(universe), 6)
  })
})
