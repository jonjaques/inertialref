/*
 * The documentation, as the client sees it.
 *
 * `scripts/docs/build.mjs` writes a directory of JSON into
 * `public/doc-content/` and this is the only thing that reads it. Two shapes
 * cross that line and both are declared here rather than generated: a hand
 * written interface is a contract two programs have agreed to, and a generated
 * one is a description of whatever the generator happened to emit last. When
 * they disagree, the build is what is wrong.
 *
 * **Nothing is bundled.** The manifest, the search index and every page are
 * fetched. That is a decision about ninety per cent of the visitors to this
 * site, who never open the documentation at all and should not be paying for
 * 180 KB of it in the bundle that draws the galaxy — and it costs the reader
 * one round trip on a same-origin file the service worker serves
 * stale-while-revalidate, which is to say approximately nothing on the second
 * visit and nothing at all offline.
 */

/** Where the build stages its output. Mirrors `OUT` in `scripts/docs/build.mjs`. */
const CONTENT = '/doc-content'

/* ------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * What the masthead's camera is doing while a wing is being read.
 *
 * The same four numbers the front door uses, and for the same reason they are
 * numbers rather than a preset name: `phase` is solved against where the star
 * actually is, so it is continuous and can be ramped. `scripts/docs/wings.mjs`
 * argues the choice of body per wing.
 */
export interface DocFraming {
  /** An address the observatory can resolve — `s:SOL/b:5`. */
  readonly address: string
  /** Sun-body-camera angle in degrees. 0 is the fully lit face. */
  readonly phase: number
  /** How far the swing plane is rolled out of the star's own, in degrees. */
  readonly tilt: number
  /** The fraction of the band's height the body subtends. */
  readonly fill: number
}

export interface DocHeading {
  readonly id: string
  readonly text: string
  /** 2 or 3 for a document; the reference uses both for the same purpose. */
  readonly depth: number
}

export interface DocGroup {
  /** `null` for a wing whose pages are one undivided list. */
  readonly label: string | null
  /** The page the group is named after, when it has one — a package, a bible. */
  readonly head: string | null
  readonly pages: readonly string[]
}

export interface DocWing {
  readonly id: string
  readonly label: string
  readonly blurb: string
  readonly framing: DocFraming
  /**
   * Where the wing's own name goes.
   *
   * Its first page for the four that are a rail and nothing else — `Concepts`
   * is not a document, it is twenty-six of them — and `/docs/api` for the
   * reference, which has an index worth arriving at.
   */
  readonly home: string
  readonly groups: readonly DocGroup[]
}

/** What the navigation knows about a page before anyone has opened it. */
export interface DocEntry {
  readonly title: string
  /** Shorter than the title where a rail needs it to be. */
  readonly label: string
  readonly wing: string
  readonly kind: 'prose' | 'api-index' | 'api-package' | 'api-member'
  /** The file under `/doc-content/page/`. Carried rather than derived — see
   *  `assetName` in `scripts/docs/routes.mjs` for what derives it wrong. */
  readonly asset: string
}

export interface DocCounts {
  readonly pages: number
  readonly documents: number
  readonly words: number
  readonly diagrams: number
  readonly packages: number
  readonly exports: number
}

export interface DocManifest {
  readonly version: string
  readonly wings: readonly DocWing[]
  readonly pages: Readonly<Record<string, DocEntry>>
  readonly counts: DocCounts
}

export interface DocPage {
  readonly route: string
  readonly title: string
  readonly lead: string
  readonly kind: DocEntry['kind']
  /** Rendered at build time. The only HTML in this application that is not JSX. */
  readonly html: string
  readonly headings: readonly DocHeading[]
  readonly words: number
  readonly diagrams: number
  /** Where the document is edited, or `null` for a generated page. */
  readonly source: string | null
  readonly packageName: string | null
  readonly memberKind: string | null
}

export interface SearchRow {
  readonly r: string
  readonly t: string
  readonly w: string
  readonly k: DocEntry['kind']
  readonly l: string
  /** Each heading as `[anchor, text]`, so a result can land on the section. */
  readonly h: readonly (readonly [string, string])[]
  /** The page's distinct words, lowercased and sorted, space separated. */
  readonly b: string
}

export interface SearchIndex {
  readonly version: string
  /**
   * The words the build dropped from every page's vocabulary.
   *
   * Carried rather than restated on this side, because a word stopped in the
   * index and kept in the query is a word nothing can match — and the matcher
   * requires every term, so one of them takes the whole query down with it.
   */
  readonly stop: readonly string[]
  readonly rows: readonly SearchRow[]
}

/* ------------------------------------------------------------------------- */
/* Loading                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * What a reader is told when the content is not there.
 *
 * Its own class so the mode can tell "this build has no documentation in it"
 * apart from "the network is down", which are the same `fetch` rejection and
 * completely different sentences. The first is a missing build step on a
 * developer's machine and has an exact fix; the second is the offline path,
 * which this application treats as normal.
 */
export class DocsMissingError extends Error {
  constructor() {
    super(
      'This build carries no documentation. Run `pnpm docs:build` to generate it — ' +
        '`pnpm build` runs it first, so a deployed build always has it.',
    )
    this.name = 'DocsMissingError'
  }
}

let manifest: Promise<DocManifest> | null = null

/** The manifest, fetched once per session however many times it is asked for. */
export function loadManifest(): Promise<DocManifest> {
  manifest ??= fetchJson<DocManifest>(`${CONTENT}/manifest.json`).catch(
    (cause: unknown) => {
      // A 404 here means the directory was never generated. Anything else is a
      // network or a parse failure, and saying "run pnpm docs:build" about a
      // connection sends the reader to fix something that is not broken.
      manifest = null
      if (cause instanceof NotFound) throw new DocsMissingError()
      throw cause
    },
  )
  return manifest
}

let searchIndex: Promise<SearchIndex> | null = null

/**
 * The search index, fetched the first time somebody types.
 *
 * Half a megabyte, and deliberately not fetched with the manifest: it is needed
 * by the reader who searches and by nobody else, and the reader who searches
 * has already been on the page long enough to have paid for it invisibly.
 */
export function loadSearchIndex(): Promise<SearchIndex> {
  searchIndex ??= fetchJson<SearchIndex>(`${CONTENT}/search.json`).catch(
    (cause: unknown) => {
      searchIndex = null
      throw cause
    },
  )
  return searchIndex
}

const pages = new Map<string, Promise<DocPage>>()

/**
 * One page's body.
 *
 * Cached by asset name rather than by route, so the cache cannot serve the
 * previous build's copy of a page after a deploy changed it — the name carries
 * a digest of the route and the manifest carries the name, so a manifest from a
 * new build asks for new files.
 *
 * The retry is the one interesting line. `public/sw.js` serves this directory
 * stale-while-revalidate, and the manifest and the pages are not written
 * atomically, so for one request after a deploy a fresh manifest can name a
 * page the cache has never seen and the origin has only just gained. Asking
 * again past the cache turns that into a slower first load instead of an error
 * on a page that exists.
 *
 * **Past a different cache than the one it looks like.** `cache: 'reload'`
 * bypasses the HTTP cache, and the service worker is not one: it answers from
 * Cache Storage, and `Cache.match` keys on the URL alone — it has never heard
 * of a request's cache mode. So the retry asks for a *different* URL, which is
 * the only thing a `caches.match` can miss on. The query is ignored by the
 * asset store and the file that comes back is the same one.
 */
export function loadPage(entry: DocEntry): Promise<DocPage> {
  const url = `${CONTENT}/page/${entry.asset}`
  const existing = pages.get(entry.asset)
  if (existing !== undefined) return existing

  const promise = fetchJson<DocPage>(url)
    .catch((cause: unknown) => {
      if (!(cause instanceof NotFound)) throw cause
      return fetchJson<DocPage>(`${url}?retry=1`, { cache: 'reload' })
    })
    .catch((cause: unknown) => {
      pages.delete(entry.asset)
      throw cause
    })
  pages.set(entry.asset, promise)
  return promise
}

/** A miss, kept apart from every other reason a fetch can fail. */
class NotFound extends Error {}

/**
 * One staged file, or a miss.
 *
 * **A miss is detected by content type as well as by status, and that is not a
 * heuristic.** The Worker serves this origin with
 * `not_found_handling: single-page-application`, so the asset store answers a
 * path it does not have with `index.html` and a **200** — there is no status
 * code to test. Nothing under `/doc-content/` is ever HTML, so an HTML answer
 * to a request for a `.json` is unambiguous. `apps/server/src/serveMedia.ts`
 * reached the same conclusion for `/media/` and carries the longer argument.
 *
 * Trusting the 200 costs both of the things this distinction is for: the
 * manifest's absence would arrive as a JSON parse error rather than as
 * `DocsMissingError` and its exact fix, and `loadPage`'s re-fetch past the
 * cache — the one that recovers the window after a deploy where a fresh
 * manifest names a page the cache has not seen — would never fire.
 *
 * `404` stays in the test because the dev server does answer with one, and
 * because the deployment is not the only thing that ever serves these.
 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (response.status === 404) throw new NotFound(url)
  if (!response.ok)
    throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  if ((response.headers.get('content-type') ?? '').startsWith('text/html'))
    throw new NotFound(url)
  return (await response.json()) as T
}
