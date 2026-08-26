import { AU, LIGHT_YEAR } from '@inertialref/shared'
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
    total: number
  }[] = []
  let current: (typeof groups)[number] | null = null

  for (const row of rows) {
    if (row.kind === 'system') {
      current = { system: row, bodies: [], total: 0 }
      groups.push(current)
      continue
    }
    if (current === null) continue
    current.total += 1
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
      bodies: orbitalOrder(group.bodies),
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
 * A body whose parent is missing from this list — because the filter removed
 * the planet but kept its moons — is kept at the top level rather than dropped.
 * Losing Io because "Planets" is off is a filter deciding what a *moon* is.
 */
export function orbitalOrder(
  bodies: readonly TravelTarget[],
): readonly TravelTarget[] {
  const present = new Set(bodies.map((body) => body.address))
  const children = new Map<string, TravelTarget[]>()
  const roots: TravelTarget[] = []

  for (const body of bodies) {
    const parent = body.parent
    if (parent === null || !present.has(parent)) {
      roots.push(body)
      continue
    }
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [body])
    else siblings.push(body)
  }

  const outward = (a: TravelTarget, b: TravelTarget): number =>
    a.semiMajorAxis - b.semiMajorAxis
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
 */
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
        at: Math.sqrt(Math.min(1, lightYears / limit)),
        colour: row.colour,
        loaded: row.loaded,
      }
    })
    .sort((a, b) => a.lightYears - b.lightYears)
}
