import { invariant, type Meters } from '@inertialref/shared'
import { type Vec3, vec3 } from './vec3.ts'

/*
 * ---------------------------------------------------------------------------
 * The canonical universe coordinate.
 * ---------------------------------------------------------------------------
 *
 * A position is an integer sector index per axis plus a double-precision offset
 * inside that sector, in meters. Nothing else in the codebase is allowed to
 * claim to be an absolute position (ADR-0001).
 *
 * Why not a plain double vector: the galaxy is ~1e21 m across and a double has
 * ~2.2e-16 relative precision, so absolute doubles quantise to ~100 km out at
 * the rim. Inch-scale interaction needs ~1e-2 m, i.e. ~24 orders of magnitude
 * of dynamic range, which no single float format gives you.
 *
 * Why not int64 (BigInt) millimetres: 2^63 mm is only ~0.97 light-years, so you
 * need 128-bit integers, and BigInt arithmetic in the inner loop of a 64 Hz
 * simulation is roughly an order of magnitude slower than double math, plus it
 * serialises badly.
 *
 * Why a *power-of-two* sector size: normalisation (carrying an out-of-range
 * offset into the sector index) is then exact in IEEE-754. `o / SECTOR_SIZE` is
 * an exponent shift, `Math.floor` of it is exact, `k * SECTOR_SIZE` is exact,
 * and `o - k * SECTOR_SIZE` is exact by Sterbenz's lemma because the two
 * operands are within a factor of two. So moving an entity across a sector
 * boundary introduces *zero* additional error — which is what makes the whole
 * scheme safe to use as canonical state rather than as a rendering trick.
 *
 * Resulting numbers:
 *   sector size   2^40 m  ≈ 1.0995e12 m ≈ 7.35 AU
 *   sector index  int32   ⇒ half-extent 2^71 m ≈ 2.36e21 m ≈ 249,000 ly
 *   worst-case resolution 2^40 × 2^-52 m ≈ 2.4e-4 m ≈ 0.24 mm, everywhere
 *
 * The Milky Way is ~100,000 ly across, so the addressable volume has room for
 * the galaxy plus a wide halo, and a quarter-millimetre is below anything the
 * player can interact with.
 */

/** log2 of the sector edge length in meters. */
export const SECTOR_EXPONENT = 40
/** Sector edge length in meters (2^40 ≈ 7.35 AU). */
export const SECTOR_SIZE: Meters = 2 ** SECTOR_EXPONENT
/** Exclusive bound on |sector index| — sector indices are int32. */
export const SECTOR_INDEX_LIMIT = 2 ** 31
/** Half the addressable universe, in meters. */
export const UNIVERSE_HALF_EXTENT: Meters = SECTOR_SIZE * SECTOR_INDEX_LIMIT
/** Worst-case position resolution anywhere in the universe, in meters. */
export const POSITION_RESOLUTION: Meters = SECTOR_SIZE * 2 ** -52

/**
 * Absolute position in the universe.
 *
 * Invariant, maintained by every constructor here: each offset component lies
 * in [0, SECTOR_SIZE) and each sector component is an integer in
 * (-SECTOR_INDEX_LIMIT, SECTOR_INDEX_LIMIT). Callers must not build these by
 * object literal; use `universeVector` / `fromMeters` / `translate`.
 */
export interface UniverseVector {
  readonly sx: number
  readonly sy: number
  readonly sz: number
  readonly ox: Meters
  readonly oy: Meters
  readonly oz: Meters
}

export const UNIVERSE_ORIGIN: UniverseVector = Object.freeze({
  sx: 0,
  sy: 0,
  sz: 0,
  ox: 0,
  oy: 0,
  oz: 0,
})

/** Carry an arbitrary offset into (sectorIndex, offset). Exact — see the header. */
function carry(
  sector: number,
  offset: number,
): { sector: number; offset: number } {
  const k = Math.floor(offset / SECTOR_SIZE)
  return { sector: sector + k, offset: offset - k * SECTOR_SIZE }
}

function checkSector(index: number, axis: string): void {
  invariant(
    Number.isInteger(index) && Math.abs(index) < SECTOR_INDEX_LIMIT,
    `Universe ${axis} sector index out of range: ${index}`,
  )
}

export function universeVector(
  sx: number,
  sy: number,
  sz: number,
  ox: Meters,
  oy: Meters,
  oz: Meters,
): UniverseVector {
  invariant(
    Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz),
    `Universe offset must be finite, got (${ox}, ${oy}, ${oz})`,
  )
  const cx = carry(sx, ox)
  const cy = carry(sy, oy)
  const cz = carry(sz, oz)
  checkSector(cx.sector, 'x')
  checkSector(cy.sector, 'y')
  checkSector(cz.sector, 'z')
  return {
    sx: cx.sector,
    sy: cy.sector,
    sz: cz.sector,
    ox: cx.offset,
    oy: cy.offset,
    oz: cz.offset,
  }
}

/**
 * Build from absolute meters.
 *
 * The conversion itself is exact; the *input* is a double, so a galactic-scale
 * literal has already lost precision before it arrives (~2 km at 1e19 m). That
 * is fine for the only thing that uses it — placing catalogue stars, whose
 * published positions are uncertain by far more than that — and wrong for
 * anything else, which should be translating from an existing position instead.
 */
export function fromMeters(x: Meters, y: Meters, z: Meters): UniverseVector {
  return universeVector(0, 0, 0, x, y, z)
}

export const fromVec3 = (v: Vec3): UniverseVector => fromMeters(v.x, v.y, v.z)

/** Move by a displacement expressed in universe axes. */
export function translate(uv: UniverseVector, delta: Vec3): UniverseVector {
  return universeVector(
    uv.sx,
    uv.sy,
    uv.sz,
    uv.ox + delta.x,
    uv.oy + delta.y,
    uv.oz + delta.z,
  )
}

/**
 * `a - b` as a displacement in meters.
 *
 * Valid at any separation: the result is a double, so a galaxy-crossing
 * difference is quantised to ~1e5 m, while the near-field differences that
 * actually feed physics and rendering keep full double precision.
 */
export function difference(a: UniverseVector, b: UniverseVector): Vec3 {
  return vec3(
    (a.sx - b.sx) * SECTOR_SIZE + (a.ox - b.ox),
    (a.sy - b.sy) * SECTOR_SIZE + (a.oy - b.oy),
    (a.sz - b.sz) * SECTOR_SIZE + (a.oz - b.oz),
  )
}

export function distance(a: UniverseVector, b: UniverseVector): Meters {
  const d = difference(a, b)
  return Math.hypot(d.x, d.y, d.z)
}

/** Squared distance without the sqrt. Overflows to Infinity past ~1e154 m; harmless here. */
export function distanceSquared(a: UniverseVector, b: UniverseVector): number {
  const d = difference(a, b)
  return d.x * d.x + d.y * d.y + d.z * d.z
}

/**
 * Absolute position as plain meters. Lossy by construction (that is the whole
 * point of UniverseVector) — for display, coarse culling and tests only.
 */
export function approxMeters(uv: UniverseVector): Vec3 {
  return vec3(
    uv.sx * SECTOR_SIZE + uv.ox,
    uv.sy * SECTOR_SIZE + uv.oy,
    uv.sz * SECTOR_SIZE + uv.oz,
  )
}

export const equals = (a: UniverseVector, b: UniverseVector): boolean =>
  a.sx === b.sx &&
  a.sy === b.sy &&
  a.sz === b.sz &&
  a.ox === b.ox &&
  a.oy === b.oy &&
  a.oz === b.oz

export const approxEquals = (
  a: UniverseVector,
  b: UniverseVector,
  epsilon: Meters = 1e-6,
): boolean => distance(a, b) <= epsilon

export const isValid = (uv: UniverseVector): boolean =>
  Number.isInteger(uv.sx) &&
  Number.isInteger(uv.sy) &&
  Number.isInteger(uv.sz) &&
  Math.abs(uv.sx) < SECTOR_INDEX_LIMIT &&
  Math.abs(uv.sy) < SECTOR_INDEX_LIMIT &&
  Math.abs(uv.sz) < SECTOR_INDEX_LIMIT &&
  uv.ox >= 0 &&
  uv.ox < SECTOR_SIZE &&
  uv.oy >= 0 &&
  uv.oy < SECTOR_SIZE &&
  uv.oz >= 0 &&
  uv.oz < SECTOR_SIZE

/** Stable key for the containing sector — used by spatial indexes and streaming. */
export const sectorKey = (uv: UniverseVector): string =>
  `${uv.sx},${uv.sy},${uv.sz}`

export const format = (uv: UniverseVector): string =>
  `[${uv.sx},${uv.sy},${uv.sz}]+(${uv.ox.toFixed(3)}, ${uv.oy.toFixed(3)}, ${uv.oz.toFixed(3)})`
