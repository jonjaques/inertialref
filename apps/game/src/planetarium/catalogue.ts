import { AU, LIGHT_YEAR } from '@inertialref/shared'
import { parseAddress, systemOf } from '@inertialref/universe'
import type { TravelTarget } from '@inertialref/devtools'
import { acceptsRow } from './kinds.ts'

/*
 * Turning a flat survey into something a person can navigate.
 *
 * `harness.targets()` returns one long list: every system within the radius,
 * each followed by its bodies if it is loaded, in the order `walkBodies`
 * issues. That is the right shape for a console listing and the wrong shape for
 * a panel, for two reasons that only showed up once Sol grew from eight bodies
 * to a hundred and twenty-nine.
 *
 * **It cannot be folded.** A system's rows are indented by `depth` and nothing
 * marks where one system's run ends, so the whole of Sol sits between the
 * observer and the next star along. Scrolling past a hundred and twenty-nine
 * rows to reach Proxima is not browsing.
 *
 * **Issue order is not an order.** `b:2` is the third body ever *issued* in a
 * system, not the third one out (ADR-0009), and the two agree in Sol by
 * historical accident. In a cataloged system the letters are discovery order,
 * so `b:0` is routinely the innermost or the outermost or neither, and a
 * listing in that order reads as a shuffled deck. `orbitalOrder` exists in
 * `universe` for exactly this and says in its own docstring that sorting is a
 * *display* decision — so it is made here, in the display, over a tree the
 * rows' own `parent` field describes.
 *
 * Both halves are pure functions over rows, which is what lets them be tested
 * without a world, a renderer or a React tree.
 */

/** One system and the bodies under it, ready to draw. */
export interface CatalogueGroup {
  /** The star's own row. Always present — a group is a system. */
  readonly system: TravelTarget
  /** Its bodies, filtered and in orbital order, moons under their planets. */
  readonly bodies: readonly TravelTarget[]
  /** How many it has before the filter, so a chip can say what it is hiding. */
  readonly total: number
}

/**
 * Group a survey by system, sort each system's bodies into orbital order, and
 * drop what the chosen classes exclude.
 *
 * A row that arrives before any system row is dropped rather than orphaned.
 * That cannot happen against the current survey — it emits the star first — but
 * a listing that silently reparented a stray body under whichever system came
 * before it would be wrong in a way nobody could see.
 */
export function groupBySystem(
  rows: readonly TravelTarget[],
  chosen: readonly string[],
): readonly CatalogueGroup[] {
  const groups: {
    system: TravelTarget
    bodies: TravelTarget[]
    all: TravelTarget[]
    total: number
  }[] = []
  let current: (typeof groups)[number] | null = null

  for (const row of rows) {
    if (row.kind === 'system') {
      current = { system: row, bodies: [], all: [], total: 0 }
      groups.push(current)
      continue
    }
    if (current === null) continue
    current.total += 1
    current.all.push(row)
    if (acceptsRow(row, chosen)) current.bodies.push(row)
  }

  return groups
    .filter(
      (group) =>
        // A star whose class is filtered out still appears when something under
        // it survived: hiding Sol because "Stars" is off would take Earth with
        // it, which is a filter removing the thing it was not asked about.
        acceptsRow(group.system, chosen) || group.bodies.length > 0,
    )
    .map((group) => ({
      system: group.system,
      // The unfiltered run as well, so a body whose parent the filter removed
      // can still be sorted by where its parent was. See `orbitalOrder`.
      bodies: orbitalOrder(group.bodies, group.all),
      total: group.total,
    }))
}

/**
 * Depth-first by semi-major axis: each level sorted outward, moons under the
 * planet they go round.
 *
 * Built from `parent` rather than from the address string, because parsing an
 * address to find its prefix is re-implementing `parseAddress` in a component —
 * and the survey already answers the question.
 *
 * **A body whose parent the filter removed is promoted, not dropped, and it is
 * sorted by where its parent was.** Losing Io because "Planets" is off would be
 * a filter deciding what a *moon* is. But a promoted moon sorted by its own
 * semi-major axis is worse than either: turning off "Asteroids" in Sol left
 * Dimorphos, Selam, Dactyl and six more sitting *above Mercury*, because a moon
 * of an asteroid orbits at a kilometre or two and the planets orbit at tenths
 * of an AU. Nine rocks nobody asked for, at the top of the list, measured in
 * kilometres in a column of AU.
 *
 * So the sort key for a promoted body is its parent's axis, taken from `all` —
 * the run before the filter. It lands where Didymos would have been, which is
 * the only place in the list that means anything.
 */
export function orbitalOrder(
  bodies: readonly TravelTarget[],
  /** The same system's bodies before the filter. Defaults to `bodies`. */
  all: readonly TravelTarget[] = bodies,
): readonly TravelTarget[] {
  // A 50 ly sweep is fourteen hundred systems and all but one of them is an
  // unloaded stub with no bodies at all, so the empty walk — a Set, two Maps
  // and two arrays each — is most of what this function is asked to do.
  if (bodies.length === 0) return bodies
  const present = new Set(bodies.map((body) => body.address))
  const axisOf = new Map(all.map((body) => [body.address, body.semiMajorAxis]))
  const children = new Map<string, TravelTarget[]>()
  const roots: TravelTarget[] = []
  const key = new Map<string, number>()

  for (const body of bodies) {
    const parent = body.parent
    if (parent === null || !present.has(parent)) {
      roots.push(body)
      key.set(
        body.address,
        (parent === null ? undefined : axisOf.get(parent)) ??
          body.semiMajorAxis,
      )
      continue
    }
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [body])
    else siblings.push(body)
  }

  const outward = (a: TravelTarget, b: TravelTarget): number =>
    (key.get(a.address) ?? a.semiMajorAxis) -
    (key.get(b.address) ?? b.semiMajorAxis)
  const ordered: TravelTarget[] = []
  const walk = (level: TravelTarget[]): void => {
    for (const body of [...level].sort(outward)) {
      ordered.push(body)
      walk(children.get(body.address) ?? [])
    }
  }
  walk(roots)
  return ordered
}

/**
 * Which system an address belongs to, or null if it names none.
 *
 * A property of the string and of nothing else, so it is asked of the address
 * rather than of the rows on screen: the panel wants "where is the camera",
 * and scanning the filtered listing for a match answers "where is the camera,
 * among the classes you have left switched on" — which goes null the moment a
 * reader turns off the chip for the thing they are looking at.
 */
export function systemOfAddress(address: string | null): string | null {
  if (address === null) return null
  try {
    return systemOf(parseAddress(address))
  } catch {
    // A bare designation the survey has not resolved yet. Not an error here —
    // it simply is not an address, so it names no system.
    return null
  }
}

/**
 * How deep a row sits under its system, for the indent.
 *
 * `row.depth` is the address's own depth and is 1 for a planet and 2 for a
 * moon, which is what the indent wants — but a row promoted to the top level by
 * the note in `orbitalOrder` would keep an indent for a parent that is not on
 * screen. So the indent is measured against what is actually drawn.
 */
export function indentOf(
  row: TravelTarget,
  visible: ReadonlySet<string>,
): number {
  if (row.parent === null) return 0
  return visible.has(row.parent) ? row.depth : 1
}

/**
 * The reading at the end of a row, in the unit that explains its position.
 *
 * A system's is how far it is from the eye, because the survey is sorted by
 * that. A body's is its semi-major axis, because the tree under a star is
 * sorted outward — and a column of camera distances under a heading sorted by
 * orbit is two orders in one list, which the reader has to disentangle before
 * either of them means anything.
 *
 * The unit switches at the moon boundary rather than by magnitude.
 * `formatDistance` renders Luna's 384,400 km as "0.003 AU", which is correct
 * and useless: every moon in the system comes out as 0.00-something and they
 * are indistinguishable from each other.
 */
export function measureOf(row: TravelTarget): string {
  if (row.kind === 'system') return row.distanceText
  if (row.depth > 1) {
    const km = Math.round(row.semiMajorAxis / 1000)
    return `${String(km).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} km`
  }
  const au = row.semiMajorAxis / AU
  return `${au.toFixed(au >= 100 ? 0 : 2)} AU`
}

/** The nearest systems, with the distance rail's own scale already applied. */
export interface Neighbour {
  readonly address: string
  readonly name: string
  readonly lightYears: number
  /** Where it sits on the rail, 0 at the observer and 1 at the survey edge. */
  readonly at: number
  readonly colour: TravelTarget['colour']
  readonly loaded: boolean
}

/**
 * The stars near the eye, placed on a rail.
 *
 * **The scale is a square root, not linear and not logarithmic.** Linear piles
 * the whole neighborhood into the left tenth of a 16 ly rail, because the
 * survey's volume grows as r³ and so most of what it finds is near the edge.
 * Logarithmic is worse in the other direction: the observer is at zero, log 0
 * is not a number, and everything inside a light year of the camera lands off
 * the left end. √r is the compromise a star chart uses — it spreads the near
 * half without pretending the far half is not there.
 *
 * **A star outside the radius is dropped, not clamped.** `travelTargets` unions
 * the sweep with every *loaded* system whatever its distance, so a system flown
 * to and come back from is in the rows at 8.6 ly under a 5 ly sweep — and
 * clamped it lands exactly on the "5 ly" tick, indistinguishable from a star
 * that really is there, under a caption reading "n within 5 ly". Position on
 * this rail is the whole claim it makes.
 *
 * **And the nearest `RAIL_LIMIT` of them.** A 50 ly sweep finds around fourteen
 * hundred systems; drawn, that is fourteen hundred absolutely positioned buttons
 * hundreds deep per pixel in a 20 px band, which is not a picture of anything.
 */
const RAIL_LIMIT = 24

export function neighbours(
  rows: readonly TravelTarget[],
  radiusLightYears: number,
): readonly Neighbour[] {
  const limit = Math.max(1, radiusLightYears)
  return rows
    .filter((row) => row.kind === 'system')
    .map((row) => {
      const lightYears = row.distance / LIGHT_YEAR
      return {
        address: row.address,
        name: row.name,
        lightYears,
        at: Math.sqrt(lightYears / limit),
        colour: row.colour,
        loaded: row.loaded,
      }
    })
    .filter((one) => one.at <= 1)
    .sort((a, b) => a.lightYears - b.lightYears)
    .slice(0, RAIL_LIMIT)
}
