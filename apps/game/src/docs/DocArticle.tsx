import { useEffect, useRef, type MouseEvent } from 'react'
import { useNavigate } from 'react-router'
import type { DocManifest, DocPage } from './content.ts'
import { DocsMissingError } from './content.ts'
import { DocFooter } from './DocFooter.tsx'
import { drawDiagrams } from './mermaid.ts'
import type { Loaded } from './useDocs.ts'

/**
 * The document itself.
 *
 * The body is HTML rather than a component tree, and it is the only place in
 * this application that is. `scripts/docs/build.mjs` renders every page at
 * build time — markdown through marked, listings through Shiki, links resolved
 * against the route table — so what arrives here is finished markup that needs
 * a stylesheet and two event handlers rather than a parser. The alternative is
 * shipping a markdown parser and a syntax highlighter to every reader, to
 * re-derive on each visit something that cannot change between them.
 *
 * `dangerouslySetInnerHTML` earns its name and does not apply here: this markup
 * is generated from files in this repository by this repository's own build,
 * and the only thing that can put a script in it is a commit. It is checked in
 * the same sense the bundle is.
 *
 * ## Two handlers, both delegated
 *
 * A tree with no components in it cannot carry `onClick` props, so both live on
 * the container:
 *
 *   - **links**, so a cross-reference goes through the router. Nine hundred
 *     pages of these, and a full page load on any of them rebuilds the WebGPU
 *     renderer and drops the scene behind the masthead — a documentation link
 *     costing a second of black canvas.
 *   - **copy**, on the button `highlight.mjs` emits into every listing.
 */
export function DocArticle({
  manifest,
  route,
  page,
  error,
}: {
  manifest: DocManifest | null
  route: string
  page: Loaded<DocPage>
  error: Error | null
}) {
  const navigate = useNavigate()
  const body = useRef<HTMLDivElement | null>(null)
  const html = page.value?.html ?? null

  /*
   * Diagrams, after the markup is in the DOM.
   *
   * Keyed on the HTML rather than the route so it cannot run against the
   * previous page's nodes, and `drawDiagrams` checks `isConnected` between
   * every one — nine diagrams take about a fifth of a second in a row, which is
   * long enough for a fast reader to have left.
   */
  useEffect(() => {
    const container = body.current
    if (container === null || html === null) return
    void drawDiagrams(container)
  }, [html])

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return

    const copy = target.closest('button[data-copy]')
    if (copy !== null) {
      const listing = copy.parentElement?.querySelector('pre')
      if (listing === null || listing === undefined) return
      /*
       * `navigator.clipboard` is not always there, and the write can be
       * refused. It is a secure-context API, so it is `undefined` on any
       * `http://` origin that is not `localhost` — which is the dev server
       * bound to a LAN address so a phone can reach it — and reading through
       * it there throws out of the click handler into React. Where it exists
       * the promise still rejects on a denied permission or an unfocused
       * document, and an unhandled rejection is a control that neither
       * confirms nor says why.
       *
       * The `?.` and the guard under it both read as dead to TypeScript, whose
       * DOM types declare `clipboard` non-optional. The browser disagrees, and
       * the browser is the one running this.
       */
      const write = navigator.clipboard?.writeText(listing.textContent ?? '')
      if (write === undefined) return
      void write.then(
        () => {
          // The icon turns Nominal Green for a beat. No text swap and no toast:
          // the confirmation belongs on the control that was pressed, and this
          // is the one status colour in the system that means "it is there".
          copy.setAttribute('data-copied', 'true')
          copy.setAttribute('aria-label', 'Copied')
          window.setTimeout(() => {
            copy.removeAttribute('data-copied')
            copy.setAttribute('aria-label', 'Copy this block')
          }, 1400)
        },
        () => {
          copy.setAttribute('aria-label', 'Copying is not available here')
        },
      )
      return
    }

    const link = target.closest('a')
    if (link === null) return
    /*
     * Everything same-origin goes through the router, including a bare
     * `#section` — which is the same page at a different hash and is what a
     * heading's own anchor is. Left unhandled, a fragment click updates
     * `window.location` without telling the router, so `useLocation().hash`
     * goes stale and the next real navigation scrolls to the wrong place.
     *
     * A modified click is the browser's: a new tab, a new window, a download,
     * a saved link. Intercepting those is how a single-page application breaks
     * middle-click, and there is no reason to.
     */
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return
    const url = new URL(link.href, window.location.href)
    if (url.origin !== window.location.origin) return
    event.preventDefault()
    void navigate(`${url.pathname}${url.search}${url.hash}`)
  }

  if (error instanceof DocsMissingError)
    return (
      <article className="doc-article">
        <div className="doc-notice">
          <h2 className="type-title text-slate-100">
            No documentation in this build
          </h2>
          <p className="type-body mt-2 text-slate-400">{error.message}</p>
        </div>
      </article>
    )

  if (error !== null)
    return (
      <article className="doc-article">
        <div className="doc-notice">
          <h2 className="type-title text-slate-100">
            The contents could not be loaded
          </h2>
          <p className="type-body mt-2 text-slate-400">{error.message}</p>
        </div>
      </article>
    )

  if (page.pending || manifest === null)
    return (
      <article className="doc-article" aria-busy="true">
        {/* Three lines of nothing, at the measure the prose will have.
            A spinner would be a second thing to look at; this is the shape of
            the answer, arriving. */}
        <div className="doc-skeleton" />
        <div className="doc-skeleton w-[88%]" />
        <div className="doc-skeleton w-[64%]" />
      </article>
    )

  if (page.value === null)
    return (
      <article className="doc-article">
        <div className="doc-notice">
          <h2 className="type-title text-slate-100">No such page</h2>
          <p className="type-body mt-2 text-slate-400">
            Nothing in this build answers to{' '}
            <code className="type-readout text-slate-300">{route}</code>. The
            contents are on the left, and search is in the bar above.
          </p>
        </div>
      </article>
    )

  return (
    <article className="doc-article">
      {/*
       * How long this is, before it is read rather than after.
       *
       * The Instrument register, because both are counts of what is in front of
       * you. It answers the question somebody actually has on arriving at a
       * page of documentation — whether this is four hundred words or four
       * thousand — and it is the honest version of a reading-time estimate,
       * which is the same number with an invented rate applied to it.
       */}
      {page.value.words > 0 && (
        <p className="type-micro mb-6 text-slate-400">
          {page.value.words.toLocaleString('en-US')} words
          {page.value.diagrams > 0 &&
            ` · ${page.value.diagrams} diagram${page.value.diagrams === 1 ? '' : 's'}`}
        </p>
      )}
      <div
        ref={body}
        className="doc-prose"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: page.value.html }}
      />
      <DocFooter manifest={manifest} route={route} page={page.value} />
    </article>
  )
}
