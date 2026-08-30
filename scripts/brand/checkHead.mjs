/*
 * The gate on the one artifact a scraper actually reads.
 *
 * `pnpm brand --check` re-derives every generated public-surface artifact —
 * `manifest.webmanifest`, `robots.txt`, `sitemap.xml`, `favicon.svg` — and
 * diffs it against what is committed. It never opened the document that a
 * scraper actually reads, which is now the Astro layout: the only file whose
 * contents nothing derives.
 *
 * **A check, not a generator.** Generating the head was argued and declined:
 * `build.mjs` records why a generator fights `pnpm format`, and the head is
 * hand-written prose with comments in it that explain a trade a generator would
 * flatten. So the interface here is "pass, or name the tag that disagrees" —
 * the duplication stays, and stops being unguarded.
 *
 * It is guarding a real near miss. `d4f4065` fixed `canonicalUrl` to drop a
 * trailing slash; the generated sitemap fixed itself and the hand-typed
 * canonical in the document was already right — by luck, that time. The head
 * also carries five description strings, and the 60–160 bound `site.test.ts`
 * holds every `PageMeta` to has never applied to any of them.
 *
 * **Parsing.** Tolerant extraction over a file whose shape this repository
 * controls, rather than an HTML parser dependency for a gate on our own head.
 * The one assumption is that no attribute value contains a `>`; if that ever
 * stops being true the extraction silently returns fewer tags, which is why
 * every expected tag is *counted* as well as compared. A gate that quietly
 * stops looking is worse than no gate.
 */
import {
  PAGES,
  SITE,
  canonicalUrl,
  documentTitle,
} from '../../apps/game/src/site.ts'

/** The home page's entry, which is what the static head is written for. */
const ROOT = /** @type {import('../../apps/game/src/site.ts').PageMeta} */ (
  PAGES[PAGES.length - 1]
)

/**
 * Where a search result stops showing a description.
 *
 * The same bound `site.test.ts` holds every `PageMeta` to, for the same reason:
 * past it the sentence does not end where its author ended it. The floor is not
 * about search — it is the guard against a placeholder.
 */
const SNIPPET = { min: 60, max: 160 }

/**
 * The bound on a JSON-LD `description`, which is deliberately looser.
 *
 * A structured-data description is never rendered as a snippet, so 160 is not
 * the constraint there — the `SoftwareApplication` node says what the thing is
 * in more detail than a card ever shows, on purpose. The ceiling is still real:
 * past a paragraph it has stopped being a description and become the page.
 */
const STRUCTURED = { min: 60, max: 300 }

/**
 * Hosts the head is allowed to name besides our own.
 *
 * An allow-list rather than "anything that is not us", because the failure this
 * catches is a URL pointing at the *wrong spelling of us* — `http://` instead
 * of `https://`, the `workers.dev` back door, a stray `www`. Each entry below
 * is here because a specific tag needs it.
 */
const FOREIGN = [
  'https://schema.org', // the JSON-LD @context
  'https://github.com/jonjaques', // codeRepository and the author's url
  'https://www.apache.org/licenses/', // the license the project is under
]

/* ------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The `<head>` of a document, with its comments removed.
 *
 * The comments have to go before anything else looks at this. The head's own
 * commentary quotes the tags it is explaining — "`pages/DocumentMeta.tsx`
 * updates `<title>`" — so the first `<title>` in the file is inside a comment,
 * and an extractor that does not strip them reads four hundred words of prose
 * as the page's title.
 */
export function headOf(html) {
  const open = html.indexOf('<head>')
  const close = html.indexOf('</head>')
  const head = open === -1 || close === -1 ? html : html.slice(open + 6, close)
  return head.replace(/<!--[\s\S]*?-->/g, '')
}

const attribute = (attrs, name) => {
  const found = new RegExp(`\\b${name}="([\\s\\S]*?)"`).exec(attrs)
  return found === null ? null : found[1]
}

/** Every `<meta>`, keyed by its `name` or `property`. Later wins, as HTML does. */
export function metaTags(head) {
  const out = new Map()
  for (const [, attrs] of head.matchAll(/<meta\b([^>]*?)\/?>/g)) {
    const key = attribute(attrs, 'name') ?? attribute(attrs, 'property')
    if (key === null) continue
    out.set(key, attribute(attrs, 'content'))
  }
  return out
}

/** Every `<link>`, keyed by `rel`. */
export function linkTags(head) {
  const out = new Map()
  for (const [, attrs] of head.matchAll(/<link\b([^>]*?)\/?>/g)) {
    const rel = attribute(attrs, 'rel')
    if (rel === null) continue
    if (!out.has(rel)) out.set(rel, [])
    out.get(rel).push(attribute(attrs, 'href'))
  }
  return out
}

/** Every `description` in every JSON-LD node, flattened. */
function structuredDescriptions(head) {
  const out = []
  for (const [, body] of head.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  )) {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch (cause) {
      out.push({ node: 'unparseable', text: String(cause) })
      continue
    }
    for (const node of parsed['@graph'] ?? [parsed]) {
      if (typeof node?.description === 'string') {
        out.push({
          node: node['@type'] ?? node['@id'] ?? '?',
          text: node.description,
        })
      }
    }
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* The check                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Everything in the static head that disagrees with `src/site.ts`.
 *
 * Returns a list of sentences; empty means the head and the module still say
 * the same thing. Takes the sources rather than reading them, so a test can
 * hand it a deliberately drifted head — a gate that cannot fail is not a gate.
 *
 * @param {object} sources
 * @param {string} sources.html      `apps/game/astro/layouts/Base.astro`
 * @param {string} sources.sw        `apps/game/public/sw.js`
 * @param {Set<string>} sources.publicFiles  names in `apps/game/public/`
 */
export function checkPublicSurface({ html, sw, publicFiles }) {
  const problems = []
  const head = headOf(html)
  const meta = metaTags(head)
  const links = linkTags(head)
  const say = (problem) => problems.push(problem)

  /* The title, and the two cards that repeat it. ------------------------- */

  const title = /<title>([\s\S]*?)<\/title>/.exec(head)?.[1]?.trim() ?? null
  const wantedTitle = documentTitle(ROOT)
  if (title !== wantedTitle) {
    say(
      `<title> is ${JSON.stringify(title)}, expected ${JSON.stringify(wantedTitle)}`,
    )
  }
  for (const key of ['og:title', 'twitter:title']) {
    if (meta.get(key) !== wantedTitle) {
      say(
        `${key} is ${JSON.stringify(meta.get(key))}, expected ${JSON.stringify(wantedTitle)}`,
      )
    }
  }

  /* The descriptions. ---------------------------------------------------- */

  // The two that *are* the home page's description are compared exactly. A
  // rewrite in `site.ts` that leaves these behind is the ordinary drift.
  for (const key of ['description', 'og:description']) {
    if (meta.get(key) !== SITE.description) {
      say(`${key} does not match SITE.description`)
    }
  }
  // Every description-bearing tag, including the ones with their own wording,
  // held to the bound nothing has ever held them to.
  for (const key of ['description', 'og:description', 'twitter:description']) {
    const text = meta.get(key)
    if (typeof text !== 'string') {
      say(`${key} is missing`)
      continue
    }
    if (text.length < SNIPPET.min || text.length > SNIPPET.max) {
      say(
        `${key} is ${text.length} characters; a search result shows ${SNIPPET.min}–${SNIPPET.max}`,
      )
    }
  }
  for (const { node, text } of structuredDescriptions(head)) {
    if (text.length < STRUCTURED.min || text.length > STRUCTURED.max) {
      say(
        `the ${node} JSON-LD description is ${text.length} characters; the bound is ${STRUCTURED.min}–${STRUCTURED.max}`,
      )
    }
  }

  /* The values `site.ts` owns outright. ---------------------------------- */

  const exact = [
    [
      'link rel=canonical',
      links.get('canonical')?.[0],
      canonicalUrl(ROOT.path),
    ],
    ['og:url', meta.get('og:url'), canonicalUrl(ROOT.path)],
    ['theme-color', meta.get('theme-color'), SITE.background],
    ['og:image', meta.get('og:image'), `${SITE.origin}${SITE.socialImage}`],
    [
      'twitter:image',
      meta.get('twitter:image'),
      `${SITE.origin}${SITE.socialImage}`,
    ],
    ['og:site_name', meta.get('og:site_name'), SITE.name],
    [
      'apple-mobile-web-app-title',
      meta.get('apple-mobile-web-app-title'),
      SITE.name,
    ],
    ['author', meta.get('author'), SITE.author],
  ]
  for (const [label, found, wanted] of exact) {
    if (found !== wanted) {
      say(
        `${label} is ${JSON.stringify(found)}, expected ${JSON.stringify(wanted)}`,
      )
    }
  }

  /* Every absolute URL. -------------------------------------------------- */

  /*
   * The failure this catches is not a foreign link, it is a *wrong spelling of
   * us*: `http://`, the `workers.dev` back door, a stray `www`. Both halves are
   * needed — an unknown host is reported so a new one has to be declared above,
   * and a URL that merely looks like ours is reported because that is the one
   * that silently splits the canonical.
   */
  for (const [url] of head.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
    const trimmed = url.replace(/[.,)]+$/, '')
    if (trimmed.startsWith(SITE.origin)) continue
    if (FOREIGN.some((allowed) => trimmed.startsWith(allowed))) continue
    say(
      trimmed.includes(SITE.host.split('.')[0])
        ? `${trimmed} is this site under a name that is not SITE.origin`
        : `${trimmed} names a host the head is not declared to use`,
    )
  }

  /* The service worker's precache list. ---------------------------------- */

  /*
   * The second unguarded duplication in the same family. `sw.js` is not
   * compiled — it cannot import anything — so it names four paths by hand, and
   * a renamed or deleted public file turns a cold offline launch into a failed
   * install with no other symptom.
   */
  const precache = /const PRECACHE = \[([\s\S]*?)\]/.exec(sw)?.[1] ?? null
  if (precache === null) {
    say('public/sw.js has no PRECACHE list where this check expects one')
  } else {
    const entries = [...precache.matchAll(/'([^']*)'/g)].map(([, path]) => path)
    if (entries.length === 0) say('public/sw.js PRECACHE is empty')
    for (const path of entries) {
      // `/` is the SPA root and `/index.html` is Vite's entry; neither is a file
      // in `public/`, and both are what an offline launch starts from.
      if (path === '/' || path === '/index.html') continue
      if (!publicFiles.has(path.replace(/^\//, ''))) {
        say(`public/sw.js precaches ${path}, which nothing generates or ships`)
      }
    }
  }

  /* The census. ---------------------------------------------------------- */

  /*
   * Counted as well as compared, because the extraction above is regex over
   * HTML: a tag it cannot see is a tag it silently reports as correct. If you
   * are reading this because the count is wrong, the fix is to cover the new
   * tag above and then move the number — in that order.
   */
  const census = [
    ['meta', meta.size, 25],
    ['link', [...links.values()].flat().length, 5],
    ['JSON-LD description', structuredDescriptions(head).length, 2],
  ]
  for (const [what, found, wanted] of census) {
    if (found !== wanted) {
      say(
        `found ${found} ${what} tags in the head, expected ${wanted} — cover the new one in scripts/brand/checkHead.mjs and update the census`,
      )
    }
  }

  return problems
}
