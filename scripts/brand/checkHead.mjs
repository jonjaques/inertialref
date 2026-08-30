/*
 * The gate on the one artifact a scraper actually reads.
 *
 * `pnpm brand --check` re-derives every generated public-surface artifact —
 * `manifest.webmanifest`, `robots.txt`, `favicon.svg` — and diffs it against
 * what is committed. The document head is not generated: `Base.astro`
 * interpolates helpers from `src/site.ts`, and this file is the gate that
 * it still does — and that those helpers still say what a card, a tab and
 * a crawler can show.
 *
 * **A check, not a generator.** Generating the head was argued and declined:
 * `build.mjs` records why a generator fights `pnpm format`, and the head is
 * hand-written prose with comments in it that explain a trade a generator
 * would flatten. So the interface here is "pass, or name the tag that
 * disagrees" — the layout stays readable, and stops being unguarded.
 *
 * Two kinds of value land in a tag. An interpolation (`{title}`,
 * `{page.description}`, `{canonical}`) is the contract: the layout names
 * a helper, and the helper's result is what ships. A literal that still
 * equals what `site.ts` would have written is not drift. A *disagreeing*
 * literal is — two canonicals for one page is the split the tag exists
 * to prevent, and a hand-typed copy is how it arrives.
 *
 * **Parsing.** Tolerant extraction over a file whose shape this repository
 * controls, rather than an HTML parser dependency for a gate on our own
 * head. The one assumption is that no attribute value contains a `>`; if
 * that ever stops being true the extraction silently returns fewer tags,
 * which is why every expected tag is *counted* as well as compared. A
 * gate that quietly stops looking is worse than no gate.
 */
import {
  PAGES,
  SITE,
  canonicalUrl,
  documentTitle,
  jsonLd,
} from '../../apps/game/src/site.ts'

/** The home page's entry, which is what an unmatched path's card is written for. */
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

/**
 * Helpers the layout must call. A layout that stops calling one of these is a
 * layout that has gone back to spelling the product by hand.
 */
const HELPERS = ['pageMetaFor(', 'documentTitle(', 'canonicalUrl(', 'jsonLd(']

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

/**
 * One attribute, quoted or as an Astro expression.
 *
 * `content={page.description}` is how the layout binds a helper; a drifted
 * test spells a literal in quotes. Both have to parse, or the gate cannot
 * fail against a layout that went back to hand-typed tags.
 */
const attribute = (attrs, name) => {
  const quoted = new RegExp(`\\b${name}="([\\s\\S]*?)"`).exec(attrs)
  if (quoted !== null) return quoted[1]
  const expr = new RegExp(`\\b${name}=\\{([^}]+)\\}`).exec(attrs)
  return expr === null ? null : `{${expr[1]}}`
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

/** Every `description` in a JSON-LD graph, flattened. */
function fromGraph(value) {
  const out = []
  const root = value && typeof value === 'object' ? value : {}
  for (const node of root['@graph'] ?? [root]) {
    if (typeof node?.description === 'string') {
      out.push({
        node: node['@type'] ?? node['@id'] ?? '?',
        text: node.description,
      })
    }
  }
  return out
}

/** Every `description` in every JSON-LD node, flattened. */
function structuredDescriptions(html, head) {
  if (html.includes('jsonLd(')) return fromGraph(jsonLd())
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
    out.push(...fromGraph(parsed))
  }
  return out
}

/**
 * An interpolation the layout used, or a literal.
 *
 * Interpolations agree with the helper they name. A literal has to equal
 * `wanted` on its own.
 */
function agrees(found, wanted, interpolations) {
  if (found === wanted) return true
  return interpolations.includes(found)
}

/**
 * The string a length bound can see.
 *
 * An interpolation has no length of its own — `{page.description}` is 19
 * characters and the sentence it names is 157. The helper's result is what
 * a search result shows. A literal is already the sentence.
 */
function asText(found, resolved) {
  if (typeof found !== 'string') return found
  return found.startsWith('{') ? resolved : found
}

/* ------------------------------------------------------------------------- */
/* The check                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Everything in the document head that disagrees with `src/site.ts`.
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

  const wantedTitle = documentTitle(ROOT)
  const wantedCanonical = canonicalUrl(ROOT.path)
  const wantedImage = `${SITE.origin}${SITE.socialImage}`

  /* The layout still calls the helpers. --------------------------------- */

  for (const token of HELPERS) {
    if (!html.includes(token)) {
      say(
        `the layout does not call ${token.slice(0, -1)} — the head would drift from site.ts`,
      )
    }
  }

  /* The title, and the two cards that repeat it. ------------------------- */

  const title = /<title>([\s\S]*?)<\/title>/.exec(head)?.[1]?.trim() ?? null
  if (!agrees(title, wantedTitle, ['{title}', '{documentTitle(page)}'])) {
    say(
      `<title> is ${JSON.stringify(title)}, expected ${JSON.stringify(wantedTitle)}`,
    )
  }
  for (const key of ['og:title', 'twitter:title']) {
    if (
      !agrees(meta.get(key), wantedTitle, ['{title}', '{documentTitle(page)}'])
    ) {
      say(
        `${key} is ${JSON.stringify(meta.get(key))}, expected ${JSON.stringify(wantedTitle)}`,
      )
    }
  }

  /* The descriptions. ---------------------------------------------------- */

  // The two that *are* the page's description are compared exactly, or as
  // the interpolation that names it. A rewrite in `site.ts` that leaves a
  // hand-typed copy behind is the ordinary drift.
  for (const key of ['description', 'og:description']) {
    if (
      !agrees(meta.get(key), SITE.description, [
        '{page.description}',
        '{SITE.description}',
      ])
    ) {
      say(`${key} does not match SITE.description`)
    }
  }
  // Every description-bearing tag, including a drifted literal, held to
  // the bound nothing has ever held them to. Interpolations resolve to
  // the home page's description because that is this layout's unmatched
  // path; `site.test.ts` holds every other PageMeta to the same numbers.
  for (const key of ['description', 'og:description', 'twitter:description']) {
    const text = asText(meta.get(key), SITE.description)
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
  for (const { node, text } of structuredDescriptions(html, head)) {
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
      wantedCanonical,
      ['{canonical}', '{canonicalUrl(pathname)}', '{canonicalUrl(page)}'],
    ],
    [
      'og:url',
      meta.get('og:url'),
      wantedCanonical,
      ['{canonical}', '{canonicalUrl(pathname)}', '{canonicalUrl(page)}'],
    ],
    [
      'theme-color',
      meta.get('theme-color'),
      SITE.background,
      ['{SITE.background}'],
    ],
    ['og:image', meta.get('og:image'), wantedImage, ['{image}']],
    ['twitter:image', meta.get('twitter:image'), wantedImage, ['{image}']],
    ['og:site_name', meta.get('og:site_name'), SITE.name, ['{SITE.name}']],
    [
      'apple-mobile-web-app-title',
      meta.get('apple-mobile-web-app-title'),
      SITE.name,
      ['{SITE.name}'],
    ],
    ['author', meta.get('author'), SITE.author, ['{SITE.author}']],
  ]
  for (const [label, found, wanted, interpolations] of exact) {
    if (!agrees(found, wanted, interpolations)) {
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
   *
   * The layout interpolates origin-bearing tags, so the interesting URLs live
   * in `jsonLd()` and in whatever literals remain (the noscript courtesy, a
   * drifted test). Scanning both is how a host cannot hide in the helper.
   */
  const haystack = `${head}\n${JSON.stringify(jsonLd())}`
  for (const [url] of haystack.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
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
    ['JSON-LD description', structuredDescriptions(html, head).length, 2],
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
