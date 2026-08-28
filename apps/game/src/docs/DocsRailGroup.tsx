import { ChevronRight } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import type { DocGroup, DocManifest } from './content.ts'
import { DocsRailLink } from './DocsRailLink.tsx'

/**
 * A band of the rail: an optional heading, an optional page it is named after,
 * and its pages.
 *
 * `<details>` rather than a boolean and a click handler, and the reason is the
 * `open` attribute below: the group holding the current page has to be open on
 * arrival, including on a cold load of a pasted link, and it has to stay open
 * when the reader collapses a different one. Held in React that is a piece of
 * state seeded from the route and then diverging from it; as an attribute it is
 * a default the element owns and the reader overrides, which is exactly the
 * behaviour wanted.
 *
 * `key`ed on the group in `DocsRail`, so moving to another package re-mounts
 * these and the new group's default applies. Without the remount, `open` is a
 * defaulted attribute React will not touch again and the reference's rail would
 * hold the first package a reader ever opened.
 */
export function DocsRailGroup({
  manifest,
  group,
  route,
  alwaysOpen,
}: {
  manifest: DocManifest
  group: DocGroup
  route: string
  alwaysOpen: boolean
}) {
  const holdsCurrent = group.head === route || group.pages.includes(route)
  const pages = group.pages.map((page) => (
    <DocsRailLink
      key={page}
      to={page}
      label={manifest.pages[page]?.label ?? page}
      current={page === route}
    />
  ))

  if (group.label === null) return <ul className="flex flex-col">{pages}</ul>

  return (
    <details open={alwaysOpen || holdsCurrent} className="doc-rail-group">
      <summary
        className={`type-label flex cursor-pointer list-none items-center gap-1 rounded py-0.5 text-slate-400 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
      >
        <ChevronRight
          aria-hidden
          className="doc-rail-chevron size-3 shrink-0 text-slate-600 transition-transform"
        />
        {group.label}
      </summary>
      <ul className="mt-1 flex flex-col">
        {/* The page the group is named after — a package, the bible's own
            contents — heads its own list rather than sitting inside it. It is
            what the group is, not one of the things in it. */}
        {group.head !== null && (
          <DocsRailLink
            to={group.head}
            label={manifest.pages[group.head]?.label ?? group.head}
            current={group.head === route}
            head
          />
        )}
        {pages}
      </ul>
    </details>
  )
}
