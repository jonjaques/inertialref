import {
  AU,
  formatDistance,
  LIGHT_YEAR,
  type Meters,
} from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  type Body,
  bodyFrameId,
  type EntityId,
  formatAddress,
  type GalaxyId,
  isLandable,
  parseAddress,
  type StarSystem,
  type SystemId,
  systemId,
  systemsWithin,
  type UniverseAddress,
  walkBodies,
} from '@inertialref/universe'

/*
 * Where can I go, and what is it called?
 *
 * The harness could already *drive* the game — orbit, land, burn — but only if
 * you already knew an address to hand it. A session opens above the first
 * landable body of Sol and nothing in the running game tells you that
 * `g:milky-way/s:SOL/b:2` is a place, let alone what is there. That gap is the
 * difference between a debug tool an author can use and one they can only use
 * with the source open beside them.
 *
 * So: one function that answers "where can I go from here", returning plain
 * data, and one resolver that turns everything a human might type into an
 * address. The overlay renders the list and the console prints it; neither
 * knows how it was built. It lives beside the harness rather than inside it
 * because it is a query over the world, not a way of driving it.
 */

/** A place the player can be sent, as a row of a listing. */
export interface TravelTarget {
  readonly kind: 'system' | 'body'
  /** Text address — the same string generation, saves and logs key off. */
  readonly address: string
  readonly name: string
  /** The system this row belongs to, so a listing can be grouped or filtered. */
  readonly system: string
  /** 0 for a system, 1 for a planet, 2 for a moon: the tree depth to indent by. */
  readonly depth: number
  /** Kind, size and orbit, already formatted for display. */
  readonly detail: string
  /** Distance from wherever the listing was taken, right now. */
  readonly distance: Meters
  readonly distanceText: string
  /** Whether `land` will work: solid ground and big enough to be a place. */
  readonly landable: boolean
  /** Whether the system is generated and its frames installed. */
  readonly loaded: boolean
}

export interface TravelTargetOptions {
  /**
   * Radius of the star survey. Loaded systems are always listed regardless —
   * flying four light years and having the place you came from drop out of the
   * list is how you get stranded with no way back.
   */
  readonly lightYears?: number
}

/** Default survey radius. Wide enough to hold the nearest half-dozen stars. */
const DEFAULT_SURVEY_LIGHT_YEARS = 8

export function travelTargets(
  world: World,
  from: UniverseVector,
  options: TravelTargetOptions = {},
): readonly TravelTarget[] {
  const time = world.clock.time
  const loaded = new Map<SystemId, StarSystem>(
    world.loadedSystems().map((s) => [s.id, s]),
  )

  const stars = new Map<
    SystemId,
    { name: string; position: UniverseVector; detail: string }
  >()
  for (const stub of systemsWithin(
    world.galaxySeed,
    world.catalog,
    from,
    (options.lightYears ?? DEFAULT_SURVEY_LIGHT_YEARS) * LIGHT_YEAR,
  )) {
    stars.set(stub.id, {
      name: stub.name,
      position: stub.position,
      detail: `${stub.spectralType} · ${stub.solarMasses.toFixed(2)} M☉`,
    })
  }
  for (const system of loaded.values()) {
    stars.set(system.id, {
      name: system.name,
      position: system.position,
      detail: `${system.star.spectralType} · ${system.planets.length} planets`,
    })
  }

  const targets: TravelTarget[] = []
  const ordered = [...stars.entries()].sort(
    (a, b) =>
      UV.distance(a[1].position, from) - UV.distance(b[1].position, from),
  )

  for (const [id, star] of ordered) {
    const system = loaded.get(id)
    const distance = UV.distance(star.position, from)
    targets.push({
      kind: 'system',
      address: `g:${world.galaxy}/s:${id}`,
      name: star.name,
      system: id,
      depth: 0,
      detail: star.detail,
      distance,
      distanceText: formatDistance(distance),
      landable: false,
      loaded: system !== undefined,
    })
    if (system === undefined) continue

    for (const body of walkBodies(system)) {
      // A body's position is its frame's pose, not its orbital elements: the
      // elements say where it is relative to its primary, and the listing wants
      // how far away it is from the player, which is a different question once
      // the player is in another system entirely.
      const position = world.frames.pose(
        bodyFrameId(body.address),
        time,
      ).position
      const bodyDistance = UV.distance(position, from)
      targets.push({
        kind: 'body',
        address: formatAddress(body.address),
        name: body.name,
        system: id,
        // A planet's address has one index, a moon's has two.
        depth: body.address.kind === 'body' ? body.address.body.length : 1,
        detail: describeBody(body),
        distance: bodyDistance,
        distanceText: formatDistance(bodyDistance),
        landable: isLandable(body),
        loaded: true,
      })
    }
  }

  return targets
}

function describeBody(body: Body): string {
  const radiusKm = `${(body.radius / 1000).toFixed(0)} km`
  // Moons orbit at a few hundred thousand kilometres, which `formatDistance`
  // renders as "0.003 AU" — technically right, useless for telling two moons
  // apart. Planets are the other way round.
  const orbit =
    body.kind === 'moon'
      ? `${(body.elements.semiMajorAxis / 1000).toFixed(0)} km`
      : `${(body.elements.semiMajorAxis / AU).toFixed(3)} AU`
  return `${body.kind} · ${radiusKm} · ${orbit}`
}

/* ------------------------------------------------------------------------- */
/* Resolving what a human typed                                               */
/* ------------------------------------------------------------------------- */

export type TravelDestination =
  | { readonly kind: 'system'; readonly system: SystemId }
  | {
      readonly kind: 'body'
      readonly system: SystemId
      readonly address: UniverseAddress
      /** Canonical text form, which is what the driving verbs take. */
      readonly text: string
    }

/**
 * Turn anything worth typing into a destination.
 *
 * Accepts the canonical form (`g:milky-way/s:SOL/b:2`), the galaxy-less form a
 * listing shows (`s:SOL/b:2`), a bare catalogue designation (`HIP71683`) and a
 * body relative to where the player already is (`b:2.0`). `parseAddress` itself
 * deliberately refuses all but the first — it is the strict boundary for
 * generation and save files, and loosening it there would mean an address whose
 * meaning depends on who is asking. That ambiguity is fine *here*, at a debug
 * prompt, and nowhere else, which is why the leniency lives in this function.
 */
export function resolveDestination(
  text: string,
  galaxy: GalaxyId,
  currentSystem: SystemId | null,
): TravelDestination {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('No destination given')

  // No tags at all: a system designation, `SOL` or `HIP71683`.
  if (!trimmed.includes(':'))
    return { kind: 'system', system: systemId(trimmed) }

  let full = trimmed
  if (!full.startsWith('g:')) {
    const relativeToSystem = /^[bro]:/.test(full)
    if (relativeToSystem) {
      if (currentSystem === null) {
        throw new Error(
          `"${trimmed}" is relative to a system, and the player is not in one`,
        )
      }
      full = `g:${galaxy}/s:${currentSystem}/${full}`
    } else {
      full = `g:${galaxy}/${full}`
    }
  }

  const address = parseAddress(full)
  switch (address.kind) {
    case 'system':
      return { kind: 'system', system: address.system }
    case 'body':
      return {
        kind: 'body',
        system: address.system,
        address,
        text: formatAddress(address),
      }
    case 'region':
    case 'object': {
      // You cannot be sent to a patch of ground or a rock on it yet, so the
      // useful answer is the body that contains it rather than a refusal.
      const body: UniverseAddress = {
        kind: 'body',
        galaxy: address.galaxy,
        system: address.system,
        body: address.body,
      }
      return {
        kind: 'body',
        system: address.system,
        address: body,
        text: formatAddress(body),
      }
    }
    default:
      throw new Error(
        `"${trimmed}" names a galaxy, which is not somewhere you can be sent`,
      )
  }
}

/**
 * The system an entity is inside, from its frame chain.
 *
 * The frame chain, not the address: a ship has no address at all. This is the
 * same rule authority follows, for the same reason — containment is what makes
 * a ship *in* Sol, not a field on the ship.
 */
export function currentSystemOf(
  world: World,
  id: EntityId | null,
): SystemId | null {
  if (id === null) return null
  const entity = world.entities.get(id)
  if (entity === undefined || !world.frames.has(entity.state.frame)) return null
  for (const frame of world.frames.chain(entity.state.frame)) {
    // `sf:` (a surface frame) also begins with an "s", hence the colon.
    if (frame.startsWith('s:')) return systemId(frame.slice(2))
  }
  return null
}

/**
 * A circular orbit that frames the body and stays put.
 *
 * One radius up, so the centre sits two radii away and the body subtends
 * 2·asin(1/2) = 60° — just inside the 65° field of view the client uses. A
 * quarter of a radius was the first guess and it is wrong in a way you only see
 * on screen: the body subtends 106° and fills the frame edge to edge, so
 * arriving somewhere new looks like a flat coloured wall rather than a planet.
 *
 * The clamp against the sphere of influence is the part that is not obvious: a
 * "circular orbit" placed outside the SOI is reframed to the parent —
 * `stepFlight` leaves at 1.05 × SOI — and what was a parking orbit becomes a
 * hyperbolic departure, so the debug verb that promised to park you somewhere
 * would instead fling you into the system. The margin below that threshold is
 * thin on purpose. Half the SOI was the first attempt and it is *too* generous
 * to be useful: Proxima Centauri I orbits at 0.005 AU, so half its SOI is
 * 750 km inside its own surface and the clamp collapsed onto the floor, leaving
 * you 10 km above the ground looking at an orange wall. A circular orbit does
 * not drift, so the only headroom it needs is against the threshold itself.
 */
export function viewingAltitudeKm(body: Body): number {
  const wanted = Math.max(SMALL_BODY_VIEWING_ALTITUDE, body.radius)
  const ceiling = body.sphereOfInfluence * SOI_FRACTION - body.radius
  // The floor wins over the ceiling for a body whose sphere of influence barely
  // clears its own surface. There is no orbit inside the SOI of such a thing,
  // so the choice is between a debug verb that refuses and one that puts you
  // somewhere you can see the body from; the second is more useful and the
  // frame transition that follows is a real behaviour worth being able to watch.
  return Math.max(MINIMUM_VIEWING_ALTITUDE, Math.min(wanted, ceiling)) / 1000
}

/**
 * Whether anything can be in orbit around this body at all.
 *
 * Not a hypothetical. Phobos masses 1.07 × 10^16 kg and orbits 9,376 km from
 * Mars, which puts its sphere of influence at **7.2 km** — inside its own
 * 11.3 km radius. There is no altitude above Phobos that is still bound to
 * Phobos, and the same is nearly true of Deimos. `viewingAltitudeKm` therefore
 * parks you next to it in Mars's frame rather than refusing, and this is how a
 * caller knows which of the two it got.
 */
export const canHoldOrbit = (body: Body): boolean =>
  body.sphereOfInfluence * SOI_FRACTION > body.radius + MINIMUM_VIEWING_ALTITUDE

/** How much of the sphere of influence a parking orbit may use. */
const SOI_FRACTION = 0.9

/** Never park closer than this, whatever the arithmetic says. */
const MINIMUM_VIEWING_ALTITUDE: Meters = 10_000
/** One radius above a 40 km rock is 40 km, which is closer than it sounds. */
const SMALL_BODY_VIEWING_ALTITUDE: Meters = 100_000
