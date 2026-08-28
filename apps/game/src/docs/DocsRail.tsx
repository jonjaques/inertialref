import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import type { DocManifest } from './content.ts'
import { opensEveryGroup, wingFor } from './docsNav.ts'
import { DocsRailGroup } from './DocsRailGroup.tsx'
import { DocsWingLink } from './DocsWingLink.tsx'

/** How much of the rail stays visible past the entry it scrolls to. */
const MARGIN = 64

/**
 * The contents: five wings, and the pages of the one being read.
 *
 * **Only one wing is ever expanded**, and that is the decision the whole rail
 * rests on. There are nine hundred pages here and a tree that showed all of
 * them would be a file browser; five names and twenty-seven pages is a table of
 * contents. Moving between wings is a click on a name that is always visible,
 * which is the same trade a book makes between its contents page and its
 * chapter openers.
 *
 * The groups inside a wing follow `opensEveryGroup`: open everywhere the wing
 * is short enough to read at once, and only around the current page in the
 * reference, which is eight hundred and twenty exports across twelve
 * packages.
 */
export function DocsRail({
  manifest,
  route,
  open,
  onClose,
}: {
  manifest: DocManifest | null
  route: string
  open: boolean
  onClose: () => void
}) {
  const wing = manifest === null ? undefined : wingFor(manifest, route)
  const box = useRef<HTMLElement | null>(null)

  /*
   * Bring the current page into the rail, without moving the page.
   *
   * The reference's rail is twelve collapsed packages and the one being read;
   * on `spatial` the open group starts below the fold, so a reader arriving
   * from a search result or a pasted link sees a list of packages with no mark
   * on it and no way to tell where they are.
   *
   * By hand rather than `scrollIntoView`, and that is the whole reason this is
   * eight lines. `scrollIntoView` scrolls *every* scrollable ancestor, so on a
   * wide screen it would also scroll the article — the rail is a sticky column
   * inside the same box the document is in, and centring a rail entry would
   * throw the reader four paragraphs down the page they just opened.
   */
  useEffect(() => {
    const rail = box.current
    const current = rail?.querySelector<HTMLElement>('[aria-current="page"]')
    if (rail === null || current === undefined || current === null) return
    /* Rectangles rather than `offsetTop`: the rail is `position: sticky`, so it
       is its own descendants' offset parent on a wide screen and something
       else's inside the drawer, and the two readings differ by the whole
       masthead. */
    const top =
      current.getBoundingClientRect().top -
      rail.getBoundingClientRect().top +
      rail.scrollTop
    const bottom = top + current.offsetHeight
    if (top < rail.scrollTop) rail.scrollTop = Math.max(0, top - MARGIN)
    else if (bottom > rail.scrollTop + rail.clientHeight)
      rail.scrollTop = bottom - rail.clientHeight + MARGIN
  }, [route, manifest])

  return (
    <nav
      ref={box}
      aria-label="Documentation contents"
      /* Two layouts from one tree. On a wide screen it is a sticky column in
         the page's grid; below `lg` it is a sheet the bar opens over the
         article, because a 15 rem column beside a 15 rem article is two
         columns of nothing. `index.css` carries both. */
      className={`doc-rail ${open ? 'doc-rail-open' : ''}`}
    >
      <div className="doc-rail-inner">
        <div className="flex items-center justify-between lg:hidden">
          <span className="type-label text-slate-400">Contents</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the contents"
            className={`flex size-7 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-sky-200 ${FOCUS_RING}`}
          >
            <X className="size-4" />
          </button>
        </div>

        <ul className="flex flex-col gap-px">
          {(manifest?.wings ?? []).map((entry) => (
            <DocsWingLink
              key={entry.id}
              wing={entry}
              to={entry.home}
              current={entry.id === wing?.id}
            />
          ))}
        </ul>

        {wing !== undefined && manifest !== null && (
          <div className="mt-5 flex flex-col gap-5 border-t border-slate-800/80 pt-4">
            {wing.groups.map((group, position) => (
              <DocsRailGroup
                key={group.label ?? group.head ?? String(position)}
                manifest={manifest}
                group={group}
                route={route}
                alwaysOpen={opensEveryGroup(wing)}
              />
            ))}
          </div>
        )}
      </div>
    </nav>
  )
}
