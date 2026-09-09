import { LIGHT_YEAR, type Meters } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import type { Seed } from '@inertialref/procedural'
import { formatAddress, type GalaxyId } from './address.ts'
import type { SystemStub } from './galaxy.ts'
import { parseSpectralType, type SpectralClass } from './catalog/spectral.ts'
import {
  type Body,
  type BodyKind,
  generateSystem,
  isHabitable,
  isLandable,
  type Star,
  type StarSystem,
  walkBodies,
} from './system.ts'

/*
 * "Show me a water world around a red dwarf", as a predicate.
 *
 * The catalog can already be searched by *name*, which answers the question a
 * person asks when they already know what they are looking for. This is the
 * other question — the one a reading room exists for — and it cannot be
 * answered from an index, because the thing being asked about does not exist
 * until it is generated. A system is a pure function of its seed, so the only
 * way to know whether it holds a world with a sea is to build it and look.
 *
 * That is why this is a *predicate over generated bodies* rather than a query
 * over a table, and why the work is worth moving off the main thread: the
 * matching is microseconds and the generating is milliseconds, times as many
 * systems as the radius contains.
 *
 * **Every field reads something the record already carries.** Nothing here is
 * a tag invented for searching, and that is the constraint that keeps the
 * answers honest: a result is a claim about the world the generator makes, not
 * about a label somebody attached to it. Where a field is derived rather than
 * stored — habitability, landability — it is derived by the function the rest
 * of the build already uses, so the search and the object panel cannot come to
 * different conclusions about the same body.
 *
 * Pure, and free of hosts: `findWorlds` takes the stubs it is to walk rather
 * than a catalog to sweep, so the same call runs in a worker, in a Node test
 * and on the main thread, and the caller decides how the volume is divided.
 */

/** What a search is looking for. Every field is optional and they intersect. */
export interface WorldQuery {
  /** Spectral classes of the host star. Empty means any. */
  readonly starClasses?: readonly SpectralClass[]
  /** Body classes to return. Empty means any. */
  readonly kinds?: readonly BodyKind[]
  /** Only bodies with an atmosphere, or only those without. */
  readonly atmosphere?: boolean
  /** Only bodies whose ground temperature admits a liquid, or only those not. */
  readonly sea?: boolean
  /** Only bodies with a ring system. */
  readonly rings?: boolean
  /** Only bodies in their star's habitable zone, by `isHabitable`. */
  readonly habitable?: boolean
  /** Only bodies `land` would accept: solid, and big enough to be a place. */
  readonly landable?: boolean
  /** At least this many moons. */
  readonly moons?: number
  /** Radius band, in Earth radii. */
  readonly minRadius?: number
  readonly maxRadius?: number
}

/** One body a query matched, with everything a listing needs to draw it. */
export interface WorldMatch {
  readonly address: string
  readonly name: string
  /** The system it is in, so a result can be grouped or opened. */
  readonly system: string
  readonly systemName: string
  readonly kind: BodyKind
  readonly radius: Meters
  readonly semiMajorAxis: Meters
  /** How far the host star is from where the search was centered. */
  readonly lightYears: number
  readonly spectralType: string
  readonly hasAtmosphere: boolean
  readonly hasSea: boolean
  readonly moons: number
  readonly landable: boolean
  readonly habitable: boolean
}

/** Earth's equatorial radius, the unit a radius band is written in. */
const EARTH_RADIUS: Meters = 6_378_137

/**
 * Whether a query asks for anything at all.
 *
 * An empty query matches every body in the volume, which is a real answer and
 * a useless one — tens of thousands of rows, most of them rubble. A caller
 * that has been handed one should say so rather than run it.
 */
export function isEmptyQuery(query: WorldQuery): boolean {
  return (
    (query.starClasses?.length ?? 0) === 0 &&
    (query.kinds?.length ?? 0) === 0 &&
    query.atmosphere === undefined &&
    query.sea === undefined &&
    query.rings === undefined &&
    query.habitable === undefined &&
    query.landable === undefined &&
    query.moons === undefined &&
    query.minRadius === undefined &&
    query.maxRadius === undefined
  )
}

/** Whether a star's class is one the query asked for. */
export function matchesStar(star: Star, query: WorldQuery): boolean {
  const classes = query.starClasses ?? []
  if (classes.length === 0) return true
  return classes.includes(star.spectralClass)
}

/**
 * Whether one body answers a query.
 *
 * Every clause is an intersection, and an absent clause is not a clause: a
 * query with nothing set matches everything, which is what makes the fields
 * composable without an "any" sentinel per field.
 *
 * `sea` reads `surface.seaLevel`, which is the generator's own answer to
 * whether the ground temperature admits a liquid — `null` where it does not.
 * That is a stronger claim than "has water": a body's sea may be methane, and
 * [ADR-0026](../../../docs/adr/0026-the-liquid.md) is deliberate that the
 * search should not pretend otherwise.
 */
export function matchesBody(
  star: Star,
  body: Body,
  query: WorldQuery,
): boolean {
  const kinds = query.kinds ?? []
  if (kinds.length > 0 && !kinds.includes(body.kind)) return false
  if (query.atmosphere !== undefined) {
    if ((body.atmosphere !== null) !== query.atmosphere) return false
  }
  if (query.sea !== undefined) {
    if ((body.surface.seaLevel !== null) !== query.sea) return false
  }
  if (query.rings !== undefined) {
    if ((body.appearance.rings !== null) !== query.rings) return false
  }
  if (query.habitable !== undefined) {
    if (isHabitable(star, body) !== query.habitable) return false
  }
  if (query.landable !== undefined) {
    if (isLandable(body) !== query.landable) return false
  }
  if (query.moons !== undefined && body.moons.length < query.moons) return false
  if (
    query.minRadius !== undefined &&
    body.radius < query.minRadius * EARTH_RADIUS
  )
    return false
  if (
    query.maxRadius !== undefined &&
    body.radius > query.maxRadius * EARTH_RADIUS
  )
    return false
  return true
}

/** One system's matches, as rows. */
export function matchSystem(
  system: StarSystem,
  query: WorldQuery,
  from: UniverseVector,
): readonly WorldMatch[] {
  if (!matchesStar(system.star, query)) return []
  const lightYears = UV.distance(system.position, from) / LIGHT_YEAR
  const out: WorldMatch[] = []
  for (const body of walkBodies(system)) {
    if (!matchesBody(system.star, body, query)) continue
    out.push({
      address: formatAddress(body.address),
      name: body.name,
      system: system.id,
      systemName: system.name,
      kind: body.kind,
      radius: body.radius,
      semiMajorAxis: body.elements.semiMajorAxis,
      lightYears,
      spectralType: system.star.spectralType,
      hasAtmosphere: body.atmosphere !== null,
      hasSea: body.surface.seaLevel !== null,
      moons: body.moons.length,
      landable: isLandable(body),
      habitable: isHabitable(system.star, body),
    })
  }
  return out
}

/**
 * Walk a list of systems, generating each, and return what matches.
 *
 * The stubs are an argument rather than a sweep, and that is what makes this
 * divisible: a caller cuts the volume into batches, hands each to its own job,
 * and shows the answers as they arrive rather than after the last one. It is
 * also what keeps the catalog out of the worker — a stub is what the caller
 * already resolved, so nothing here needs a 200 KB table to answer with.
 *
 * `cancelled` is polled per system rather than per body, because a system is a
 * millisecond and a body is microseconds: that bounds the wasted work without
 * the check costing more than the work it is guarding.
 */
export function findWorlds(
  rootSeed: Seed,
  galaxy: GalaxyId,
  stubs: readonly SystemStub[],
  query: WorldQuery,
  from: UniverseVector,
  cancelled: () => boolean = () => false,
): readonly WorldMatch[] {
  const out: WorldMatch[] = []
  for (const stub of stubs) {
    if (cancelled()) return out
    /*
     * The star's class is checked before the system is built, which is where
     * the whole cost of this is: generating a system is milliseconds and
     * reading a letter off a stub is cheap. Rejecting nonmatching classes here
     * avoids generating those systems; the saving depends on the selected volume.
     */
    if (!matchesStubStar(stub, query)) continue
    let system: StarSystem
    try {
      system = generateSystem(rootSeed, galaxy, stub)
    } catch {
      // A stub the generator refuses is one system missing from an answer, not
      // a failed search. It cannot be reported per system without making every
      // batch's result a union type for a case nothing has produced.
      continue
    }
    for (const match of matchSystem(system, query, from)) out.push(match)
  }
  return out
}

/**
 * The star filter, applied to a stub rather than to a generated star.
 *
 * Published types include luminosity prefixes such as Barnard's `sdM4`.
 * Parse them before filtering, with the same unclassified fallback as the
 * system generator, so this optimization cannot discard a matching host.
 */
function matchesStubStar(stub: SystemStub, query: WorldQuery): boolean {
  const classes = query.starClasses ?? []
  if (classes.length === 0) return true
  const spectralClass =
    parseSpectralType(stub.spectralType).spectralClass ?? 'M'
  return classes.includes(spectralClass)
}
