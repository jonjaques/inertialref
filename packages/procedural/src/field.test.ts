import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fbmField, gradientNoise3, ridgedField } from './field.ts'
import { fbm3, noise3, ridged3 } from './noise.ts'
import { latticeSeed, pcg3d, pcg4d, toUnit } from './lattice.ts'
import { falloff, ring, smoothstep } from './profile.ts'
import { rootSeed } from './seed.ts'

const ROOT = rootSeed('inertialref')

describe('the lattice hash', () => {
  /*
   * Golden vectors, for the same reason the seed derivation has them: a feature
   * field places craters by hashing a cell, so a silent change here moves every
   * crater on every world. If a change is deliberate it comes with a terrain
   * version bump and these move in the same commit.
   */
  it('matches golden vectors', () => {
    expect(pcg3d(1, 2, 3)).toEqual({
      x: 4_204_755_366,
      y: 1_223_881_804,
      z: 1_500_469_937,
    })
    expect(pcg4d(-4, 5, 6, 7)).toEqual({
      x: 197_867_515,
      y: 1_582_443_005,
      z: 3_721_236_503,
      w: 1_261_381_209,
    })
    expect(latticeSeed(ROOT)).toBe(2_978_377_386)
    /*
     * The gradient lattice moved when `gradientAt` stopped hashing with `pcg3d`
     * and started sharing `noise3`'s `hash3`, which is what makes the three
     * vectors below equal to their `noise.ts` counterparts to the last printed
     * digit rather than merely close. `carries the same field as noise3` holds
     * that; these pin the arithmetic underneath it.
     *
     * `TERRAIN_ALGORITHM` does not move for it. `origin/main` is on v1 and this
     * branch already carries the one bump to v2, so v2 has never described a
     * shipped world: changing what it means before it merges costs nothing,
     * where a second bump would claim a migration that never happened.
     */
    expect(gradientNoise3(ROOT, 1.5, -2.25, 3.125).value.toFixed(12)).toBe(
      '-0.279786154628',
    )
    expect(fbmField(ROOT, 0.3, 0.7, -0.1).value.toFixed(12)).toBe(
      '0.017432449097',
    )
    expect(ridgedField(ROOT, 0.3, 0.7, -0.1).value.toFixed(12)).toBe(
      '0.580459350306',
    )
    // The damped vector, which has no undamped counterpart to agree with.
    expect(
      fbmField(ROOT, 0.3, 0.7, -0.1, { damping: 4 }).value.toFixed(12),
    ).toBe('0.005871701863')
  })

  it('gives every lane the full 32 bits and decorrelates neighbors', () => {
    /*
     * The property a one-output hash called four times would also have, and the
     * one a badly folded four-output hash would not: adjacent cells must not
     * share high bits, or a crater field lays out in stripes.
     */
    let ones = 0
    let bits = 0
    let differing = 0
    for (let i = 0; i < 2_000; i += 1) {
      const a = pcg4d(i, 17, -3, 1)
      const b = pcg4d(i + 1, 17, -3, 1)
      for (const [x, y] of [
        [a.x, b.x],
        [a.y, b.y],
        [a.z, b.z],
        [a.w, b.w],
      ] as const) {
        expect(x).toBe(x >>> 0)
        for (let bit = 0; bit < 32; bit += 1) {
          if ((x >>> bit) & 1) ones += 1
          if (((x ^ y) >>> bit) & 1) differing += 1
          bits += 1
        }
      }
    }
    // Half the bits set, and half of them flipped by a one-cell step. Loose
    // bounds: this is an avalanche check, not a randomness test suite.
    expect(ones / bits).toBeGreaterThan(0.48)
    expect(ones / bits).toBeLessThan(0.52)
    expect(differing / bits).toBeGreaterThan(0.48)
    expect(differing / bits).toBeLessThan(0.52)
  })

  it('folds all four seed lanes', () => {
    // Two seeds differing only in `b` must place features differently. Taking
    // `seed.a` alone — which is what the v1 gradient noise does — would not.
    const a = { a: 1, b: 2, c: 3, d: 4 }
    expect(latticeSeed(a)).not.toBe(latticeSeed({ ...a, b: 5 }))
    expect(latticeSeed(a)).not.toBe(latticeSeed({ ...a, c: 5 }))
    expect(latticeSeed(a)).not.toBe(latticeSeed({ ...a, d: 5 }))
  })

  it('carries the same field as `noise3`, undamped', () => {
    /*
     * The claim `bands.ts` makes when it picks between `ridged3` and
     * `ridgedField` on whether the world erodes: the two give "the same number",
     * so an amplitude tuned against one reads the same against the other.
     *
     * It was false. `gradientAt` hashed with `pcg3d` where `noise3` hashes with
     * `hash3`, which is a different lattice and therefore a different landscape
     * — measured at 0.86 of separation on `fbm` and 1.25 on `ridged`, on bands
     * whose contract is [-1, 1]. Two worlds a pascal apart got unrelated
     * mountain ranges rather than the same ones slightly more worn. Sharing the
     * hash is what makes the sentence true, and this is what keeps it true.
     *
     * Float association is the only slack: the analytic form factors the
     * trilinear blend so one set of coefficients serves the value and the fade
     * half of the derivative, where `noise3` nests `lerp`s. Same arithmetic,
     * different order, ~1e-15 apart.
     */
    let worst = 0
    for (let i = 0; i < 4_000; i += 1) {
      const x = Math.cos(i * 1.7) * 40 + i * 0.013
      const y = Math.sin(i * 2.3) * 40 - i * 0.007
      const z = Math.cos(i * 0.91) * 40 + i * 0.019
      const o = { octaves: 7 }
      worst = Math.max(
        worst,
        Math.abs(noise3(ROOT, x, y, z) - gradientNoise3(ROOT, x, y, z).value),
        Math.abs(
          fbm3(ROOT, x, y, z, o) -
            fbmField(ROOT, x, y, z, { ...o, damping: 0 }).value,
        ),
        Math.abs(
          ridged3(ROOT, x, y, z, o) -
            ridgedField(ROOT, x, y, z, { ...o, damping: 0 }).value,
        ),
      )
    }
    expect(worst).toBeLessThan(1e-12)
  })

  it('converts to floats in range', () => {
    expect(toUnit(0)).toBe(0)
    expect(toUnit(0xffff_ffff)).toBeLessThan(1)
  })
})

describe('analytic-derivative noise', () => {
  /*
   * The claim the whole file exists for, checked against the definition of a
   * derivative rather than against itself: a central difference of the value
   * has to agree with the returned gradient.
   *
   * The tolerance is what a central difference can actually deliver. The step
   * is 1e-4 and the truncation error of a central difference is O(h²) times the
   * third derivative, which for quintic-faded Perlin is order 100 — so a few
   * parts in 1e5 is the floor, and anything looser than 2e-3 would also pass
   * with a sign error in one lane.
   */
  const agreesWithFiniteDifference = (
    field: (x: number, y: number, z: number) => number,
    gradient: (x: number, y: number, z: number) => readonly number[],
    tolerance = 2e-3,
  ): void => {
    fc.assert(
      fc.property(
        fc.double({ min: -8, max: 8, noNaN: true }),
        fc.double({ min: -8, max: 8, noNaN: true }),
        fc.double({ min: -8, max: 8, noNaN: true }),
        (x, y, z) => {
          const h = 1e-4
          const numeric = [
            (field(x + h, y, z) - field(x - h, y, z)) / (2 * h),
            (field(x, y + h, z) - field(x, y - h, z)) / (2 * h),
            (field(x, y, z + h) - field(x, y, z - h)) / (2 * h),
          ]
          const exact = gradient(x, y, z)
          for (let i = 0; i < 3; i += 1) {
            expect(
              Math.abs((numeric[i] as number) - (exact[i] as number)),
            ).toBeLessThan(tolerance)
          }
        },
      ),
      { numRuns: 120 },
    )
  }

  it('returns the gradient of the value it returns', () => {
    agreesWithFiniteDifference(
      (x, y, z) => gradientNoise3(ROOT, x, y, z).value,
      (x, y, z) => {
        const n = gradientNoise3(ROOT, x, y, z)
        return [n.dx, n.dy, n.dz]
      },
    )
  })

  it('carries the gradient through fBm and through the ridge fold', () => {
    agreesWithFiniteDifference(
      (x, y, z) => fbmField(ROOT, x, y, z, { octaves: 4 }).value,
      (x, y, z) => {
        const n = fbmField(ROOT, x, y, z, { octaves: 4 })
        return [n.dx, n.dy, n.dz]
      },
    )
  })

  it('carries the gradient through the ridge fold, away from the crest', () => {
    /*
     * One octave, and samples on the crest are skipped rather than tolerated.
     *
     * `1 - |n|` has a kink exactly where the noise crosses zero — that kink *is*
     * the ridge line, which is the whole point of the fold — and a central
     * difference straddling it measures a slope that exists on neither side. So
     * the property is stated where it holds: the derivative is exact off the
     * crest, and the crest is identified by the same noise value the fold reads
     * rather than by whether the check happened to pass.
     *
     * The coordinates are integers over a prime divisor rather than `fc.double`,
     * which biases hard toward whole numbers — and a whole number is a lattice
     * point, where Perlin noise is identically zero and therefore always on the
     * crest. With doubles the skip fired on 196 of 200 samples and the property
     * tested nothing, which is why the count is asserted at the end.
     */
    let checked = 0
    const coordinate = fc
      .integer({ min: -7_800, max: 7_800 })
      .map((v) => v / 977)
    fc.assert(
      fc.property(coordinate, coordinate, coordinate, (x, y, z) => {
        const h = 1e-4
        // The stencil spans 2h; a crossing anywhere inside it is a kink, and
        // |∇n| ≤ ~4 for cube-edge gradients, so 1e-3 clears it with margin.
        if (Math.abs(gradientNoise3(ROOT, x, y, z).value) < 1e-3) return
        checked += 1
        const at = (a: number, b: number, c: number): number =>
          ridgedField(ROOT, a, b, c, { octaves: 1 }).value
        const n = ridgedField(ROOT, x, y, z, { octaves: 1 })
        const numeric = [
          (at(x + h, y, z) - at(x - h, y, z)) / (2 * h),
          (at(x, y + h, z) - at(x, y - h, z)) / (2 * h),
          (at(x, y, z + h) - at(x, y, z - h)) / (2 * h),
        ]
        for (const [i, exact] of [n.dx, n.dy, n.dz].entries()) {
          expect(Math.abs((numeric[i] as number) - exact)).toBeLessThan(2e-3)
        }
      }),
      { numRuns: 200 },
    )
    // And the skip is not swallowing the whole run.
    expect(checked).toBeGreaterThan(100)
  })

  it('damps later octaves where the field is already steep', () => {
    /*
     * The erosion stand-in, as a property rather than a picture: over a
     * sampling of the field, damped fBm is nowhere rougher than plain fBm and
     * is measurably smoother overall. "Smoother" is the mean absolute step
     * between neighboring samples, which is the thing a slope-damped field is
     * supposed to reduce.
     */
    let plain = 0
    let damped = 0
    const step = 0.01
    for (let i = 0; i < 400; i += 1) {
      const x = i * step
      const at = (options: Record<string, number>): number =>
        fbmField(ROOT, x, 0.37, -1.21, { octaves: 8, ...options }).value
      const next = (options: Record<string, number>): number =>
        fbmField(ROOT, x + step, 0.37, -1.21, { octaves: 8, ...options }).value
      plain += Math.abs(next({}) - at({}))
      damped += Math.abs(next({ damping: 8 }) - at({ damping: 8 }))
    }
    expect(damped).toBeLessThan(plain)
  })
})

describe('profile primitives', () => {
  it('land on zero value and zero slope at the edge of their support', () => {
    /*
     * The reason every one of them is written the way it is: a feature that
     * stops with a slope discontinuity draws a ring at its own radius, and the
     * ring survives into the normals where it is unmissable.
     */
    const slope = (f: (t: number) => number, t: number): number =>
      (f(t + 1e-6) - f(t - 1e-6)) / 2e-6
    expect(falloff(1)).toBe(0)
    expect(Math.abs(slope(falloff, 1 - 1e-5))).toBeLessThan(1e-3)
    expect(ring(1, 0.3)).toBe(0)
    expect(ring(0, 0.3)).toBe(0)
    expect(ring(0.3, 0.3)).toBeCloseTo(1, 12)
    expect(smoothstep(0, 1, 0)).toBe(0)
    expect(smoothstep(0, 1, 1)).toBe(1)
  })

  it('are monotonic where they claim to be', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          expect(smoothstep(0, 1, lo)).toBeLessThanOrEqual(smoothstep(0, 1, hi))
          expect(falloff(lo)).toBeGreaterThanOrEqual(falloff(hi))
        },
      ),
      { numRuns: 200 },
    )
  })
})
