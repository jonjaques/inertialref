import type { DocPage } from './content.ts'
import { DOC_PAGE_SCRIPT_ID, DOC_SSR_ID } from './urls.ts'

/*
 * The documentation page, as this document already contains it.
 *
 * Astro emits the article as HTML and the rest of the page record as a JSON
 * script. Fetching the same bytes as `/doc-content/page/*.json` would be a
 * second copy of a file the reader is already looking at. The manifest still
 * loads over the network — it is the rail for every page, and embedding it
 * in each document would pay its size on every navigation.
 */

/** What `readDocPage` needs of a document. Injected, so the test is Node. */
export interface DocSource {
  getElementById(
    id: string,
  ): { textContent: string | null; innerHTML: string } | null
}

function sourceOf(source?: DocSource): DocSource {
  if (source !== undefined) return source
  if (typeof document === 'undefined') {
    return { getElementById: () => null }
  }
  return document
}

/**
 * The page this document was built to be, or `null` when it is not one.
 *
 * A missing script, a missing article, or JSON that does not parse are all
 * the same miss: this document is not a documentation page. Throwing any of
 * those would take the reading room down with an error boundary, and the
 * words are already on screen in `#doc-ssr`.
 */
export function readDocPage(source?: DocSource): DocPage | null {
  const doc = sourceOf(source)
  const script = doc.getElementById(DOC_PAGE_SCRIPT_ID)
  const article = doc.getElementById(DOC_SSR_ID)
  if (script === null || article === null) return null
  const raw = script.textContent
  if (raw === null || raw.length === 0) return null
  try {
    const meta = JSON.parse(raw) as Omit<DocPage, 'html'>
    return { ...meta, html: article.innerHTML }
  } catch {
    return null
  }
}
