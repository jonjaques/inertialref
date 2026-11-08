import { useContext, useEffect } from 'react'
import { useLocation } from 'react-router'
import { recordEvent, recordPageview, startTelemetry } from '../telemetry/posthog.ts'
import { DocsContentContext } from '../docs/initialDocs.ts'
import { docRoute } from '../docs/content.ts'
import {
  canonicalUrl,
  documentTitle,
  metadataForPath,
  robotsContent,
} from '../site.ts'
import { DOCS, modeForPath, resolvedLocation } from './paths.ts'

/** Metadata describes the address bar, including a dialog over another mode. */
export function DocumentMeta() {
  const location = useLocation()
  const { pathname } = location
  const docs = useContext(DocsContentContext)
  const path = docRoute(
    docs?.manifest.value ?? null,
    pathname.replace(/\/+$/, '') || '/',
  )
  const article = docs?.page.value
  const isArticle = path.startsWith(`${DOCS}/`)
  const pending =
    isArticle && (docs === null || docs.manifest.pending || docs.page.pending)
  const doc = article?.route === path ? article : undefined
  const missing =
    isArticle &&
    docs !== null &&
    !pending &&
    docs.manifest.value !== null &&
    docs.manifest.value.pages[path] === undefined

  useEffect(() => {
    // Await an article's metadata once, alongside its content. A provisional
    // section title would overwrite the prerendered head and double-count the
    // navigation when the article arrives.
    if (pending && doc === undefined) return
    const page = metadataForPath(path, missing ? null : doc)
    const title = documentTitle(page)
    const canonical = canonicalUrl(page.path)

    document.title = title
    attribute('meta[name="description"]', 'content', page.description)
    attribute('link[rel="canonical"]', 'href', canonical)
    attribute('meta[name="robots"]', 'content', robotsContent(page))
    attribute('meta[property="og:title"]', 'content', title)
    attribute('meta[property="og:description"]', 'content', page.description)
    attribute('meta[property="og:url"]', 'content', canonical)
    attribute('meta[name="twitter:title"]', 'content', title)
    attribute('meta[name="twitter:description"]', 'content', page.description)
    // Started here rather than with the runtime, because the menu, the
    // settings and the docs are visits too and never load the runtime.
    startTelemetry()
    recordPageview(page.path, title)
  }, [path, pending, doc, missing])

  /*
   * Which mode the address bar is in, once per change of mode. The resolved
   * pathname, not the raw one: a dialog over the planetarium is still the
   * planetarium, and counting the dialog's path would enter a mode nobody
   * left.
   */
  const mode = modeForPath(resolvedLocation(location).pathname)
  useEffect(() => {
    recordEvent('mode entered', { mode })
  }, [mode])

  return null
}

/** Astro supplies these tags before hydration; navigation updates their values. */
function attribute(selector: string, name: string, value: string): void {
  document.head.querySelector(selector)?.setAttribute(name, value)
}
