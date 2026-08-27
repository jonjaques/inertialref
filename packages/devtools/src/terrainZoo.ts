import { LIGHT_YEAR, type Meters } from '@inertialref/shared'
import type { World } from '@inertialref/simulation'
import {
  archetypeName,
  type Body,
  bulkDensity,
  formatAddress,
  hasSolidSurface,
  isMappedSurface,
  SOL,
  type StarSystem,
  type SurfaceArchetype,
  SURFACE_ARCHETYPES,
  surfaceArchetype,
  systemsWithin,
  volumetricMeanRadius,
} from '@inertialref/universe'

/*
 * The terrain zoo: one body per archetype, found rather than written down.
 *
 * Every visual phase of the terrain milestone is judged by plates of the same
 * places, and "the same places" has to survive the generator changing under it.
 * A list of addresses in a file does not: the moment a catalog revision or a
 * version bump moves a body, the zoo is three worlds and a 404, and nothing
 * says so. So the zoo is a *search* with a pinned expectation — the search is
 * what the tools call, and `terrainZoo.test.ts` asserts that it still returns
 * one of each. A zoo that quietly loses its icy worlds fails a test instead of
 * producing a shorter plate set nobody counts.
 *
 * **It is a set of bodies, not a system, and that is a finding rather than a
 * convenience.** The plan assumed one seed would produce a system with all four
 * archetypes in it. It does not, and the reason is worth writing down: no
 * generated system within 25 ly of Sol contains an `icy-active` body, because
 * generated moons come out on orbits too circular for the eccentricity tide to
 * register. Sol supplies both icy archetypes from its own unmapped moons —
 * Iapetus and Miranda — and neither of them has a shipped map, so both are
 * squarely inside the milestone's scope. The rocky pair comes from the nearest
 * generated systems.
 *
 * The second finding is why the rocky pair has to come from outside Sol at all:
 * **every unmapped rocky body in the Solar System is generated with
 * `maxElevation` of zero.** Eris, Makemake, Quaoar and the rest are perfectly
 * smooth spheres. That is a gap in the small-body generator rather than in this
 * search, and it is the reason a rocky archetype cannot be drawn from Sol.
 */

/** What the zoo says about one of its members. */
export interface ZooEntry {
  readonly archetype: SurfaceArchetype
  readonly address: string
  readonly name: string
  readonly system: string
  /** `(a·b·c)^(1/3)`, kilometers — the radius a density divides by. */
  readonly meanRadiusKm: number
  readonly maxElevation: Meters
  /** Relief over mean radius. The rule that picked this body over its peers. */
  readonly relief: number
  readonly detail: string
}

/**
 * Below this a body is a rock rather than a world, meters.
 *
 * 200 km, not `isLandable`'s 1,000 km. That predicate answers "can a ship put
 * down here and have somewhere to be", which is a gameplay question; this one
 * answers "is there enough ground for a descent from orbit to two meters to
 * pass through every level", which four hundred kilometers of diameter is. The
 * cut also keeps Enceladus (252 km) and Miranda (236 km) in, and they are two
 * of the most geologically interesting surfaces there are.
 */
export const ZOO_MIN_RADIUS: Meters = 200_000

/** How far the search will go looking for an archetype Sol cannot supply. */
const DEFAULT_LIGHT_YEARS = 15

/**
 * How many systems the search may generate before giving up.
 *
 * Generating a system is milliseconds, not microseconds, and this runs from a
 * panel. Twelve is comfortably more than the two the nearest neighborhood
 * actually needs and is still under a tenth of a second.
 */
const DEFAULT_SYSTEM_BUDGET = 12

export interface ZooOptions {
  readonly lightYears?: number
  readonly systemBudget?: number
  readonly minRadius?: Meters
}

/**
 * Whether a body is a subject for the terrain milestone at all.
 *
 * Four cuts, each of them a carve-out the plan already names. No shipped map,
 * because a mapped body keeps the rendering path it has. No figure, because a
 * measured shape model's datum is a radius grid rather than the cube-sphere's
 * near-sphere and deep terrain on one is a later projection problem. Solid,
 * because the `surface` tier must never fire for a giant. And relief above
 * zero, because a body whose `maxElevation` is zero has no terrain to look at
 * whatever the generator does next.
 */
export const isZooCandidate = (body: Body, minRadius: Meters): boolean =>
  hasSolidSurface(body) &&
  !isMappedSurface(body) &&
  body.figure === null &&
  body.surface.maxElevation > 0 &&
  volumetricMeanRadius(body) >= minRadius

/** Relief as a fraction of mean radius — how much terrain there is to see. */
export const zooRelief = (body: Body): number =>
  body.surface.maxElevation / volumetricMeanRadius(body)

function* bodiesWithParents(
  system: StarSystem,
): Generator<{ body: Body; parentMass: number }> {
  for (const planet of system.planets) {
    // A planet's tides are raised by its star, which is not what the proxy
    // measures. Zero is the honest input, and `surfaceArchetype` says so.
    yield { body: planet, parentMass: 0 }
    for (const moon of planet.moons) {
      yield { body: moon, parentMass: planet.mass }
    }
  }
}

function entryFor(
  body: Body,
  system: StarSystem,
  archetype: SurfaceArchetype,
): ZooEntry {
  const meanRadius = volumetricMeanRadius(body)
  return {
    archetype,
    address: formatAddress(body.address),
    name: body.name,
    system: system.id,
    meanRadiusKm: meanRadius / 1000,
    maxElevation: body.surface.maxElevation,
    relief: zooRelief(body),
    detail:
      `${archetypeName(archetype)} · ${(meanRadius / 1000).toFixed(0)} km mean radius · ` +
      `${bulkDensity(body).toFixed(0)} kg/m³ · ${(body.surface.maxElevation / 1000).toFixed(1)} km of relief`,
  }
}

/**
 * One body per archetype, best-first, searching outward from Sol.
 *
 * "Best" is the most relief per unit radius, which is the rule that puts
 * Miranda ahead of Titan for `icy-active`: 10 km of scarp on a 236 km moon is
 * 4.2% of its own radius, and Titan's 350 m on 2,575 km is 0.014%. A zoo is
 * where terrain is *looked at*, so the body with the most of it per pixel wins
 * — and Verona Rupes is a real 10 km cliff, so the rule is picking the right
 * world for the right reason rather than picking a big number.
 *
 * **This loads systems.** It is the same caveat capability check 3 carries: a
 * session that has asked for the zoo has more systems loaded than one that has
 * not, which is visible in `ir.summary()` and is not a bug. It stops the moment
 * all four archetypes are filled.
 *
 * **What it must not do is read what is already loaded**, and the first version
 * did. Considering `world.loadedSystems()` before generating anything makes the
 * answer a function of where the session has been: a browser that had flown
 * fifteen light years returned a different rocky pair from `pnpm sim`, on the
 * same seed, because twenty extra systems were sitting in the world when the
 * search ran. That is the "never make generation depend on order" rule exactly
 * — generating a different object first changed this one's output — and it
 * hollows out the whole point of a fixture, which is that the same places come
 * back. The search is anchored at Sol and walks `systemsWithin` in its own
 * sorted order instead, so the result is a function of the galaxy seed, the
 * catalog, the radius and the budget, and of nothing else.
 */
export function terrainZoo(
  world: World,
  options: ZooOptions = {},
): readonly ZooEntry[] {
  const minRadius = options.minRadius ?? ZOO_MIN_RADIUS
  const best = new Map<SurfaceArchetype, { body: Body; system: StarSystem }>()

  const consider = (system: StarSystem): void => {
    for (const { body, parentMass } of bodiesWithParents(system)) {
      if (!isZooCandidate(body, minRadius)) continue
      const archetype = surfaceArchetype(body, parentMass)
      const held = best.get(archetype)
      // Strict `>`, so a tie keeps the body found first — and since the search
      // order is now fixed, "first" is a property of the galaxy rather than of
      // the session.
      if (held === undefined || zooRelief(body) > zooRelief(held.body)) {
        best.set(archetype, { body, system })
      }
    }
  }

  // Sol first, always and explicitly. It is in every catalog, it supplies both
  // icy archetypes from unmapped moons, and anchoring there is what makes the
  // answer the same in a console, in `pnpm sim` and in a test.
  const sol = world.loadSystem(SOL)
  consider(sol)

  let generated = 0
  for (const stub of systemsWithin(
    world.galaxySeed,
    world.catalog,
    sol.position,
    (options.lightYears ?? DEFAULT_LIGHT_YEARS) * LIGHT_YEAR,
  )) {
    if (best.size >= SURFACE_ARCHETYPES.length) break
    if (generated >= (options.systemBudget ?? DEFAULT_SYSTEM_BUDGET)) break
    if (stub.id === SOL) continue
    generated += 1
    try {
      consider(world.loadSystem(stub.id))
    } catch {
      // A stub that will not generate is a catalog problem, not a zoo
      // problem; the search has eleven more to try. Counted against the budget
      // either way, so a run of bad stubs cannot turn the budget into a
      // different number of *successful* generations on two different machines.
      continue
    }
  }

  // Declaration order, not discovery order, so a plate set keeps its rows.
  return SURFACE_ARCHETYPES.flatMap((archetype) => {
    const hit = best.get(archetype)
    return hit === undefined ? [] : [entryFor(hit.body, hit.system, archetype)]
  })
}

/**
 * The archetypes the zoo is missing, if any. Empty is the only passing answer.
 *
 * Split out so the capability check, the headless runner and the test all ask
 * the same question rather than each writing its own set arithmetic.
 */
export const missingArchetypes = (
  zoo: readonly ZooEntry[],
): readonly SurfaceArchetype[] => {
  const held = new Set(zoo.map((entry) => entry.archetype))
  return SURFACE_ARCHETYPES.filter((archetype) => !held.has(archetype))
}
