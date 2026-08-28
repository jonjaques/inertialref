import type { DocGroup, DocManifest, DocWing } from './content.ts'
import { DOCS } from '../pages/paths.ts'

/*
 * Where a route sits in the documentation, as arithmetic over the manifest.
 *
 * Every one of these is a pure function of `(manifest, route)`, which is what
 * lets the rail, the breadcrumb, the masthead and the previous/next pair all
 * agree without any of them holding state or asking each other. The alternative
 * — a context carrying "the current wing" — is a second source of truth for
 * something the URL already says, and it goes wrong in the one case that
 * matters: a link pasted into a fresh tab, where nothing has navigated yet.
 */

/** The wing a route belongs to, or the first wing for `/docs` itself. */
export function wingFor(
  manifest: DocManifest,
  route: string,
): DocWing | undefined {
  const entry = manifest.pages[route]
  if (entry !== undefined)
    return manifest.wings.find((wing) => wing.id === entry.wing)
  /*
   * A route with no page — a typo, or a reference member that has been renamed
   * since the link was written. The reference is the honest guess for anything
   * under `/docs/api`, and the first wing for everything else, so the masthead
   * still has a framing to draw while the article says what went wrong.
   */
  const fallback = route.startsWith(`${DOCS}/api`) ? 'api' : undefined
  return (
    manifest.wings.find((wing) => wing.id === fallback) ?? manifest.wings[0]
  )
}

/** The group inside a wing that lists a route. */
export function groupFor(
  wing: DocWing | undefined,
  route: string,
): DocGroup | undefined {
  return wing?.groups.find(
    (group) => group.head === route || group.pages.includes(route),
  )
}

/**
 * Whether a wing's groups are all open at once.
 *
 * The four prose wings are twenty-seven pages at their largest, which is a rail
 * you can read; the reference is eight hundred and twenty, which is not. So
 * the rule is a count rather than a flag on the wing: everything is open until
 * the wing is too long to be, and then only the group being read is.
 *
 * Forty is where a rail stops being scannable at this type size and starts
 * being a list to scroll — measured against `concepts`, which is twenty-seven
 * and comfortable, and against `api`, which is not close.
 */
const OPEN_ALL_BELOW = 40

export function opensEveryGroup(wing: DocWing): boolean {
  return (
    wing.groups.reduce((total, group) => total + group.pages.length, 0) <
    OPEN_ALL_BELOW
  )
}

/** Every page of a wing, in reading order, heads included. */
export function pagesOf(wing: DocWing): string[] {
  return wing.groups.flatMap((group) =>
    group.head === null ? [...group.pages] : [group.head, ...group.pages],
  )
}

export interface Neighbours {
  readonly previous: string | null
  readonly next: string | null
}

/**
 * The pages either side of this one, within its wing.
 *
 * Within, not across: the wings are four different reasons to be reading, and
 * running off the end of the design bible into the agent handbook is not the
 * next thing anybody wanted. The end of a wing is the end of a wing, and the
 * rail is how you get to the next one.
 */
export function neighbours(manifest: DocManifest, route: string): Neighbours {
  const wing = wingFor(manifest, route)
  if (wing === undefined) return { previous: null, next: null }
  const pages = pagesOf(wing)
  const at = pages.indexOf(route)
  if (at === -1) return { previous: null, next: null }
  return {
    previous: at > 0 ? (pages[at - 1] ?? null) : null,
    next: at < pages.length - 1 ? (pages[at + 1] ?? null) : null,
  }
}

/**
 * The route the reference member of an API page belongs under.
 *
 * `/docs/api/spatial/Sector` is read inside `spatial`, and the breadcrumb has
 * to say so — but the package is a `head` rather than a member of any group's
 * page list, so `groupFor` finds the group and not the page. This is the one
 * place that difference is visible.
 */
export function parentOf(
  wing: DocWing | undefined,
  route: string,
): string | null {
  const group = groupFor(wing, route)
  return group?.head === route ? null : (group?.head ?? null)
}
