import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { atmosphereShellRatio, ringScales, sunkSphereRadius } from './datum.ts'

/*
 * The datum sphere, as properties rather than examples.
 *
 * This replaces a test that built a whole `GameEngine` — workers, save store,
 * clock — to compare two six-line formulas that had been written twice. They
 * are written once now, so the interesting claims are no longer "do these two
 * agree" but "what does this one guarantee", and those are claims about every
 * radius and relief rather than about Sol's eight planets. In particular it
 * reaches the case the engine test could not: relief above a tenth of the
 * radius, where the clamp bites.
 */

/** Real bodies: hundreds of kilometers to a gas giant, in meters. */
const radius = fc.double({
  min: 1e5,
  max: 1e8,
  noNaN: true,
  noDefaultInfinity: true,
})

/** Peak-to-datum relief. Mars' Olympus Mons is 2e4 against a 3.4e6 radius. */
const relief = fc.double({
  min: 0,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
})

const hazeHeight = fc.double({
  min: 0,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
})

describe('the datum sphere', () => {
  it('never draws the sphere above the datum, and never sinks it past a tenth', () => {
    /*
     * Both bounds are load-bearing. Above the datum the sphere hides the peaks
     * instead of the valleys, which is the failure it exists to prevent. Below
     * a tenth it is on its way to a negative radius, and every ratio measured
     * against it — the atmosphere shell, the ring spans — inverts with it.
     */
    fc.assert(
      fc.property(radius, relief, (r, h) => {
        const sunk = sunkSphereRadius(r, h)
        expect(sunk).toBeLessThanOrEqual(r)
        expect(sunk).toBeGreaterThanOrEqual(r * 0.9)
        expect(sunk).toBeGreaterThan(0)
      }),
    )
  })

  it('sinks by the full relief until the clamp bites, and by the clamp after', () => {
    // The case the old engine test could not reach: no body in Sol has relief
    // anywhere near a tenth of its radius, so the clamp was typed twice and
    // exercised never.
    fc.assert(
      fc.property(radius, relief, (r, h) => {
        const sunk = sunkSphereRadius(r, h)
        if (h <= r * 0.1) expect(sunk).toBeCloseTo(r - h, 6)
        else expect(sunk).toBeCloseTo(r * 0.9, 6)
      }),
    )
  })

  it('sinks monotonically: more relief is never a larger sphere', () => {
    fc.assert(
      fc.property(radius, relief, relief, (r, a, b) => {
        const [less, more] = a <= b ? [a, b] : [b, a]
        expect(sunkSphereRadius(r, more)).toBeLessThanOrEqual(
          sunkSphereRadius(r, less),
        )
      }),
    )
  })

  it('refuses to raise the sphere for a negative relief', () => {
    // Relief arrives as `surface.maxElevation`, which is never negative — but
    // this is the one input that would silently draw the sphere *above* the
    // datum, so the function is total rather than trusting its callers.
    fc.assert(
      fc.property(radius, (r) => {
        expect(sunkSphereRadius(r, -1e6)).toBe(r)
      }),
    )
  })

  it('always encloses the drawn sphere with the atmosphere shell', () => {
    // The shell is measured against the sunk sphere, so it is greater than 1
    // even for a body with no haze height at all — the sink alone accounts for
    // it. A ratio at or below 1 draws the shell inside the ground.
    fc.assert(
      fc.property(radius, relief, hazeHeight, (r, h, haze) => {
        expect(atmosphereShellRatio(r, h, haze)).toBeGreaterThanOrEqual(1)
      }),
    )
  })

  it('measures the shell and the rings against the same sphere', () => {
    /*
     * THE REGRESSION, in the form that survives the deduplication. The two
     * ratios were computed from separately-written sink formulas; this asserts
     * they are the same measurement, so a change to the sink moves both or
     * neither. A ring inner edge at `radius + hazeHeight` must land exactly
     * where the atmosphere's top does.
     */
    fc.assert(
      fc.property(radius, relief, hazeHeight, (r, h, haze) => {
        const span = { innerRadius: r + haze, outerRadius: r + haze }
        expect(ringScales(r, h, span).inner).toBe(
          atmosphereShellRatio(r, h, haze),
        )
      }),
    )
  })

  it('keeps ring edges in order and outside the drawn sphere', () => {
    fc.assert(
      fc.property(
        radius,
        relief,
        fc.double({ min: 1.2, max: 1.6, noNaN: true }),
        fc.double({ min: 1.7, max: 2.4, noNaN: true }),
        (r, h, inner, outer) => {
          const scales = ringScales(r, h, {
            innerRadius: r * inner,
            outerRadius: r * outer,
          })
          expect(scales.inner).toBeLessThan(scales.outer)
          // Saturn's rings start at 1.2 radii; sinking the sphere can only
          // push that further out, never inside the body.
          expect(scales.inner).toBeGreaterThan(1)
        },
      ),
    )
  })
})
