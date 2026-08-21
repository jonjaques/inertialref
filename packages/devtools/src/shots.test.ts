import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Quaternion as Q, Vec, vec3 } from '@inertialref/spatial'
import { findShot, lookAlong, placeShot, SHOTS } from './shots.ts'

/*
 * The bookmarks are pure geometry, which makes their promises checkable here:
 * the phase angle a shot asks for is the phase angle it gets, the camera looks
 * at what the composition says it looks at, and the horizon is level. The one
 * thing Node cannot check is whether the result is beautiful, which is what
 * the browser buttons are for.
 */

const RADIUS = 6_378_137 // Earth, so the numbers in failures read as places

/** An arbitrary unit vector that is nowhere near the degenerate pole. */
const arbSunDirection = fc
  .record({
    x: fc.double({ min: -1, max: 1, noNaN: true }),
    y: fc.double({ min: -0.7, max: 0.7, noNaN: true }),
    z: fc.double({ min: -1, max: 1, noNaN: true }),
  })
  .filter((v) => {
    const horizontal = Math.hypot(v.x, v.z)
    return horizontal > 0.3 && Vec.length(v) > 1e-3
  })
  .map((v) => Vec.normalize(vec3(v.x, v.y, v.z)))

describe('placeShot', () => {
  it('reproduces the phase angle each composition asks for', () => {
    fc.assert(
      fc.property(arbSunDirection, (sun) => {
        for (const shot of SHOTS) {
          const { position } = placeShot(shot, RADIUS, sun)
          const phase =
            (Math.acos(Vec.dot(Vec.normalize(position), sun)) * 180) / Math.PI
          // Exact, whatever the sun's declination: the elevation tilts the
          // swing plane about the sun line and must not spend phase to do it.
          // The first implementation rotated about the pole instead, and this
          // is the assertion that caught it.
          expect(Math.abs(phase - shot.phaseDeg)).toBeLessThan(1e-6)
        }
      }),
    )
  })

  it('parks at the requested distance, floored above the ground', () => {
    const sun = Vec.normalize(vec3(1, 0.1, 0.2))
    for (const shot of SHOTS) {
      const { position } = placeShot(shot, RADIUS, sun)
      expect(Vec.length(position)).toBeCloseTo(shot.distanceRadii * RADIUS, 3)
    }
    // The SOI clamp: a small moon cannot host a 5-radius shot, and the floor
    // beats the ceiling when the two collide, as in `viewingAltitudeKm`.
    const clamped = placeShot(findShot('full-face'), RADIUS, sun, 2 * RADIUS)
    expect(Vec.length(clamped.position)).toBeCloseTo(2 * RADIUS, 3)
    const floored = placeShot(findShot('full-face'), RADIUS, sun, 0.5 * RADIUS)
    expect(Vec.length(floored.position)).toBeCloseTo(1.03 * RADIUS, 3)
  })

  it('aims the camera at what each composition names', () => {
    fc.assert(
      fc.property(arbSunDirection, (sun) => {
        for (const shot of SHOTS) {
          const { position, orientation } = placeShot(shot, RADIUS, sun)
          const { forward } = Q.basis(orientation)

          if (shot.aim === 'centre') {
            // Looking at the centre means forward is exactly anti-radial.
            expect(
              Vec.dot(forward, Vec.normalize(Vec.negate(position))),
            ).toBeGreaterThan(0.999_9)
          } else {
            // A limb or specular aim looks at a point *on the sphere*, plus
            // any composed lift above it: march forward from the camera and
            // the ray must graze within the lifted radius. The closest
            // approach of the ray to the centre is |p|·sin(angle between −p
            // and forward).
            const toCentre = Vec.negate(position)
            const along = Vec.dot(toCentre, forward)
            const closest = Math.sqrt(
              Math.max(0, Vec.lengthSquared(toCentre) - along * along),
            )
            expect(along).toBeGreaterThan(0) // ahead, not behind
            expect(closest).toBeLessThanOrEqual(
              RADIUS * (1 + (shot.aimLift ?? 0)) * 1.000_001,
            )
          }
        }
      }),
    )
  })

  it('keeps the horizon level: no roll about the view axis', () => {
    fc.assert(
      fc.property(arbSunDirection, (sun) => {
        for (const shot of SHOTS) {
          const { position, orientation } = placeShot(shot, RADIUS, sun)
          const { right } = Q.basis(orientation)
          // Level means the frame's horizontal is perpendicular to the shot's
          // vertical: the pole for a centre shot, the local vertical for a
          // limb shot. A tilted horizon is the first thing an eye notices.
          const vertical =
            shot.aim === 'centre' ? vec3(0, 1, 0) : Vec.normalize(position)
          expect(Math.abs(Vec.dot(right, vertical))).toBeLessThan(1e-6)
        }
      }),
    )
  })

  it('leaves the ship on a tangential track, so the frame holds', () => {
    fc.assert(
      fc.property(arbSunDirection, (sun) => {
        for (const shot of SHOTS) {
          const { position, along } = placeShot(shot, RADIUS, sun)
          expect(Vec.length(along)).toBeCloseTo(1, 6)
          expect(
            Math.abs(Vec.dot(along, Vec.normalize(position))),
          ).toBeLessThan(1e-6)
        }
      }),
    )
  })
})

describe('lookAlong', () => {
  it('survives a forward parallel to the up hint', () => {
    const q = lookAlong(vec3(0, 1, 0), vec3(0, 1, 0))
    const { forward } = Q.basis(q)
    expect(Number.isFinite(forward.x)).toBe(true)
    expect(Vec.dot(forward, vec3(0, 1, 0))).toBeGreaterThan(0.999_9)
  })
})
