import { createHighlighter } from 'shiki'

/*
 * Syntax colour, in a system that has one accent.
 *
 * A stock highlighter brings six or seven hues, and `DESIGN.md`'s One Accent
 * Rule says Instrument Blue is the only non-status colour in the interface — so
 * dropping a Dracula-coloured listing into a documentation page is not a small
 * inconsistency, it is the largest single block of colour on the page
 * disagreeing with everything around it.
 *
 * The theme below spends **two hues and the graphite ramp**, and each one is
 * assigned to what the system already means by it:
 *
 *   Instrument Blue   the language itself — `const`, `export`, `if`, and the
 *                     names of types. The accent is what the instrument uses
 *                     when it is speaking, and in a listing the words the
 *                     language owns are the part that is not yours.
 *   Nominal Green     every literal: a string, a number, a boolean, a regex.
 *                     The status hue for "a real value is present", which is
 *                     exactly what a literal is. It is the one status colour
 *                     that earns a place here, and it earns it by being
 *                     consistent — every literal, never anything else.
 *   Graphite 100      a name being *declared*. The brightest neutral, for the
 *                     thing the block is about.
 *   Graphite 300      everything else you wrote.
 *   Graphite 400      punctuation, operators and comments — comments separated
 *                     from punctuation by italic rather than by a third grade,
 *                     because 400 is this system's ink floor and there is no
 *                     grade below it that stays legible.
 *
 * The Scarcity Rule survives because green means one thing here and appears
 * only where that thing is. A listing where half the tokens are amber is a
 * listing where amber has stopped meaning anything, which is the failure the
 * rule exists to prevent.
 */
const THEME = {
  name: 'inertialref',
  type: 'dark',
  // No background: the block draws its own in `index.css`, where the alpha can
  // be tuned against the reading plate it sits on. A hex baked in here would be
  // an opaque rectangle inside a translucent surface.
  colors: { 'editor.foreground': '#cbd5e1' },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: '#94a3b8', fontStyle: 'italic' },
    },
    {
      scope: [
        'punctuation',
        'meta.brace',
        'keyword.operator',
        'punctuation.separator',
        'punctuation.terminator',
      ],
      settings: { foreground: '#94a3b8' },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.control',
        'variable.language',
        'constant.language',
        'entity.name.tag',
        'markup.heading',
      ],
      settings: { foreground: '#7dd3fc' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
        'entity.other.attribute-name',
        'meta.decorator',
        'entity.name.function.decorator',
      ],
      settings: { foreground: '#bae6fd' },
    },
    {
      scope: [
        'string',
        'string.quoted',
        'string.template',
        'constant.numeric',
        'constant.character',
        'constant.other.symbol',
        'string.regexp',
        'markup.inserted',
      ],
      settings: { foreground: '#6ee7b7' },
    },
    {
      scope: [
        'entity.name.function',
        'entity.name.class',
        'entity.name.namespace',
        'support.function',
        'meta.function-call.generic',
      ],
      settings: { foreground: '#f1f5f9' },
    },
    {
      scope: [
        'variable',
        'meta.definition.variable',
        'variable.other.readwrite',
      ],
      settings: { foreground: '#cbd5e1' },
    },
    {
      scope: [
        'variable.other.property',
        'meta.object-literal.key',
        'support.variable',
      ],
      settings: { foreground: '#cbd5e1' },
    },
    { scope: ['markup.deleted'], settings: { foreground: '#fda4af' } },
  ],
}

/**
 * The languages the corpus actually contains, plus the ones an API comment can
 * reasonably reach for.
 *
 * Enumerated rather than loading everything, because a Shiki bundle with every
 * grammar in it is 40 MB of build-time load for a corpus whose fences are
 * ninety per cent TypeScript and shell.
 */
const LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'jsonc',
  'bash',
  'shell',
  'css',
  'html',
  'yaml',
  'toml',
  'sql',
  'cpp',
  'glsl',
  'wgsl',
  'diff',
  'markdown',
  'ini',
]

/** Fences that name a language this build does not carry, spelled another way. */
const ALIAS = new Map([
  ['ts', 'typescript'],
  ['js', 'javascript'],
  ['sh', 'bash'],
  ['zsh', 'bash'],
  ['console', 'bash'],
  ['yml', 'yaml'],
  ['md', 'markdown'],
  ['c++', 'cpp'],
  ['text', 'plaintext'],
  ['txt', 'plaintext'],
  ['', 'plaintext'],
])

let highlighter = null

export async function loadHighlighter() {
  highlighter ??= await createHighlighter({
    themes: [THEME],
    langs: LANGUAGES,
  })
  return highlighter
}

/** What a fence's language tag resolves to, and whether anything knows it. */
export function languageFor(tag) {
  const named = (tag ?? '').trim().toLowerCase().split(/\s+/)[0] ?? ''
  const resolved = ALIAS.get(named) ?? named
  return LANGUAGES.includes(resolved) ? resolved : 'plaintext'
}

/**
 * One highlighted block, as the markup the article renders.
 *
 * Shiki writes its own background and colour onto the `<pre>`; both are
 * stripped, because the block's ground has to be an alpha over whatever the
 * reading plate is over, and a baked hex is an opaque hole in it.
 *
 * The copy control is emitted here rather than mounted by React. The article's
 * body is generated HTML with no component tree inside it, so the alternative
 * is hydrating a fragment — and one delegated click handler on the article
 * (`docs/DocArticle.tsx`) does the same job with nothing to hydrate.
 */
export function codeBlock(code, tag) {
  const lang = languageFor(tag)
  const html = highlighter.codeToHtml(code, {
    lang,
    theme: 'inertialref',
    transformers: [
      {
        pre(node) {
          node.properties['style'] = undefined
          node.properties['tabindex'] = '0'
        },
      },
    ],
  })
  const label = lang === 'plaintext' ? '' : lang
  return (
    `<figure class="doc-code" data-lang="${escapeAttribute(label)}">` +
    `<button type="button" class="doc-copy" data-copy aria-label="Copy this block">` +
    COPY_ICON +
    `</button>` +
    html +
    `</figure>`
  )
}

/*
 * Lucide's `copy`, inlined.
 *
 * The rest of the interface imports these from `lucide-react`, which is not
 * reachable from a build script writing a string of HTML. Same 24-grid, same
 * 1.5 stroke, so the control matches every other icon in the interface —
 * `DESIGN.md` bans a Unicode glyph standing in for an icon, and a mismatched
 * stroke weight is the same failure one step further in.
 */
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
  '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'

export const escapeAttribute = (text) =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
