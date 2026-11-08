import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { WEATHER_SCENARIOS } from './weatherScenario.ts'
import {
  altitudeAlong,
  altitudeAt,
  shellBoundaries,
  shellCrossings,
  shellHeights,
  unionSpan,
} from './weatherShells.ts'

/*
 * The shells are where rule 52 is kept: a crossing and an altitude are formed
 * from heights, and the arithmetic is held here as a property of the formula
 * itself, beside `cloudGeometry.gpu.test.ts`, which holds the TSL port to the
 * same bounds on the real GPU.
 */

/** Bodies from a 100 km moon to a gas giant. */
const radius = fc.double({ min: 1e5, max: 1e8, noNaN: true })
/** From under the sea to a low orbit. */
const height = fc.double({ min: -1e4, max: 4e5, noNaN: true })
const cosine = fc.double({ min: -1, max: 1, noNaN: true })

/** The height of the point at `t` along the ray, from the full vectors in float64. */
function heightByVectors(
  R: number,
  eye: number,
  mu: number,
  t: number,
): number {
  const x = t * Math.sqrt(Math.max(0, 1 - mu * mu))
  const y = R + eye + t * mu
  return Math.hypot(x, y) - R
}

describe('a ray meeting a shell', () => {
  it('meets it where the ray stands at the shell’s height', () => {
    /*
     * The two roots are put back into the ray: the full vector's length in
     * float64, an independent formula. The tolerance is that formula's own
     * rounding at the body's size, 10⁻¹² of R + t; the stable quadratic
     * stays inside it on every ray, a grazing one included, where the root
     * moves most but the height it lands at does not.
     */
    fc.assert(
      fc.property(radius, height, height, cosine, (R, eye, boundary, mu) => {
        const crossings = shellCrossings(R, eye, eye - boundary, mu)
        // Closest approach of the line to the center against the sphere.
        const closest = (R + eye) * Math.sqrt(Math.max(0, 1 - mu * mu))
        if (crossings === null) {
          expect(closest).toBeGreaterThan((R + boundary) * (1 - 1e-12))
          return
        }
        expect(closest).toBeLessThanOrEqual((R + boundary) * (1 + 1e-12))
        const [near, far] = crossings
        expect(near).toBeLessThanOrEqual(far)
        for (const t of crossings)
          expect(
            Math.abs(heightByVectors(R, eye, mu, t) - boundary),
          ).toBeLessThanOrEqual(1e-12 * (R + Math.abs(t)) + 1e-9)
      }),
      { numRuns: 20_000 },
    )
  })

  it('gives a level ray from an eye on a boundary two zeros, never 0/0', () => {
    fc.assert(
      fc.property(radius, height, (R, eye) => {
        // q is −(0 + √0), a negative zero: a zero all the same, and finite.
        for (const mu of [0, -0])
          expect(shellCrossings(R, eye, 0, mu)!.every((t) => t === 0)).toBe(
            true,
          )
      }),
    )
  })

  it('agrees with Vieta: the roots sum to −2b and multiply to c', () => {
    fc.assert(
      fc.property(radius, height, height, cosine, (R, eye, boundary, mu) => {
        const crossings = shellCrossings(R, eye, eye - boundary, mu)
        fc.pre(crossings !== null)
        const [near, far] = crossings!
        const b = (R + eye) * mu
        const c = (eye - boundary) * (2 * R + eye + boundary)
        const scale = Math.max(Math.abs(near), Math.abs(far), 1)
        expect(Math.abs(near + far + 2 * b)).toBeLessThanOrEqual(1e-12 * scale)
        expect(Math.abs(near * far - c)).toBeLessThanOrEqual(
          1e-12 * scale * scale,
        )
      }),
      { numRuns: 5000 },
    )
  })
})

/* ------------------------------------------------------------------------- */
/* §5.3's altitude in float32                                                 */
/* ------------------------------------------------------------------------- */

const f = Math.fround

/**
 * `cloudGeometry.ts`'s `heightFrom` an operation at a time in float32, from
 * the uniforms' float32 values: the datum radius and the eye's height
 * uploaded as floats, h_e(2R + h_e) formed in float64 and uploaded rounded,
 * r_e = R + h_e summed on the GPU, and μ and t the kernel's own floats.
 */
function altitudeFloat32(
  R: number,
  eye: number,
  mu: number,
  t: number,
): number {
  const datum = f(R)
  const eyeTerm = f(eye * (2 * R + eye))
  const eyeRadius = f(datum + f(eye))
  const up = f(f(mu) * f(t))
  const lengthSquared = f(f(t) * f(t))
  const numerator = f(f(eyeTerm + f(f(eyeRadius * up) * 2)) + lengthSquared)
  const radiusAt = f(Math.sqrt(Math.max(f(f(datum * datum) + numerator), 0)))
  return f(numerator / f(radiusAt + datum))
}

/**
 * Whether the ray stays above a kilometer under both the datum and the eye
 * all the way to t: the points a march can sample, since `unionSpan` stops at
 * the datum ahead and the scene's depth at the ground.
 *
 * The bounds below hold there and not past it. A point the ray reaches only
 * through the body sits where r(t)² = R² + numerator is a difference of two
 * R²-sized floats, and the float32 quotient loses what the cancellation took:
 * over 2 × 10⁶ samples of the stated domain, 0.571 m in the band on a far
 * root out the other side of a 1,167 km body, and 3.9 × 10⁻⁶ of R + t deeper
 * than 0.3 R. Over the reached points the same sweep measures 0.207 m in the
 * band and 3.97 × 10⁻⁷ of R + t everywhere.
 */
function reached(R: number, eye: number, mu: number, t: number): boolean {
  const closest = -(R + eye) * mu
  const lowest = closest <= 0 ? 0 : Math.min(t, closest)
  return altitudeAlong(R, eye, mu, lowest) >= Math.min(eye, 0) - 1000
}

describe('altitude along a ray', () => {
  it('holds a quarter meter in float32 where a cloud can be, h within [−1, 20] km', () => {
    /*
     * §5.3's bound: each sample is a point a ray reaches at a height inside
     * the band, found by solving for it, and the float32 formula is held to
     * the float64 one at the kernel's own μ and t. A quarter meter decides
     * base ≤ h < top for every layer, the thinnest being fog's 150 m.
     */
    let worst = 0
    fc.assert(
      fc.property(
        radius,
        height,
        cosine,
        fc.double({ min: -1000, max: 20_000, noNaN: true }),
        fc.boolean(),
        (R, eye, mu, target, second) => {
          const crossings = shellCrossings(R, eye, eye - target, mu)
          fc.pre(crossings !== null)
          const t = crossings![second ? 1 : 0]
          fc.pre(t >= 0 && t <= 3e6 && reached(R, eye, mu, t))
          const exact = altitudeAlong(R, eye, f(mu), f(t))
          fc.pre(exact >= -1000 && exact <= 20_000)
          const error = Math.abs(altitudeFloat32(R, eye, mu, t) - exact)
          worst = Math.max(worst, error)
          expect(error).toBeLessThanOrEqual(0.25)
        },
      ),
      { numRuns: 50_000 },
    )
    expect(worst).toBeGreaterThan(0)
  })

  it('holds 10⁻⁶ of R + t in float32 everywhere else a ray reaches', () => {
    fc.assert(
      fc.property(
        radius,
        height,
        cosine,
        fc.double({ min: 0, max: 3e6, noNaN: true }),
        (R, eye, mu, t) => {
          fc.pre(reached(R, eye, mu, t))
          const exact = altitudeAlong(R, eye, f(mu), f(t))
          const error = Math.abs(altitudeFloat32(R, eye, mu, t) - exact)
          expect(error).toBeLessThanOrEqual(1e-6 * (R + t))
        },
      ),
      { numRuns: 50_000 },
    )
  })

  it('agrees with the full vectors in float64', () => {
    fc.assert(
      fc.property(
        radius,
        height,
        cosine,
        fc.double({ min: 0, max: 3e6, noNaN: true }),
        (R, eye, mu, t) => {
          expect(
            Math.abs(
              altitudeAlong(R, eye, mu, t) - heightByVectors(R, eye, mu, t),
            ),
          ).toBeLessThanOrEqual(1e-12 * (R + t) + 1e-9)
        },
      ),
      { numRuns: 5000 },
    )
  })

  it('equals altitude at a point on the ray', () => {
    /*
     * The point is t times a unit direction whose up-component is μ, so
     * up·o and o·o are μt and t² by another route; the two functions then
     * differ only by those dot products' rounding.
     */
    fc.assert(
      fc.property(
        radius,
        height,
        cosine,
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 3e6, noNaN: true }),
        (R, eye, mu, azimuth, t) => {
          const across = Math.sqrt(Math.max(0, 1 - mu * mu))
          const o = {
            x: t * across * Math.cos(azimuth),
            y: t * mu,
            z: t * across * Math.sin(azimuth),
          }
          const up = o.y
          const lengthSquared = o.x * o.x + o.y * o.y + o.z * o.z
          expect(
            Math.abs(
              altitudeAt(R, eye, up, lengthSquared) -
                altitudeAlong(R, eye, mu, t),
            ),
          ).toBeLessThanOrEqual(1e-12 * (R + t) + 1e-9)
        },
      ),
      { numRuns: 5000 },
    )
  })
})

/* ------------------------------------------------------------------------- */
/* The union                                                                  */
/* ------------------------------------------------------------------------- */

const EARTH = 6_371_000

describe('the shells a scenario lays out', () => {
  it('packs each layer’s base and top, absent layers at the union’s top', () => {
    expect(shellBoundaries(WEATHER_SCENARIOS['two-decks'])).toEqual([
      1000, 1500, 4000, 4800, 4800, 4800,
    ])
    expect(shellBoundaries(WEATHER_SCENARIOS['fair-cumulus'])).toEqual([
      1000, 2400, 2400, 2400, 2400, 2400,
    ])
  })

  it('forms the eye’s heights over every boundary in float64', () => {
    const shells = shellHeights(
      { x: 0, y: EARTH + 1250.5, z: 0 },
      EARTH,
      shellBoundaries(WEATHER_SCENARIOS['broken-horizon']),
    )
    expect(shells.eye).toBe(1250.5)
    expect(shells.eyeOver).toEqual([
      350.5, -949.5, -949.5, -949.5, -949.5, -949.5,
    ])
  })
})

describe('a ray’s span inside the union', () => {
  const boundaries = shellBoundaries(WEATHER_SCENARIOS['fair-cumulus'])
  const at = (eye: number) =>
    shellHeights({ x: 0, y: EARTH + eye, z: 0 }, EARTH, boundaries)

  it('starts at the eye from inside, and leaves through the top looking up', () => {
    const span = unionSpan(at(1500), 1, Infinity)!
    expect(span[0]).toBe(0)
    expect(span[1]).toBeCloseTo(900, 6)
  })

  it('starts at the eye from inside, and leaves through the base looking down', () => {
    const span = unionSpan(at(1500), -1, Infinity)!
    expect(span[0]).toBe(0)
    expect(span[1]).toBeCloseTo(500, 6)
  })

  it('starts where the base is crossed from below', () => {
    const span = unionSpan(at(2), 1, Infinity)!
    expect(span[0]).toBeCloseTo(998, 6)
    expect(span[1]).toBeCloseTo(2398, 6)
  })

  it('is empty looking down from under the base: the ground comes first', () => {
    expect(unionSpan(at(2), -1, Infinity)).toBeNull()
  })

  it('starts where the top is crossed from above, and ends at the base', () => {
    const span = unionSpan(at(400_000), -1, Infinity)!
    expect(span[0]).toBeCloseTo(400_000 - 2400, 6)
    expect(span[1]).toBeCloseTo(400_000 - 1000, 6)
  })

  it('is empty looking away from above, and clipped by the scene’s stop', () => {
    expect(unionSpan(at(400_000), 1, Infinity)).toBeNull()
    expect(unionSpan(at(2), 1, 1500)).toEqual([expect.closeTo(998, 6), 1500])
    expect(unionSpan(at(2), 1, 500)).toBeNull()
  })

  it('holds the union between its ends on every ray, and only the union', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -500, max: 400_000, noNaN: true }),
        cosine,
        (eye, mu) => {
          const shells = at(eye)
          const span = unionSpan(shells, mu, Infinity)
          if (span === null) return
          const [start, end] = span
          expect(end).toBeGreaterThan(start)
          for (const share of [0.01, 0.25, 0.5, 0.75, 0.99]) {
            const h = altitudeAlong(
              EARTH,
              eye,
              mu,
              start + share * (end - start),
            )
            expect(h).toBeGreaterThanOrEqual(1000 - 1e-6)
            expect(h).toBeLessThanOrEqual(2400 + 1e-6)
          }
          // An end is a boundary, or the eye itself for a start inside.
          const startHeight = altitudeAlong(EARTH, eye, mu, start)
          if (start > 0)
            expect(
              Math.min(
                Math.abs(startHeight - 1000),
                Math.abs(startHeight - 2400),
              ),
            ).toBeLessThan(1e-6)
          const endHeight = altitudeAlong(EARTH, eye, mu, end)
          expect(
            Math.min(Math.abs(endHeight - 1000), Math.abs(endHeight - 2400)),
          ).toBeLessThan(1e-6)
        },
      ),
      { numRuns: 5000 },
    )
  })
})
