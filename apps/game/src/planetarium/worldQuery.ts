import type { BodyKind, SpectralClass, WorldQuery } from '@inertialref/universe'

/*
 * The catalog dialog's vocabulary, in a `.ts` because its neighbors are `.tsx`.
 *
 * `react/no-multi-comp` is an error here and a `.tsx` that exports anything but
 * components is a file Fast Refresh gives up on — which in this app means a
 * full reload, a rebuilt `WebGPURenderer` and a lost camera. Same rule as
 * `surface.ts` and `kinds.ts`, applied to this dialog's own words.
 */

/** A star class a reader might filter by, with what it looks like. */
export interface StarClassOption {
  readonly id: SpectralClass
  readonly label: string
  readonly detail: string
}

/**
 * The seven classes of the main sequence, hottest first.
 *
 * The order is the spectral sequence itself rather than alphabetical or by
 * population: it is the one order every reader of a star chart already knows,
 * and it puts the two classes anybody actually searches for — G, because it is
 * the Sun, and M, because it is three quarters of the sky — at opposite ends
 * where they are easy to hit.
 *
 * The degenerate and exotic classes the catalog also holds (D, W, C, S, L, T,
 * Y) are deliberately absent. They are a handful of rows against seven
 * thousand, and a chip that returns nothing on almost every sweep is a control
 * that teaches a reader the filter is broken.
 */
export const STAR_CLASSES: readonly StarClassOption[] = [
  { id: 'O', label: 'O', detail: 'Blue supergiants — the rarest and hottest' },
  { id: 'B', label: 'B', detail: 'Blue-white, hot and short-lived' },
  { id: 'A', label: 'A', detail: 'White — Sirius and Vega' },
  { id: 'F', label: 'F', detail: 'Yellow-white, a little hotter than the Sun' },
  { id: 'G', label: 'G', detail: 'Yellow dwarfs — the Sun is one' },
  { id: 'K', label: 'K', detail: 'Orange dwarfs, long-lived and quiet' },
  { id: 'M', label: 'M', detail: 'Red dwarfs — three quarters of every sky' },
]

/** A body class the query can return, with the word a reader would use. */
export interface WorldKindOption {
  readonly id: BodyKind
  readonly label: string
}

/**
 * The classes worth filtering to, and the rubble is not among them.
 *
 * Asteroids and comets are most of what a system holds by count and almost
 * none of what anybody searches a volume for — the navigator's own chips exist
 * mainly to turn them off. A search that returned nine hundred rocks before
 * the first planet would be answering a question nobody asked.
 */
export const WORLD_KINDS: readonly WorldKindOption[] = [
  { id: 'rocky', label: 'Rocky' },
  { id: 'ice', label: 'Ice' },
  { id: 'gas-giant', label: 'Gas giant' },
  { id: 'ice-giant', label: 'Ice giant' },
  { id: 'moon', label: 'Moon' },
  { id: 'dwarf', label: 'Dwarf' },
]

/** A yes/no clause, as the three states a control can be in. */
export interface WorldFlagOption {
  readonly id: 'atmosphere' | 'sea' | 'rings' | 'habitable' | 'landable'
  readonly label: string
  readonly detail: string
}

/**
 * The five yes/no clauses, each named for what the record actually says.
 *
 * "Has a sea" rather than "has water": the generator's answer is whether the
 * ground temperature admits a *liquid*, and on a cold world that liquid is
 * methane. Labelling it water would be the interface inventing a fact the
 * simulation is careful not to claim ([ADR-0026](../../../../docs/adr/0026-the-liquid.md)).
 */
export const WORLD_FLAGS: readonly WorldFlagOption[] = [
  {
    id: 'atmosphere',
    label: 'Atmosphere',
    detail: 'An envelope thick enough to have a scale height',
  },
  {
    id: 'sea',
    label: 'Sea',
    detail: 'Ground warm enough for a liquid — not always water',
  },
  { id: 'rings', label: 'Rings', detail: 'A ring system around the body' },
  {
    id: 'habitable',
    label: 'Habitable zone',
    detail: 'Rocky, with air, at an insolation that admits liquid water',
  },
  {
    id: 'landable',
    label: 'Landable',
    detail: 'Solid ground, and big enough to be a place',
  },
]

/** How far a sweep reaches. The navigator's own radii, plus the catalog's edge. */
export const SEARCH_RADII = ['10', '25', '50', '150'] as const

/**
 * A short sentence saying what a query is asking for.
 *
 * The dialog's own summary of itself, and the string a result count is read
 * beside: "84 of 1,378 systems" says nothing without it. Written from the
 * query rather than from the controls, so it cannot drift from what was
 * actually asked.
 */
export function describeQuery(query: WorldQuery): string {
  const parts: string[] = []
  const kinds = query.kinds ?? []
  parts.push(
    kinds.length === 0
      ? 'Any body'
      : kinds
          .map(
            (kind) => WORLD_KINDS.find((one) => one.id === kind)?.label ?? kind,
          )
          .join(', '),
  )
  for (const flag of WORLD_FLAGS) {
    const value = query[flag.id]
    if (value === undefined) continue
    parts.push(
      value
        ? `with ${flag.label.toLowerCase()}`
        : `no ${flag.label.toLowerCase()}`,
    )
  }
  if (query.moons !== undefined)
    parts.push(`${query.moons}+ ${query.moons === 1 ? 'moon' : 'moons'}`)
  const classes = query.starClasses ?? []
  if (classes.length > 0) parts.push(`around ${classes.join('/')} stars`)
  return parts.join(' · ')
}
