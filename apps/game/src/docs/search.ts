import type { DocEntry, SearchIndex, SearchRow } from './content.ts'

/*
 * Search, as a pure function of an index and a string.
 *
 * No library, and the reason is the corpus rather than a preference for
 * writing one: nine hundred rows is small enough that a linear scan with a
 * scoring function is faster than building an inverted index in the browser,
 * and the ranking below is the whole product — knowing that a hit in a title
 * outranks a hit in a heading outranks a hit in the body is what makes a search
 * for "frames" put `Reference frames` above the forty pages that mention one.
 *
 * A pure function so the ranking is testable in Node, which matters more here
 * than usual: relevance degrades silently. A change to the weights below breaks
 * nothing, throws nothing and renders identically — the results are simply
 * worse, one edit at a time. `docs.test.ts` asserts the *order* on a fixture
 * small enough to reason about.
 */

export interface SearchHit {
  readonly route: string
  readonly title: string
  readonly wing: string
  readonly kind: DocEntry['kind']
  readonly lead: string
  /** The section that matched, when one did — the result links straight to it. */
  readonly section: { readonly id: string; readonly text: string } | null
  readonly score: number
}

/** Below this a query is a letter or two and every page matches it. */
const MIN_TERM = 2

/**
 * The ranked results for a query, best first.
 *
 * Every term has to hit somewhere on a page for it to be a result at all. That
 * is an `AND`, and it is the right default for documentation: somebody typing
 * "terrain quadtree" wants the page about both, and an `OR` buries it under
 * every page that says "terrain".
 */
export function searchDocs(
  index: SearchIndex,
  query: string,
  limit = 20,
): SearchHit[] {
  const terms = tokenize(query, index.stop)
  if (terms.length === 0) return []

  const hits: SearchHit[] = []
  for (const row of index.rows) {
    const scored = scoreRow(row, terms, query.trim().toLowerCase())
    if (scored !== null) hits.push(scored)
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      /* A tie between a document and an API member goes to the document: a
         reader who typed a word that is both a concept and a symbol asked the
         question in English. */
      kindRank(a.kind) - kindRank(b.kind) ||
      a.title.length - b.title.length ||
      a.title.localeCompare(b.title),
  )
  return hits.slice(0, limit)
}

function scoreRow(
  row: SearchRow,
  terms: readonly string[],
  whole: string,
): SearchHit | null {
  const title = row.t.toLowerCase()
  const lead = row.l.toLowerCase()
  // Padded on both sides so `includes(' ' + term)` means "a word starting with
  // this term" rather than "these letters anywhere", which is the difference
  // between `frame` finding `frames` and `frame` finding `timeframe`.
  const body = ` ${row.b} `

  let score = 0
  let section: SearchHit['section'] = null

  for (const term of terms) {
    let best = 0
    if (title.includes(term)) best = title.startsWith(term) ? 24 : 16

    for (const [id, text] of row.h) {
      const heading = text.toLowerCase()
      if (!heading.includes(term)) continue
      best = Math.max(best, 9)
      section ??= { id, text }
    }

    if (lead.includes(term)) best = Math.max(best, 5)
    if (body.includes(` ${term}`)) best = Math.max(best, 2)

    // One term nowhere on the page means the page is not an answer.
    if (best === 0) return null
    score += best
  }

  /*
   * The whole query as one phrase, in the title, is worth more than its words
   * scattered through it. Without this, "reference frames" ranks
   * `Reference frames` and `A reference for frames` identically, because the
   * index cannot tell adjacency — this is the one case where the raw query
   * still can.
   */
  if (title.includes(whole)) score += 12
  if (title === whole) score += 20

  return {
    route: section === null ? row.r : `${row.r}#${section.id}`,
    title: row.t,
    wing: row.w,
    kind: row.k,
    lead: row.l,
    section,
    score,
  }
}

const kindRank = (kind: DocEntry['kind']): number =>
  kind === 'prose' ? 0 : kind === 'api-package' ? 1 : 2

/**
 * The query, as the words worth matching on.
 *
 * The stop list is the index's own, and passing it is not optional in practice:
 * these words are absent from every page's vocabulary by construction, so a
 * query keeping one of them requires a term nothing can satisfy and returns
 * nothing at all. "The harness" is the case that found it.
 */
export function tokenize(
  query: string,
  stop: readonly string[] = [],
): string[] {
  const dropped = new Set(stop)
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((term) => term.length >= MIN_TERM && !dropped.has(term)),
    ),
  ]
}
