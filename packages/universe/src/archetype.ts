import type { Kilograms, Meters } from '@inertialref/shared'
import type { Body, BodyKind } from './system.ts'

/*
 * What kind of surface a body has, from what is already known about it.
 *
 * Four archetypes, and every input is a fact the body already carries — mass,
 * radius, figure, atmosphere, orbit — so nothing here is stored, seeded or
 * versioned. It is a classification, not a generator: `elevationAt` does not
 * read it and the terrain does not move because of it.
 *
 * It exists now, ahead of the surface grammar that will drive band amplitudes
 * from the same facts, because the terrain zoo has to be able to *assert* that
 * it still contains one of each — a fixture that quietly loses its icy worlds
 * to a catalog revision is a fixture that tests three archetypes and says four.
 * The grammar is the phase after this one; when it lands, it derives from these
 * same numbers and this becomes its coarsest output rather than a second
 * opinion.
 */

export type SurfaceArchetype =
  /** Dense, no air: saturation cratering and relief that never softens. */
  | 'rocky-airless'
  /** Dense with an envelope: erased craters, worn ranges, dunes, oceans. */
  | 'rocky-atmosphered'
  /** Light and cold: saturated craters relaxing viscously toward palimpsests. */
  | 'icy-dead'
  /** Light and worked: young surfaces, chaos terrain, ridges, troughs. */
  | 'icy-active'

/**
 * The density that separates rock from ice, kg/m³.
 *
 * Not a round number chosen for tidiness. Water ice is 917 and silicate rock is
 * 2,600–3,300, so a body made of both lands between them in proportion to what
 * it is made of: Luna is 3,344 and Mercury 5,427; Callisto is 1,834, Ganymede
 * 1,936, Europa 3,013 — which is why Europa classifies as rock by this test and
 * behaves like it, being a silicate body with a hundred kilometers of water on
 * top. The line at 2,000 puts Titan (1,881), Callisto, Ganymede, Tethys (985)
 * and Enceladus (1,609) on the ice side and everything terrestrial on the other,
 * which is the split the geology actually cares about.
 */
export const ICE_ROCK_DENSITY: number = 2_000

/**
 * Where eccentricity tides stop being a rounding error, dimensionless.
 *
 * The proxy below puts Ganymede and Callisto at ~2.5e-7, Europa at 4.5e-6 and
 * Enceladus at 2.9e-5 — an order of magnitude between the dead ones and the
 * ones with plumes, which is what makes a single threshold usable at all.
 */
export const ACTIVE_TIDAL_PROXY: number = 1e-6

/**
 * The radius to divide a mass by: `(a·b·c)^(1/3)`, not `a`.
 *
 * `body.radius` is the *largest* half-extent. For the ninety-two bodies in Sol
 * that are not spheroids it overstates the volume by up to two thirds, and the
 * dossier's density row shipped exactly that error once — Phobos read
 * 1.08 g/cm³ against a published 1.88. A density that is wrong by 70% on the
 * small bodies would put half the belt on the wrong side of `ICE_ROCK_DENSITY`.
 */
export function volumetricMeanRadius(body: Body): Meters {
  const intermediate = body.figure?.intermediateRadius ?? body.radius
  return Math.cbrt(body.radius * intermediate * body.polarRadius)
}

/** Bulk density, kg/m³. See `volumetricMeanRadius` for the denominator. */
export function bulkDensity(body: Body): number {
  const r = volumetricMeanRadius(body)
  if (!(r > 0)) return 0
  return body.mass / ((4 / 3) * Math.PI * r ** 3)
}

/**
 * How hard a parent flexes a moon, dimensionless and relative.
 *
 * `(M_parent / M_body) · (R_body / a)³ · e`. The mass ratio and the cube are the
 * tidal-bulge scaling; the eccentricity is what makes the bulge *move*, which is
 * where the heat comes from — a perfectly circular orbit raises a static bulge
 * and dissipates nothing.
 *
 * It under-calls two real cases and the honest thing is to say which. A body
 * warmed by an obliquity tide rather than an eccentricity one reads as dead
 * (Triton, whose orbit is circular to five places and whose surface is
 * ten million years old), and so does one still cooling from a capture or a
 * giant impact. Neither is derivable from six orbital elements, and inventing a
 * flag for them would be inventing the answer.
 */
export function tidalProxy(body: Body, parentMass: Kilograms): number {
  if (!(parentMass > 0) || !(body.mass > 0)) return 0
  const a = body.elements.semiMajorAxis
  if (!(a > 0)) return 0
  const r = volumetricMeanRadius(body)
  return (parentMass / body.mass) * (r / a) ** 3 * body.elements.eccentricity
}

/**
 * The kinds that have somewhere to stand.
 *
 * A gas or ice giant has no surface, so it has no archetype either — and the
 * distinction is not academic, because bulk density alone calls Jupiter
 * (1,326 kg/m³) and Saturn (687) icy worlds. They would classify, they would
 * enter a zoo, and a descent would take the camera to a datum radius chosen by
 * where the drag model stops integrating. The `surface` LOD tier must never
 * fire for them; this is the predicate that says so.
 */
const SOLID: Readonly<Record<BodyKind, boolean>> = {
  rocky: true,
  ice: true,
  'gas-giant': false,
  'ice-giant': false,
  moon: true,
  dwarf: true,
  asteroid: true,
  comet: true,
}

export const hasSolidSurface = (body: Body): boolean => SOLID[body.kind]

/**
 * Which archetype a body's surface belongs to.
 *
 * Presumes `hasSolidSurface`; on a giant it returns whatever the density says,
 * which is meaningless rather than wrong. Callers that enumerate — the zoo, the
 * site picker, the descent probe — filter first.
 *
 * `parentMass` is the primary's, for a moon — the star's mass is not it, and
 * passing it would call every planet tidally active. Zero, the default, means
 * "nothing raises tides on this", which is the right answer for a planet and
 * the safe answer for a moon whose parent the caller did not look up.
 */
export function surfaceArchetype(
  body: Body,
  parentMass: Kilograms = 0,
): SurfaceArchetype {
  if (bulkDensity(body) >= ICE_ROCK_DENSITY) {
    return body.atmosphere === null ? 'rocky-airless' : 'rocky-atmosphered'
  }
  return tidalProxy(body, parentMass) >= ACTIVE_TIDAL_PROXY
    ? 'icy-active'
    : 'icy-dead'
}

export const SURFACE_ARCHETYPES: readonly SurfaceArchetype[] = [
  'rocky-airless',
  'rocky-atmosphered',
  'icy-dead',
  'icy-active',
]

/** How the archetypes read in a panel and in a zoo listing. */
const ARCHETYPE_NAMES: Readonly<Record<SurfaceArchetype, string>> = {
  'rocky-airless': 'Rocky, airless',
  'rocky-atmosphered': 'Rocky, atmosphered',
  'icy-dead': 'Icy, dead',
  'icy-active': 'Icy, active',
}

export const archetypeName = (archetype: SurfaceArchetype): string =>
  ARCHETYPE_NAMES[archetype]

/**
 * Whether a body's surface comes from a shipped map rather than from the seed.
 *
 * The terrain milestone's carve-out is mechanical rather than a list: a body
 * with a vendored texture set keeps the rendering path it has, and the new
 * pipeline owns everything else. `appearance.texture` is the key that decides
 * it, and it is already the key the host resolves against the manifest, so
 * there is nothing to keep in step.
 *
 * It says nothing about the body's *terrain*, which has always been seeded on
 * every body in the game including the mapped ones — see the note in
 * `TERRAIN-PLAN.md` § 1 about what the version bump moves.
 */
export const isMappedSurface = (body: Body): boolean =>
  body.appearance.texture !== null
