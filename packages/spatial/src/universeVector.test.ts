import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, LIGHT_YEAR, PARSEC } from '@inertialref/shared'
import * as UV from './universeVector.ts'
import { vec3 } from './vec3.ts'

/** Positions anywhere in the addressable universe. */
const anyPosition = fc
  .record({
    sx: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    sy: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    sz: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    ox: fc.double({ min: 0, max: UV.SECTOR_SIZE, noNaN: true, maxExcluded: true }),
    oy: fc.double({ min: 0, max: UV.SECTOR_SIZE, noNaN: true, maxExcluded: true }),
    oz: fc.double({ min: 0, max: UV.SECTOR_SIZE, noNaN: true, maxExcluded: true }),
  })
  .map((r) => UV.universeVector(r.sx, r.sy, r.sz, r.ox, r.oy, r.oz))

const anyDisplacement = fc
  .record({
    x: fc.double({ min: -1e12, max: 1e12, noNaN: true }),
    y: fc.double({ min: -1e12, max: 1e12, noNaN: true }),
    z: fc.double({ min: -1e12, max: 1e12, noNaN: true }),
  })
  .map((r) => vec3(r.x, r.y, r.z))

describe('UniverseVector', () => {
  it('covers the galaxy with room to spare', () => {
    // Milky Way is ~100,000 ly across; we need to hold it plus a halo.
    expect(UV.UNIVERSE_HALF_EXTENT / LIGHT_YEAR).toBeGreaterThan(120_000)
    // ...and still resolve below a millimetre at the far rim.
    expect(UV.POSITION_RESOLUTION).toBeLessThan(1e-3)
  })

  it('normalises offsets into the canonical range', () => {
    const uv = UV.universeVector(0, 0, 0, UV.SECTOR_SIZE * 2.5, -UV.SECTOR_SIZE * 0.25, 0)
    expect(uv.sx).toBe(2)
    expect(uv.ox).toBe(UV.SECTOR_SIZE * 0.5)
    expect(uv.sy).toBe(-1)
    expect(uv.oy).toBe(UV.SECTOR_SIZE * 0.75)
    expect(UV.isValid(uv)).toBe(true)
  })

  it('rejects positions outside the addressable universe', () => {
    expect(() => UV.fromMeters(UV.UNIVERSE_HALF_EXTENT * 2, 0, 0)).toThrow(/sector index out of range/)
    expect(() => UV.fromMeters(Number.NaN, 0, 0)).toThrow(/must be finite/)
  })

  it('preserves inch-scale displacement at galactic distance', () => {
    // 8 kpc out — roughly the Sun's distance from the galactic centre — move an inch.
    const far = UV.fromMeters(8_000 * PARSEC, 0, 0)
    const moved = UV.translate(far, vec3(0.0254, 0, 0))
    // Resolvable, to within the quarter-millimetre the representation promises
    // — not to within a double's idea of 8 kpc, which is 30 km wide.
    expect(Math.abs(UV.distance(far, moved) - 0.0254)).toBeLessThan(UV.POSITION_RESOLUTION * 2)
    // The naive representation this design exists to avoid cannot do that at all:
    // 8 kpc in a double has an ULP of ~30 km.
    expect(8_000 * PARSEC + 0.0254).toBe(8_000 * PARSEC)
  })

  it('keeps precision across a sector boundary', () => {
    const before = UV.universeVector(0, 0, 0, UV.SECTOR_SIZE - 0.5, 0, 0)
    const after = UV.translate(before, vec3(1, 0, 0))
    expect(after.sx).toBe(1)
    // The two points straddle the boundary; the separation must survive the carry.
    expect(Math.abs(UV.distance(before, after) - 1)).toBeLessThan(UV.POSITION_RESOLUTION * 2)
  })

  it('carries offsets exactly (property)', () => {
    fc.assert(
      fc.property(anyPosition, (uv) => {
        expect(UV.isValid(uv)).toBe(true)
        // Re-normalising an already-normalised vector must be the identity.
        const again = UV.universeVector(uv.sx, uv.sy, uv.sz, uv.ox, uv.oy, uv.oz)
        expect(UV.equals(uv, again)).toBe(true)
      }),
    )
  })

  it('round-trips translate/difference (property)', () => {
    fc.assert(
      fc.property(anyPosition, anyDisplacement, (uv, d) => {
        const moved = UV.translate(uv, d)
        const back = UV.difference(moved, uv)
        // Error is bounded by the offset ULP, not by the absolute magnitude.
        expect(Math.abs(back.x - d.x)).toBeLessThanOrEqual(UV.POSITION_RESOLUTION * 4)
        expect(Math.abs(back.y - d.y)).toBeLessThanOrEqual(UV.POSITION_RESOLUTION * 4)
        expect(Math.abs(back.z - d.z)).toBeLessThanOrEqual(UV.POSITION_RESOLUTION * 4)
      }),
    )
  })

  it('difference is antisymmetric and translation is associative (property)', () => {
    fc.assert(
      fc.property(anyPosition, anyDisplacement, anyDisplacement, (uv, a, b) => {
        const ab = UV.translate(UV.translate(uv, a), b)
        const ba = UV.translate(UV.translate(uv, b), a)
        expect(UV.distance(ab, ba)).toBeLessThanOrEqual(UV.POSITION_RESOLUTION * 8)

        const forward = UV.difference(ab, uv)
        const backward = UV.difference(uv, ab)
        expect(forward.x).toBeCloseTo(-backward.x, 6)
      }),
    )
  })

  it('measures interstellar distances correctly', () => {
    const sol = UV.UNIVERSE_ORIGIN
    const proxima = UV.fromMeters(4.2465 * LIGHT_YEAR, 0, 0)
    expect(UV.distance(sol, proxima) / LIGHT_YEAR).toBeCloseTo(4.2465, 6)
    const earth = UV.translate(sol, vec3(AU, 0, 0))
    expect(UV.distance(sol, earth)).toBeCloseTo(AU, 3)
  })
})
