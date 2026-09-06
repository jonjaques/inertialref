import { AU, formatReading, LIGHT_YEAR, type Meters } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  type Body,
  type BodyKind,
  type BodyProvenance,
  bodyFrameId,
  type CatalogStar,
  type EntityId,
  findBody,
  formatAddress,
  formatSpectralType,
  parentAddress,
  type LinearRgb,
  type GalaxyId,
  isLandable,
  parseAddress,
  resolveSystem,
  type StarSystem,
  type SystemId,
  systemId,
  systemsWithin,
  type UniverseAddress,
  walkBodies,
  planetCount,
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
  /**
   * Distance from wherever the listing was taken.
   *
   * From the sweep that produced the row, which is not always the last one:
   * `sameTargets` keeps a listing whose every *text* is unchanged, so a
   * subscriber holding rows through a hover holds this number from whenever
   * the text last moved. It is wrong by less than `distanceText`'s own
   * resolution and by no more; anything that needs the meter wants
   * `UV.distance` against a fresh pose rather than a row of a listing.
   */
  readonly distance: Meters
  readonly distanceText: string
  /** Whether `land` will work: solid ground and big enough to be a place. */
  readonly landable: boolean
  /** Whether the system is generated and its frames installed. */
  readonly loaded: boolean
  /**
   * Whether this is a place somebody has actually seen, or one this generator
   * expects to be there.
   *
   * The epistemic fact, and it is the one the interface promises to state
   * (PRODUCT.md). It is not `loaded`: loaded is a streaming fact about this
   * session, and a real star is real whether or not its frames are installed.
   * The projection used to drop this, so Alpha Centauri and an invented star
   * four light years the other way rendered identically.
   */
  readonly provenance: BodyProvenance
  /**
   * The body's own class, or null on a system row.
   *
   * Structured rather than left inside `detail`, because two readers now branch
   * on it and both were reduced to parsing a sentence: the catalog draws a glyph
   * per class — a comet is not a circle — and its filter chips select by it.
   * `detail` is a line of prose for a human and must stay free to be rewritten.
   */
  readonly bodyKind: BodyKind | null
  /** Spectral type on a system row, null on a body. */
  readonly spectralType: string | null
  /**
   * The star's own colour, linear sRGB, or null on a body row.
   *
   * A measurement rather than decoration: `docs/design/art.md` puts a star's
   * colour on the list of things the game may not invent, because it follows
   * from the effective temperature. A K dwarf is orange and does not get to be
   * a nicer orange. Carried here rather than looked up from the class letter,
   * so the glyph in the catalog and the disk in the sky are the same number.
   */
  readonly colour: {
    readonly r: number
    readonly g: number
    readonly b: number
  } | null
  /** Equatorial radius, meters. A star's own on a system row. */
  readonly radius: Meters
  /** Semi-major axis about its primary, meters. 0 on a system row. */
  readonly semiMajorAxis: Meters
  /** How many bodies go round this one. Planets for a star, moons for a planet. */
  readonly children: number
  /**
   * The row this one hangs off — a body's primary, a system's own address.
   *
   * What makes the flat listing a tree the panel can fold. Sol is 129 bodies
   * and a list that cannot be collapsed is a list nobody scrolls twice.
   */
  readonly parent: string | null
}

/** The scalar half of a row: every field `sameTargets` compares with `!==`. */
type ComparedField = Exclude<keyof TravelTarget, 'distance' | 'colour'>

/**
 * `true` for a field `!==` can decide, and `never` for one it cannot.
 *
 * The second half of the guard below, and the half that is easy to leave out.
 * `Record<ComparedField, true>` proves the list is *complete*; it says nothing
 * about whether each listed field is comparable by identity. Widen `parent` to
 * a row reference or `children` to an array of ids and the table still
 * typechecks, while `x[key] !== y[key]` becomes true on every fresh survey —
 * `sameTargets` returns false forever, and the catalog goes back to
 * re-rendering every row at the poll rate with nothing failing. Mapping the
 * value type through this makes that an error at the declaration instead.
 *
 * `[T] extends [...]`, in brackets, because a bare `T extends` distributes over
 * unions — and every field most at risk of being widened is already a union.
 * Distributed, `ByIdentity<Row | null>` is `never | true`, which is `true`, so
 * the guard passed exactly the three nullable fields it was written for
 * (`parent`, `spectralType`, `bodyKind`) and caught only the non-nullable ones.
 * The tuple makes the check a single non-distributive comparison.
 */
type ByIdentity<T> = [T] extends [string | number | boolean | null | undefined]
  ? true
  : never

/**
 * The comparison's field list, as a table the type checker keeps complete.
 *
 * A chain of `x.name !== y.name || …` is the faster spelling and the one that
 * goes quietly stale: a field added to `TravelTarget` next year is simply
 * absent from it, the panel stops redrawing when that field alone changes, and
 * nothing fails. `Record` over the key set makes the omission an error at the
 * moment the field is declared, which is the only moment anyone is looking.
 *
 * Two keys are deliberately not in it. `distance` is the exclusion
 * `sameTargets` is about. `colour` is a nested value, so `!==` on it is true on
 * every sweep and would defeat the whole bail-out; it is compared component-wise
 * below.
 */
const COMPARED: { [K in ComparedField]: ByIdentity<TravelTarget[K]> } = {
  kind: true,
  address: true,
  name: true,
  system: true,
  depth: true,
  detail: true,
  distanceText: true,
  landable: true,
  loaded: true,
  provenance: true,
  bodyKind: true,
  spectralType: true,
  radius: true,
  semiMajorAxis: true,
  children: true,
  parent: true,
}

const COMPARED_KEYS = Object.keys(COMPARED) as readonly ComparedField[]

/**
 * Whether two listings would draw the same panel.
 *
 * The survey rebuilds every row it answers with, so a poll that re-reads an
 * unchanged sky still hands its subscriber a fresh array — and in React a
 * fresh array is a re-render of every row in the catalog, at the poll rate,
 * forever. This is the bail-out: everything a row displays is compared, and
 * `distance` alone is not, because it is the raw measure that moves by meters
 * every sweep while `distanceText` — the thing a reader sees, at the
 * resolution that matters — holds still. A listing whose every text is
 * unchanged has moved less than the text can say, and the stale raw number
 * kept with it is wrong by less than that.
 */
export function sameTargets(
  a: readonly TravelTarget[],
  b: readonly TravelTarget[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as TravelTarget
    const y = b[i] as TravelTarget
    for (const key of COMPARED_KEYS) if (x[key] !== y[key]) return false
    const cx = x.colour
    const cy = y.colour
    if (cx === null || cy === null) {
      if (cx !== cy) return false
    } else if (cx.r !== cy.r || cx.g !== cy.g || cx.b !== cy.b) {
      return false
    }
  }
  return true
}

export interface TravelTargetOptions {
  /**
   * Radius of the star survey. Loaded systems are always listed regardless —
   * flying four light years and having the place you came from drop out of the
   * list is how you get stranded with no way back.
   */
  readonly lightYears?: number
  /**
   * Whose "here" the listing is centered on and sorted by. Default `player`.
   *
   * The two are the same thing in a flight mode and are not remotely the same
   * thing in the planetarium, where the whole verb is `look` — the camera goes
   * to Alpha Centauri and the ship does not. Centered on the player, the
   * catalog there listed Sol's bodies first and reported Alpha Centauri at
   * 4.4 light years while it filled the frame, which is a listing describing
   * somewhere the reader is not.
   *
   * It is a survey origin as well as a sort key: `systemsWithin` sweeps around
   * this point, so the observer's neighbors are the ones offered.
   */
  readonly origin?: 'player' | 'observer'
}

/** Default survey radius. Wide enough to hold the nearest half-dozen stars. */
const DEFAULT_SURVEY_LIGHT_YEARS = 8

/**
 * How far a world search sweeps when it is not told.
 *
 * Twenty-five light years, which is the catalog's own complete radius — inside
 * it every star is a real one and the answers are about places that exist,
 * which is the sweep worth defaulting to. Wider is a deliberate act, and the
 * panel offers it.
 */
export const DEFAULT_SEARCH_LIGHT_YEARS = 25

/**
 * How many systems one search job walks.
 *
 * The number decides how often the list grows, and both ends of the range are
 * bad. Too large and a fifty-light-year sweep is a handful of jobs, so rows
 * arrive in three lumps and the last worker holds the whole answer; too small
 * and the queue is thousands of jobs whose per-job overhead — a structured
 * clone of the batch each way — is a real share of the work. Thirty-two
 * systems is about a quarter-second of generating, which is close enough to a
 * frame's worth of new rows to read as filling in.
 */
export const SEARCH_BATCH = 32

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
    {
      name: string
      position: UniverseVector
      detail: string
      spectralType: string
      colour: LinearRgb
      provenance: BodyProvenance
    }
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
      spectralType: stub.spectralType,
      colour: stub.colour,
      // The domain word, not the storage boolean. `catalogued` says which table
      // the row came out of; `observed` says somebody pointed a telescope at it,
      // which is what the listing is actually claiming.
      provenance: stub.catalogued ? 'observed' : 'projected',
    })
  }
  for (const system of loaded.values()) {
    stars.set(system.id, {
      name: system.name,
      position: system.position,
      detail: `${system.star.spectralType} · ${planetCount(system)} planets`,
      spectralType: system.star.spectralType,
      colour: system.star.colour,
      // A loaded system may be outside the survey radius, so this cannot be
      // inherited from the sweep above. Asked of the catalog directly, which is
      // the same question `catalogStub` answers with `catalogued: true` — and
      // not of `observedPlanets`, which is 0 for a real star nobody has found
      // a planet around yet.
      provenance:
        world.catalog.get(system.id) === undefined ? 'projected' : 'observed',
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
    /*
     * One encoder for the address, which the rows under this one hang off:
     * a body's `parent` at depth 1 is exactly this string, and two hand-written
     * copies of the grammar agreeing is not something a compiler checks.
     */
    const systemAddress: UniverseAddress = {
      kind: 'system',
      galaxy: world.galaxy,
      system: id,
    }
    targets.push({
      kind: 'system',
      address: formatAddress(systemAddress),
      name: star.name,
      system: id,
      depth: 0,
      detail: star.detail,
      distance,
      distanceText: formatReading(distance),
      landable: false,
      loaded: system !== undefined,
      provenance: star.provenance,
      bodyKind: null,
      spectralType: star.spectralType,
      colour: star.colour,
      radius: system?.star.radius ?? 0,
      semiMajorAxis: 0,
      children: system === undefined ? 0 : planetCount(system),
      parent: null,
    })
    if (system === undefined) continue

    for (const body of walkBodies(system))
      targets.push(bodyTarget(world, from, time, system, body))
  }

  return targets
}

/**
 * One body, as a row.
 *
 * Shared between the survey and `targetsFor`, so a body reached by sweeping
 * the sky and the same body reached by typing its name are one row and not two
 * projections of it that agree by luck.
 */
function bodyTarget(
  world: World,
  from: UniverseVector,
  time: number,
  system: StarSystem,
  body: Body,
): TravelTarget {
  // A body's position is its frame's pose, not its orbital elements: the
  // elements say where it is relative to its primary, and the listing wants
  // how far away it is from the player, which is a different question once
  // the player is in another system entirely.
  const position = world.frames.pose(bodyFrameId(body.address), time).position
  const bodyDistance = UV.distance(position, from)
  const systemAddress: UniverseAddress = {
    kind: 'system',
    galaxy: world.galaxy,
    system: system.id,
  }
  return {
    kind: 'body',
    address: formatAddress(body.address),
    name: body.name,
    system: system.id,
    // A planet's address has one index, a moon's has two.
    depth: body.address.kind === 'body' ? body.address.body.length : 1,
    detail: describeBody(body),
    distance: bodyDistance,
    distanceText: formatReading(bodyDistance),
    landable: isLandable(body),
    loaded: true,
    // The body's own, not its system's: Sol is observed and Ganymede is
    // observed, but every moon of a catalog star is currently a projection.
    provenance: body.provenance,
    bodyKind: body.kind,
    spectralType: null,
    colour: null,
    radius: body.radius,
    semiMajorAxis: body.elements.semiMajorAxis,
    children: body.moons.length,
    /*
     * `parentAddress`, which is `universe`'s own — it already answers the
     * depth-1 case with the system's address. Slicing the path here and
     * concatenating `g:…/s:…` for the top level was a second copy of the
     * address grammar, and one it would be silent about breaking: a changed
     * separator leaves every `parent` failing to match any `address`, which
     * `orbitalOrder` reads as "no parent is present" and flattens the tree.
     */
    parent: formatAddress(parentAddress(body.address) ?? systemAddress),
  }
}

/**
 * One system, as a row, from whichever record the world has for it.
 *
 * Three records can describe a system — the loaded `StarSystem`, the
 * `CatalogStar`, and a procedural stub — and a listing has to draw the same
 * row from any of them. The loaded record wins because it alone knows the
 * planet count; the catalog star carries the measured colour and the confirmed
 * planets; the stub is what a generated star has. `undefined` when the id
 * names nothing at all.
 */
function systemTarget(
  world: World,
  from: UniverseVector,
  id: SystemId,
): TravelTarget | undefined {
  const system = world.system(id)
  const star = world.catalog.get(id)
  if (star !== undefined) return catalogStarTarget(world, from, star, system)
  const stub = resolveSystem(world.galaxySeed, world.catalog, id)
  if (stub === undefined) return undefined
  const position = system?.position ?? stub.position
  const distance = UV.distance(position, from)
  return {
    kind: 'system',
    address: `g:${world.galaxy}/s:${id}`,
    name: system?.name ?? stub.name,
    system: id,
    depth: 0,
    detail:
      system === undefined
        ? `${stub.spectralType} · ${stub.solarMasses.toFixed(2)} M☉`
        : `${system.star.spectralType} · ${planetCount(system)} planets`,
    distance,
    distanceText: formatReading(distance),
    landable: false,
    loaded: system !== undefined,
    provenance: 'projected',
    bodyKind: null,
    spectralType: system?.star.spectralType ?? stub.spectralType,
    colour: system?.star.colour ?? stub.colour,
    radius: system?.star.radius ?? 0,
    semiMajorAxis: 0,
    children: system === undefined ? 0 : planetCount(system),
    parent: null,
  }
}

/**
 * Rows for the addresses a caller already holds.
 *
 * The third question a listing can ask, after "what is near me" and "what is
 * called this": *these ones, as rows*. A fuzzy index over names answers with
 * addresses and nothing else — an index that carried the rows would be a copy
 * of the survey that goes stale as the camera moves — so the panel that owns
 * the index hands the addresses back here and gets the same rows the survey
 * draws, with distances measured from the same eye.
 *
 * Anything `resolveDestination` accepts is accepted: `SOL`, `s:SOL/b:2`, the
 * full `g:` form, and `b:2` relative to `currentSystem`. An address that names
 * nothing is skipped rather than thrown, because one bad entry in a list of
 * forty should cost that entry and not the listing. A body row needs its
 * system generated — a body has no record before that — so a body of an
 * unloaded system is skipped too.
 */
export function targetsFor(
  world: World,
  from: UniverseVector,
  addresses: readonly string[],
  currentSystem: SystemId | null = null,
): readonly TravelTarget[] {
  const time = world.clock.time
  const rows: TravelTarget[] = []
  for (const text of addresses) {
    let destination: TravelDestination
    try {
      destination = resolveDestination(text, world.galaxy, currentSystem)
    } catch {
      continue
    }
    if (destination.kind === 'system') {
      const row = systemTarget(world, from, destination.system)
      if (row !== undefined) rows.push(row)
      continue
    }
    const system = world.system(destination.system)
    if (system === undefined || destination.address.kind !== 'body') continue
    const body = findBody(system, destination.address.body)
    if (body === undefined) continue
    rows.push(bodyTarget(world, from, time, system, body))
  }
  return rows
}

/** One string a place can be found by, and the address it belongs to. */
export interface SearchEntry {
  readonly address: string
  readonly text: string
}

/**
 * Every name the world can be searched by, for a caller building an index.
 *
 * The catalog's own `search` is exact-then-prefix-then-substring over
 * normalized keys, which is right for a console and short of what a search box
 * wants: a typo, two words out of order, or a planet's name. Ranking those is
 * the job of a fuzzy matcher, and a matcher wants a flat list of strings. This
 * is that list — every designation of every catalog star, the sky's included,
 * and the name of every body in every loaded system — each paired with the
 * address the match should open. The matcher never sees the world; the world
 * never sees the matcher.
 *
 * Bodies only from loaded systems, because a body has no name before its
 * system is generated. That is a real limit and `searchIndexVersion` says
 * when it moves.
 */
export function searchEntries(world: World): readonly SearchEntry[] {
  const entries: SearchEntry[] = []
  for (const star of world.catalog.stars) {
    const address = `g:${world.galaxy}/s:${star.id}`
    const seen = new Set<string>()
    for (const designation of star.designations) {
      if (seen.has(designation.text)) continue
      seen.add(designation.text)
      entries.push({ address, text: designation.text })
    }
    if (!seen.has(star.id)) entries.push({ address, text: star.id })
  }
  for (const system of world.loadedSystems()) {
    if (world.catalog.get(system.id) === undefined) {
      // A generated star has no designation but its id; without this row a
      // system flown to by address could not be found again by the same
      // string it was reached by.
      entries.push({
        address: `g:${world.galaxy}/s:${system.id}`,
        text: system.name,
      })
    }
    for (const body of walkBodies(system))
      entries.push({ address: formatAddress(body.address), text: body.name })
  }
  return entries
}

/**
 * A key that changes exactly when `searchEntries` would.
 *
 * The catalog is a value and never changes under a running world; the loaded
 * set does, every time the camera crosses into a system. Building a 24,000
 * string index on every poll is the cost this avoids, and comparing the two
 * lists to find out whether to rebuild costs about as much as rebuilding.
 */
export function searchIndexVersion(world: World): string {
  const loaded = world
    .loadedSystems()
    .map((system) => system.id as string)
    .sort()
  return `${world.catalog.version}|${loaded.join(',')}`
}

/** The projection of a catalog star onto a row, loaded or not. */
function catalogStarTarget(
  world: World,
  from: UniverseVector,
  star: CatalogStar,
  system: StarSystem | undefined,
): TravelTarget {
  const position = system?.position ?? star.position
  const distance = UV.distance(position, from)
  return {
    kind: 'system' as const,
    address: `g:${world.galaxy}/s:${star.id}`,
    name: star.designations[0]?.text ?? star.id,
    system: star.id,
    depth: 0,
    /*
     * `formatSpectralType`, not the object.
     *
     * `CatalogStar.spectralType` is the *parsed* type — a record of class,
     * subclass and luminosity — and interpolating it wrote `[object Object]`
     * into every search result for a star that was not loaded, which is most
     * of them. The loaded branch reads `system.star.spectralType`, which is
     * the string, and the two looked identical in the source.
     */
    detail:
      system === undefined
        ? `${formatSpectralType(star.spectralType)} · ${star.physical.solarMasses.toFixed(2)} M☉`
        : `${system.star.spectralType} · ${planetCount(system)} planets`,
    distance,
    distanceText: formatReading(distance),
    landable: false,
    loaded: system !== undefined,
    // Everything the catalog holds is a star somebody has observed. That is
    // what being in it means.
    provenance: 'observed' as const,
    bodyKind: null,
    spectralType: formatSpectralType(star.spectralType),
    colour: system?.star.colour ?? star.physical.colour,
    radius: system?.star.radius ?? 0,
    semiMajorAxis: 0,
    children: system === undefined ? star.planets.length : planetCount(system),
    parent: null,
  }
}

/**
 * Search the whole catalog, as rows a listing can render.
 *
 * The other half of the split `travelTargets` could not make. That function is
 * a *survey*: it sweeps stars within a radius, which cannot run per keystroke
 * and cannot see past its own horizon — so a search box filtering its result
 * was a search of a 16 light-year bubble against a 150 light-year catalog, and
 * a star 90 light years out was not merely hard to find but unexpressible.
 *
 * `catalog.search` is where the index and the "index it, never scan" contract
 * already live; this is the projection onto a row, which is this file's job.
 * The catalog is an argument, exactly like `resolveSystem` — never ambient.
 */
export function searchTargets(
  world: World,
  from: UniverseVector,
  text: string,
  limit = 20,
): readonly TravelTarget[] {
  const loaded = new Map<SystemId, StarSystem>(
    world.loadedSystems().map((s) => [s.id, s]),
  )
  return world.catalog
    .search(text, limit)
    .map((star) => catalogStarTarget(world, from, star, loaded.get(star.id)))
}

function describeBody(body: Body): string {
  /*
   * `formatReading`, which picks the unit, rather than kilometers always.
   *
   * Sol carries sixty-six asteroids and comets and most of them are under a
   * kilometer across, so a fixed `/1000` rounded every one of them to `0 km` —
   * Apophis, Bennu, Ryugu and Itokawa each described as a body with no size, in
   * the one string that is supposed to tell two rows apart. Apophis reads
   * `225 m` now and Earth still reads `6,378 km`.
   */
  const radius = formatReading(body.radius)
  // Moons orbit at a few hundred thousand kilometers, which the AU form renders
  // as "0.003 AU" — technically right, useless for telling two moons apart.
  // Planets are the other way round.
  const orbit =
    body.kind === 'moon'
      ? `${(body.elements.semiMajorAxis / 1000).toFixed(0)} km`
      : `${(body.elements.semiMajorAxis / AU).toFixed(3)} AU`
  return `${body.kind} · ${radius} · ${orbit}`
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
 * listing shows (`s:SOL/b:2`), a bare catalog designation (`HIP71683`) and a
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
 * One radius up, so the center sits two radii away and the body subtends
 * 2·asin(1/2) = 60° — just inside the 65° field of view the client uses. A
 * quarter of a radius was the first guess and it is wrong in a way you only see
 * on screen: the body subtends 106° and fills the frame edge to edge, so
 * arriving somewhere new looks like a flat colored wall rather than a planet.
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
  // frame transition that follows is a real behavior worth being able to watch.
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
