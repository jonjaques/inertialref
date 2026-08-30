import { ArrowLeft, ArrowRight } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import type { DocManifest, DocPage } from './content.ts'
import { neighbours } from './docsNav.ts'

/**
 * The end of a page: where to go next, and where the words are kept.
 *
 * Previous and next stay inside the wing. Running off the end of the design
 * bible into the agent handbook is not the next thing anybody wanted, and a
 * pair of arrows that quietly changes the subject is worse than a pair that
 * stops — so the last page of a wing has one arrow, and the rail is how you
 * cross to another.
 *
 * The two are laid out as opposite ends of a rule rather than as cards. A card
 * here would be the largest object on a page that has just finished making an
 * argument, and what it would contain is a title that is already in the rail.
 */
export function DocFooter({
  manifest,
  route,
  page,
}: {
  manifest: DocManifest
  route: string
  page: DocPage
}) {
  const { previous, next } = neighbours(manifest, route)
  const label = (at: string): string =>
    manifest.pages[at]?.label ?? manifest.pages[at]?.title ?? at

  return (
    <footer className="mt-14 border-t border-slate-800 pt-5">
      <div className="flex items-start justify-between gap-6">
        {previous === null ? (
          <span />
        ) : (
          <a
            href={previous}
            rel="prev"
            className={`group flex max-w-[18rem] min-w-0 items-baseline gap-2 rounded text-slate-400 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
          >
            <ArrowLeft
              aria-hidden
              className="size-3.5 shrink-0 translate-y-0.5 text-slate-600 transition-colors group-hover:text-sky-300"
            />
            <span className="min-w-0">
              <span className="type-label block text-slate-400">Previous</span>
              <span className="type-ui block truncate">{label(previous)}</span>
            </span>
          </a>
        )}
        {next !== null && (
          <a
            href={next}
            rel="next"
            className={`group flex max-w-[18rem] min-w-0 items-baseline gap-2 rounded text-right text-slate-400 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
          >
            <span className="min-w-0">
              <span className="type-label block text-slate-400">Next</span>
              <span className="type-ui block truncate">{label(next)}</span>
            </span>
            <ArrowRight
              aria-hidden
              className="size-3.5 shrink-0 translate-y-0.5 text-slate-600 transition-colors group-hover:text-sky-300"
            />
          </a>
        )}
      </div>

      {page.source !== null && (
        <p className="type-micro mt-8 text-slate-400">
          This page is{' '}
          <a
            href={page.source}
            target="_blank"
            rel="noreferrer"
            className={`rounded text-slate-400 underline decoration-slate-700 transition-colors hover:text-sky-200 hover:decoration-sky-500/60 ${FOCUS_RING}`}
          >
            a markdown file in the repository
          </a>
          . Where it disagrees with the code, the code is right and the page is
          a bug.
        </p>
      )}
      {page.source === null && page.packageName !== null && (
        <p className="type-micro mt-8 text-slate-400">
          Generated from the source of{' '}
          <span className="text-slate-400">{page.packageName}</span> and its
          comments. Nothing on this page is written by hand.
        </p>
      )}
    </footer>
  )
}
