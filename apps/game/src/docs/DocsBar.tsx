import { Link } from 'react-router'
import { ChevronRight, PanelLeft } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import { Github } from '../icons/index.tsx'
import { DOCS } from '../pages/paths.ts'
import type { DocManifest, DocPage } from './content.ts'
import { parentOf, wingFor } from './docsNav.ts'
import { DocsSearch } from './DocsSearch.tsx'

/**
 * Where you are, what you are looking for, and where the words are kept.
 *
 * Sticky at the top of the scroller, which puts it directly under the horizon
 * once the masthead has scrolled past — so the sky above it is never covered
 * and this is the top edge of the reading plate wherever the page is scrolled
 * to. It carries its own hairline for exactly that reason: at rest it is the
 * rule under the masthead, and pinned it is the rule under the sky.
 *
 * Three things, in the order they are asked for. The breadcrumb answers *where
 * am I* — the same first question the IR menu answers in every other mode, in
 * the same left-to-right order. Search answers *where is the thing I came for*.
 * The source link answers *where do I change this*, which on an open-source
 * project is the question the second-most people have.
 */
export function DocsBar({
  manifest,
  route,
  page,
  railOpen,
  onRail,
}: {
  manifest: DocManifest | null
  route: string
  page: DocPage | null
  railOpen: boolean
  onRail: () => void
}) {
  const wing = manifest === null ? undefined : wingFor(manifest, route)
  const parent = parentOf(wing, route)
  const wingHome = wing?.home ?? DOCS

  return (
    <div className="doc-bar sticky top-0 z-30 border-y border-slate-800/80 bg-slate-950/95 backdrop-blur">
      <div className="doc-measure flex h-12 items-center gap-3">
        {/* The rail is a sheet below 900px — the same breakpoint and the same
            reason as `dock/CompactDock.tsx`, where a 15 rem column is the whole
            width of the phone it would be drawn on. */}
        <button
          type="button"
          onClick={onRail}
          aria-expanded={railOpen}
          aria-label="Contents"
          title="Contents"
          className={`-ml-1 flex size-8 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-sky-200 lg:hidden ${FOCUS_RING} ${
            railOpen ? 'bg-sky-500/15 text-sky-200' : ''
          }`}
        >
          <PanelLeft className="size-4" />
        </button>

        <nav
          aria-label="Breadcrumb"
          className="type-ui flex min-w-0 flex-1 items-center gap-1.5 text-slate-400"
        >
          {route !== DOCS && (
            <>
              <Link
                to={DOCS}
                className={`shrink-0 rounded transition-colors hover:text-sky-200 ${FOCUS_RING}`}
              >
                Docs
              </Link>
              <ChevronRight
                aria-hidden
                className="size-3 shrink-0 text-slate-700"
              />
            </>
          )}
          {/* Shown even standing on the wing's first page, because four of the
              five wings have no landing page and a breadcrumb of "Docs" then
              the title leaves out the one word that says which wing this is.
              Not shown on the reference's own index, which is the one page
              whose title *is* the wing's name. */}
          {wing !== undefined && route !== DOCS && route !== wing.home && (
            <>
              <Link
                to={wingHome}
                className={`shrink-0 rounded transition-colors hover:text-sky-200 ${FOCUS_RING}`}
              >
                {wing.label}
              </Link>
              <ChevronRight
                aria-hidden
                className="size-3 shrink-0 text-slate-700"
              />
            </>
          )}
          {parent !== null && manifest !== null && (
            <>
              <Link
                to={parent}
                className={`hidden shrink-0 rounded transition-colors hover:text-sky-200 sm:block ${FOCUS_RING}`}
              >
                {manifest.pages[parent]?.label ?? parent}
              </Link>
              <ChevronRight
                aria-hidden
                className="hidden size-3 shrink-0 text-slate-700 sm:block"
              />
            </>
          )}
          {/* The page itself is not a link to where you already are. It
              truncates rather than wrapping, because this bar is one line high
              and an ADR's full title is a paragraph. */}
          <span
            aria-current="page"
            className="min-w-0 truncate text-slate-200"
            title={page?.title ?? ''}
          >
            {page?.title ?? ''}
          </span>
        </nav>

        <DocsSearch wings={manifest?.wings ?? []} />

        {page?.source !== null && page?.source !== undefined && (
          <a
            href={page.source}
            target="_blank"
            rel="noreferrer"
            title="This page is a markdown file. Edit it on GitHub."
            className={`hidden size-8 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-sky-200 sm:flex ${FOCUS_RING}`}
          >
            <Github aria-hidden className="size-3.5" />
            <span className="sr-only">Edit this page on GitHub</span>
          </a>
        )}
      </div>
    </div>
  )
}
