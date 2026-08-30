import { useEffect } from 'react'
import { recordPageView } from '../analytics.ts'
import { hrefOf, useOverlayStore } from './overlay.ts'
import { canonicalUrl, documentTitle, pageMetaFor } from '../site.ts'

/*
 * What the document says about itself, kept in step with the address bar.
 *
 * Renders nothing. It exists because the URL is this product's public surface
 * (ADR-0011) and a tab strip, a bookmark, a browser history entry and a shared
 * link are four places a person reads a page's name — none of which the
 * interface itself controls.
 *
 * **Three tags, and deliberately not the Open Graph set.** `<title>`,
 * `<meta name="description">` and `<link rel="canonical">` are read by things
 * that execute JavaScript: the browser, Googlebot, an agent driving a headless
 * browser. Open Graph is read by things that do not — Slack, iMessage,
 * Discord, every unfurler — so rewriting `og:title` here would change nothing
 * any scraper ever sees while looking exactly like it had. Those live in the
 * layout, interpolated from `src/site.ts`. This component covers the tab
 * strip on a `pushState` that does not load a new document — opening Settings
 * over the planetarium, a settings tab, closing a dialog.
 *
 * **The address bar, not the mode.** Everywhere else that would be the bug:
 * with a dialog open, the mode's location and the URL differ, and anything
 * deciding *what is on screen* has to use the mode's. This is the other
 * question. The address bar reads `/settings`, so the tab, the bookmark and
 * the canonical link have to say Settings.
 */

export function DocumentMeta() {
  const href = useOverlayStore((state) =>
    state.overlay === null ? hrefOf(state.mode) : state.overlay,
  )
  const pathname = href.split('?')[0]?.split('#')[0] ?? href

  useEffect(() => {
    const page = pageMetaFor(pathname)
    const title = documentTitle(page)
    const canonical = canonicalUrl(page.path === '/' ? '/' : pathname)

    document.title = title
    attribute('meta[name="description"]', 'content', page.description)
    attribute('link[rel="canonical"]', 'href', canonical)

    /*
     * The page view goes out from here rather than from a second effect on the
     * same location, because a view is *this* — a name and an address, at the
     * moment they became true. Two effects racing to describe one navigation is
     * how a title and a report of it end up describing different pages.
     */
    recordPageView(canonical, title)
  }, [pathname])

  return null
}

/**
 * Update a tag the layout already has, and do nothing if it does not.
 *
 * Deliberately not "create it if missing": every tag this touches is in the
 * static head, because a scraper that does not run scripts has to find it
 * there. If one is absent, the static head is what is wrong, and silently
 * papering over that would hide it from the only person who could fix it.
 */
function attribute(selector: string, name: string, value: string): void {
  document.head.querySelector(selector)?.setAttribute(name, value)
}
