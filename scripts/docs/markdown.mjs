import { Marked, Renderer } from 'marked'
import GithubSlugger from 'github-slugger'
import { codeBlock, escapeAttribute } from './highlight.mjs'
import { linkFor } from './routes.mjs'

/*
 * One markdown file, as everything the site needs to draw it.
 *
 * The renderer is overridden rather than post-processed, because four of the
 * five things this build changes about a document cannot be done to a string of
 * HTML without parsing it again:
 *
 *   headings   need a slug that matches GitHub's, or every `#anchor` link
 *              already written in these seventy files points at nothing
 *   links      need resolving against the *file's* directory before they can
 *              be mapped to a route, and the token has no idea where it is
 *   fences     split three ways — a diagram, a highlighted listing, or neither
 *   tables     need a scroller around them, because a nine-column table of
 *              measurements is wider than a reading column and the alternative
 *              to scrolling it is the page scrolling sideways
 *
 * The fifth is the `<h1>`, which is dropped: the masthead above the article
 * already sets the document's title in the display face at four times the size,
 * and a page that states its own name twice reads as a rendering fault.
 */

/**
 * GitHub's anchor algorithm, which is what the corpus was written against.
 *
 * `github-slugger` rather than a regular expression, because the rule has
 * corners — repeated headings get `-1`, `-2`; punctuation is dropped but
 * hyphens are kept; case folds — and a link written by hand three years ago
 * against GitHub's rendering has to keep working. Two documents here already
 * link to `#determinism-in-the-simulation-not-just-generation`.
 */
const slugger = new GithubSlugger()

export function renderMarkdown(source, repoPath) {
  slugger.reset()

  const headings = []
  let title = null
  const counted = { diagrams: 0 }

  const marked = markedFor(repoPath, counted, {
    heading({ tokens, depth }) {
      const text = plainText(tokens)
      if (depth === 1 && title === null) {
        // The first `<h1>` is the document's title, and the masthead sets it.
        title = text
        return ''
      }
      const id = slugger.slug(text)
      // Two and three reach the table of contents. Four and deeper exist in
      // this corpus but are sub-points inside a section rather than places
      // to jump to, and listing them turns a scannable rail into a second
      // copy of the document.
      if (depth <= 3) headings.push({ id, text, depth })
      const inner = this.parser.parseInline(tokens)
      /*
       * The anchor is a link to the heading, not a decoration beside it.
       * Wrapping the whole heading rather than adding a `#` after it: the
       * target is then the words, which is what a reader aims at, and there
       * is no glyph that appears on hover and is invisible to a touch
       * screen.
       */
      return (
        `<h${depth} id="${escapeAttribute(id)}" class="doc-h">` +
        `<a href="#${escapeAttribute(id)}" class="doc-anchor">${inner}</a>` +
        `</h${depth}>\n`
      )
    },
  })

  const html = marked.parse(source, { async: false })
  const text = plainTextOf(source)

  return {
    title,
    html: html.trim(),
    headings,
    diagrams: counted.diagrams,
    lead: firstParagraph(source),
    words: text.split(/\s+/).filter((word) => word.length > 0).length,
    text,
  }
}

/**
 * A run of markdown that is not a document — a doc comment's summary, an
 * `@example`, the body of a `@remarks`.
 *
 * The same fences, links and tables as a page, and deliberately no headings in
 * the table of contents: a comment is a paragraph inside a section that the
 * reference page has already titled, so a `##` inside one is emphasis rather
 * than a place to jump to.
 */
export function renderFragment(source, repoPath) {
  let marked = fragmentRenderers.get(repoPath)
  if (marked === undefined) {
    marked = markedFor(
      repoPath,
      { diagrams: 0 },
      {
        heading({ tokens, depth }) {
          const level = Math.min(depth + 2, 6)
          return `<h${level} class="doc-h">${this.parser.parseInline(tokens)}</h${level}>\n`
        },
      },
    )
    fragmentRenderers.set(repoPath, marked)
  }
  return marked.parse(source, { async: false }).trim()
}

/*
 * One renderer per source path, kept rather than rebuilt.
 *
 * `api.mjs` calls the above for every summary, every block tag and every
 * documented parameter in the reference — several thousand fragments across
 * nine hundred pages — and a fresh `new Marked().use({ renderer })` each time
 * is the largest avoidable cost in that half of the build. An instance is a
 * pure function of `repoPath` and holds nothing between parses, which is what
 * makes it cacheable at all; the diagram tally it carries is written and never
 * read, because a `mermaid` fence in a doc comment belongs to the page whose
 * comment it is.
 */
const fragmentRenderers = new Map()

/**
 * The renderer both of the above share.
 *
 * Fences, links and tables are handled identically wherever the markdown came
 * from — a `{@link}` in a doc comment and a relative link in a guide have to
 * arrive at the same route, and an example in an API comment has to be
 * highlighted by the same theme as a listing in a concept page. Only headings
 * differ, which is why they are the parameter.
 */
function markedFor(repoPath, counted, extra) {
  const marked = new Marked({ gfm: true, breaks: false })
  marked.use({
    renderer: {
      ...extra,

      code({ text, lang }) {
        const named = (lang ?? '').trim().toLowerCase()
        if (named === 'mermaid') {
          counted.diagrams += 1
          /*
           * The source, escaped, waiting for a renderer that is not here yet.
           *
           * Mermaid needs a live DOM to measure text before it can lay a graph
           * out, so there is no honest way to draw these eighty-three diagrams
           * at build time without a headless browser in the toolchain.
           * `docs/mermaid.ts` imports the library on demand, only on a page
           * that has one — and until it resolves, and forever if it fails, the
           * source is what is on screen, which is a diagram a person can still
           * read.
           */
          return (
            `<figure class="doc-diagram">` +
            `<pre class="doc-mermaid">${escapeHtml(text)}</pre>` +
            `</figure>\n`
          )
        }
        return codeBlock(text, named)
      },

      link({ href, title: linkTitle, tokens }) {
        const { href: resolved, external } = linkFor(href, repoPath)
        const inner = this.parser.parseInline(tokens)
        const attributes = [
          `href="${escapeAttribute(resolved)}"`,
          linkTitle ? `title="${escapeAttribute(linkTitle)}"` : '',
          // `data-internal` is what the article's click handler looks for: a
          // route inside the application has to go through the router, or every
          // cross-reference in the corpus is a full page load that rebuilds the
          // renderer and drops the scene behind the masthead.
          external
            ? 'target="_blank" rel="noreferrer" class="doc-link doc-external"'
            : 'class="doc-link" data-internal',
        ].filter((part) => part !== '')
        return `<a ${attributes.join(' ')}>${inner}</a>`
      },

      table(token) {
        // marked's own table, inside a scroller. `tabindex` because a region
        // that scrolls has to be reachable by a keyboard that cannot drag it.
        const rendered = originalTable.call(this, token)
        return `<div class="doc-table" tabindex="0" role="region">${rendered}</div>\n`
      },
    },
  })

  return marked
}

/** marked's built-in table renderer, kept so the override can wrap it. */
const originalTable = Renderer.prototype.table

/* ------------------------------------------------------------------------- */
/* Plain text                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The words of a document, with the markup taken out.
 *
 * Feeds two things that both want prose and neither of which wants syntax: the
 * search index, where a query for "floating origin" must not miss a page
 * because the phrase happens to fall inside a link, and the word count in the
 * article's own header.
 *
 * Fences come out entirely rather than being flattened. A listing is not prose
 * — indexing it means a search for `const` returns forty pages — and the ninety
 * per cent of these fences that are mermaid would put `flowchart LR` into the
 * excerpt of half the corpus.
 */
function plainTextOf(source) {
  return source
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}[#>|:\-*+]+\s*/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The document's opening sentence or two, for the navigation and the search
 * result under its title.
 *
 * The first paragraph after the `<h1>`, capped at a length that survives being
 * put in a `<meta name="description">` — 160 characters is where a search
 * result truncates, and `src/site.ts` already holds the whole interface to that
 * bound. Cut at a word boundary rather than mid-word, and only when there is
 * genuinely more.
 */
function firstParagraph(source) {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, '')
  const blocks = body.split(/\n{2,}/)
  for (const block of blocks) {
    const trimmed = block.trim()
    if (trimmed === '' || /^[#>|`\-*+]/.test(trimmed)) continue
    const text = plainTextOf(trimmed)
    if (text.length === 0) continue
    if (text.length <= 160) return text
    const cut = text.slice(0, 160)
    return `${cut.slice(0, cut.lastIndexOf(' '))}…`
  }
  return ''
}

const plainText = (tokens) =>
  tokens
    .map((token) =>
      token.tokens !== undefined
        ? plainText(token.tokens)
        : (token.text ?? token.raw ?? ''),
    )
    .join('')
    .trim()

const escapeHtml = (text) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
