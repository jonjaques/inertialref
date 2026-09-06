import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, vec3 } from '@inertialref/spatial'
import {
  arcAnomaly,
  arcContinuation,
  arcPoint,
  arcRadius,
  arcSamples,
  dropBlend,
  dropLevel,
  dropRadius,
  entryArc,
  isRadial,
} from './entryArc.ts'
import { MIN_STANCE_HEIGHT } from './surfaceStance.ts'

/*
 * The conic, as properties.
 *
 * The claims worth holding: the arc starts at the eye and ends at the
 * touchdown, its radius only falls on the way, the radius and the angle are
 * inverses of each other, and the schedule that walks it lands on the last
 * frame. Each is a property over random geometry, because the failure that
 * matters is an eye far out at a shallow angle, which no hand-picked case
 * thinks to write.
 */

/** A unit vector, from three doubles that are not all zero. */
const unit = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter(([x, y, z]) => Math.hypot(x, y, z) > 1e-3)
  .map(([x, y, z]) => Vec.normalize(vec3(x, y, z)))

/** A touchdown radius, an eye above it, and the angle between them. */
const geometry = fc.record({
  touchdown: fc.double({ min: 1e3, max: 1e8, noNaN: true }),
  ratio: fc.double({ min: 1.001, max: 1e6, noNaN: true }),
  sweep: fc.double({ min: 0, max: Math.PI - 1e-3, noNaN: true }),
  toEye: unit,
  spin: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
})

/** The eye and the ground for a geometry, in some axes. */
function place({
  touchdown,
  ratio,
  sweep,
  toEye,
  spin,
}: {
  touchdown: number
  ratio: number
  sweep: number
  toEye: { x: number; y: number; z: number }
  spin: number
}) {
  // A perpendicular to `toEye`, turned by `spin` about it, so the plane of
  // the arc is not always the same one.
  const seed = Math.abs(toEye.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)
  const u = Vec.normalize(Vec.cross(seed, toEye))
  const v = Vec.cross(toEye, u)
  const across = Vec.add(
    Vec.scale(u, Math.cos(spin)),
    Vec.scale(v, Math.sin(spin)),
  )
  const eye = Vec.scale(toEye, touchdown * ratio)
  const ground = Vec.scale(
    Vec.add(
      Vec.scale(toEye, Math.cos(sweep)),
      Vec.scale(across, Math.sin(sweep)),
    ),
    touchdown,
  )
  return { eye, ground }
}

const arcOf = (g: Parameters<typeof place>[0]) => {
  const { eye, ground } = place(g)
  const arc = entryArc(eye, ground)
  if (arc === null) throw new Error('expected an arc above the ground')
  return { arc, eye, ground }
}

/** Relative closeness, because the radii span five decades. */
const close = (a: number, b: number, tolerance = 1e-6): boolean =>
  Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b))

describe('the entry arc', () => {
  it('starts at the eye and ends at the touchdown', () => {
    fc.assert(
      fc.property(geometry, (g) => {
        const { arc, eye, ground } = arcOf(g)
        expect(close(arcRadius(arc, 0), Vec.length(eye))).toBe(true)
        const end = arcPoint(arc, arc.sweep, arc.touchdown)
        expect(Vec.distance(end, ground) / arc.touchdown).toBeLessThan(1e-6)
        expect(arc.eccentricity).toBeGreaterThanOrEqual(0)
        expect(arc.eccentricity).toBeLessThanOrEqual(1)
      }),
    )
  })

  it('only comes down on the way from the eye to the ground', () => {
    fc.assert(
      fc.property(geometry, (g) => {
        const { arc } = arcOf(g)
        const radii = arcSamples(arc, 64).map((point) => Vec.length(point))
        for (let i = 1; i < radii.length; i += 1) {
          expect(radii[i]).toBeLessThanOrEqual(
            (radii[i - 1] as number) * (1 + 1e-6),
          )
          expect(radii[i]).toBeGreaterThanOrEqual(arc.touchdown * (1 - 1e-6))
        }
      }),
    )
  })

  it('inverts radius and angle over the descending half', () => {
    fc.assert(
      fc.property(
        geometry.filter((g) => g.sweep > 1e-3),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (g, t) => {
          const { arc } = arcOf(g)
          const psi = arc.sweep * t
          const radius = arcRadius(arc, psi)
          expect(Math.abs(arcAnomaly(arc, radius) - psi)).toBeLessThan(1e-5)
        },
      ),
    )
  })

  it('collapses to the radial line under the eye, and draws it', () => {
    const arc = entryArc(vec3(0, 0, 5e6), vec3(0, 0, 1e6))
    if (arc === null) throw new Error('expected an arc')
    expect(isRadial(arc)).toBe(true)
    const samples = arcSamples(arc, 5)
    expect(samples.map((p) => p.z)).toEqual([5e6, 4e6, 3e6, 2e6, 1e6])
    for (const p of samples) expect(Math.hypot(p.x, p.y)).toBe(0)
    // Through the centre and out the other side.
    const through = arcContinuation(arc, 3)
    expect(through.map((p) => p.z)).toEqual([1e6, 0, -1e6])
  })

  it('continues through the body and comes back up to the far side', () => {
    fc.assert(
      fc.property(
        geometry.filter((g) => g.sweep > 1e-2),
        (g) => {
          const { arc } = arcOf(g)
          const through = arcContinuation(arc, 33)
          const first = through[0] as { x: number; y: number; z: number }
          const last = through[through.length - 1] as typeof first
          expect(close(Vec.length(first), arc.touchdown, 1e-6)).toBe(true)
          expect(close(Vec.length(last), arc.touchdown, 1e-6)).toBe(true)
          // Periapsis is the middle sample and it is under the ground.
          const mid = through[16] as typeof first
          expect(Vec.length(mid)).toBeLessThan(arc.touchdown)
        },
      ),
    )
  })

  it('refuses an eye that is not above the ground', () => {
    expect(entryArc(vec3(0, 0, 1e6), vec3(0, 0, 1e6))).toBeNull()
    expect(entryArc(vec3(0, 0, 5e5), vec3(0, 0, 1e6))).toBeNull()
    expect(entryArc(vec3(0, 0, 0), vec3(0, 0, 1e6))).toBeNull()
    expect(entryArc(vec3(0, 0, 1e6), vec3(0, 0, 0))).toBeNull()
  })
})

describe('the drop schedule', () => {
  it('leaves from the eye and lands exactly on the touchdown radius', () => {
    fc.assert(
      fc.property(geometry, (g) => {
        const { arc } = arcOf(g)
        expect(close(dropRadius(arc, 0), arc.apoapsis)).toBe(true)
        expect(close(dropRadius(arc, 1), arc.touchdown, 1e-9)).toBe(true)
      }),
    )
  })

  it('never climbs, and never lands early', () => {
    fc.assert(
      fc.property(geometry, (g) => {
        const { arc } = arcOf(g)
        let previous = arc.apoapsis
        for (let i = 1; i <= 100; i += 1) {
          const radius = dropRadius(arc, i / 100)
          expect(radius).toBeLessThanOrEqual(previous * (1 + 1e-12))
          expect(radius).toBeGreaterThanOrEqual(arc.touchdown * (1 - 1e-12))
          previous = radius
        }
      }),
    )
  })

  it('spends its time in the decades a linear drop would skip', () => {
    // From 30,000 km to eye height, the halfway frame is not at 15,000 km: it
    // is at the geometric middle of the height band, so the ground is still
    // a disk at half time and a landscape only near the end.
    const arc = entryArc(vec3(0, 0, 6.378e6 + 3e7), vec3(0, 0, 6.378e6))
    if (arc === null) throw new Error('expected an arc')
    const halfway = dropRadius(arc, 0.5) - arc.touchdown
    expect(halfway).toBeLessThan(1e6)
    expect(halfway).toBeGreaterThan(1e2)
  })

  it('blends the roll in over the first fifth and levels over the last third', () => {
    expect(dropBlend(0)).toBe(0)
    expect(dropBlend(0.2)).toBe(1)
    expect(dropBlend(0.7)).toBe(1)
    expect(dropLevel(0.5)).toBe(0)
    expect(dropLevel(0.65)).toBe(0)
    expect(dropLevel(1)).toBe(1)
    expect(dropLevel(0.9)).toBeGreaterThan(0.5)
    // Eye height is where the log floor sits, so the constant it is built on
    // is the arm's own rather than a second copy of it.
    expect(MIN_STANCE_HEIGHT).toBe(2)
  })
})
