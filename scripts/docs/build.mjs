import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  Application,
  PackageJsonReader,
  TSConfigReader,
  TypeDocReader,
} from 'typedoc'
import { buildReference } from './api.mjs'
import { loadHighlighter } from './highlight.mjs'
import { renderMarkdown } from './markdown.mjs'
import { assetName, routeFor, sourceUrl } from './routes.mjs'
import { allWings, documentsUnderDocs, listedPages } from './wings.mjs'

/*
 * The documentation build.
 *
 * Seventy markdown files and the whole of `packages/*` go in; JSON comes out.
 * It runs once, by hand (`pnpm docs:build`) or as the first step of
 * `pnpm build`, and it is deliberately not a watcher: the corpus changes when
 * somebody edits a document, which is not something a dev server needs to
 * notice within a frame.
 *
 * ## Two directories, because they are two kinds of input
 *
 * `apps/game/.doc-content/` is a **build input**. Astro's `getStaticPaths`
 * reads the manifest and the page bodies at build time and emits a real
 * HTML document per route. It is gitignored because it is derived:
 * committing it would be a second copy of the documentation that drifts
 * from the first.
 *
 * `apps/game/public/doc-content/` is a **runtime fetch**. The search index
 * lives only here — half a megabyte for the readers who type and nobody
 * else. The manifest and the page bodies are written here too, because
 * the chrome island loads them over the network. Bundling nine hundred
 * and five page bodies is the alternative that does not work: a module
 * graph that size is a chunk manifest larger than most of the pages.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** Build input for Astro. Page bodies and the manifest. */
const STAGED = join(ROOT, 'apps/game/.doc-content')
/** Runtime fetch. Search, and (still) the manifest and page bodies. */
const PUBLIC = join(ROOT, 'apps/game/public/doc-content')

const quiet = process.argv.includes('--quiet')
const skipApi = process.argv.includes('--no-api')
const dumpAt = argumentAfter('--dump-api')

async function main() {
  const started = process.hrtime.bigint()
  await loadHighlighter()

  const serialized = skipApi ? null : await convert()
  const prose = await renderProse()
  const reference =
    serialized === null
      ? { pages: [], groups: [] }
      : buildReference(serialized, await packageDescriptions())

  const pages = [...prose, ...reference.pages]
  const wings = allWings(reference.groups)

  await rm(STAGED, { recursive: true, force: true })
  await rm(PUBLIC, { recursive: true, force: true })
  await mkdir(join(STAGED, 'page'), { recursive: true })
  await mkdir(join(PUBLIC, 'page'), { recursive: true })

  /*
   * The body of every page, one file each, written before the manifest that
   * indexes them.
   *
   * The order matters on a live origin, for the same reason it matters in a
   * migration: a manifest that lands before the pages it names is a navigation
   * full of links to files that are not there, and only one of the two orders
   * recovers on its own.
   */
  await Promise.all(
    pages.map((page) => {
      const body = {
        route: page.route,
        title: page.title,
        lead: page.lead,
        kind: page.kind ?? 'prose',
        html: page.html,
        headings: page.headings,
        words: page.words,
        diagrams: page.diagrams,
        source: page.source ?? null,
        packageName: page.packageName ?? null,
        memberKind: page.memberKind ?? null,
      }
      const name = assetName(page.route)
      return Promise.all([
        writeJson(join(STAGED, 'page', name), body),
        writeJson(join(PUBLIC, 'page', name), body),
      ])
    }),
  )

  const manifest = {
    /*
     * A digest of everything the manifest describes, so a client can tell one
     * build's content from another's without a wall clock in the output. A
     * timestamp changes on every build, which would make every deploy look like
     * a content change to anything comparing them.
     */
    version: digest(pages),
    /*
     * The navigation, in routes.
     *
     * `wings.mjs` lists repository paths, because that is what an editor picking
     * up the file has in front of them and what `assertNothingUnlisted` checks
     * against. The client has never heard of `docs/concepts/frames.md` — it
     * knows `/docs/concepts/frames` — so the mapping happens exactly here, on
     * the way out, and `routeFor` is the only thing that does it.
     *
     * The reference's groups arrive already in routes: `api.mjs` has no
     * repository paths to start from.
     */
    wings: wings.map((wing) => ({
      id: wing.id,
      label: wing.label,
      blurb: wing.blurb,
      framing: wing.framing,
      /* Where the wing's own name points. Its first page, unless it has a
         landing page that is about the wing rather than in it. */
      home:
        wing.home ?? asRoute(wing.groups[0]?.head ?? wing.groups[0]?.pages[0]),
      groups: wing.groups.map((group) => ({
        label: group.label ?? null,
        head: group.head ?? null,
        pages: group.pages.map(asRoute),
      })),
    })),
    /*
     * What the navigation, the breadcrumb and the document title need, and
     * nothing else.
     *
     * This object is fetched before anything can be drawn, so every field in it
     * is paid for on the way in. The lead, the word count and the diagram count
     * were here and are not: each is read on exactly one screen, and that screen
     * has already fetched the page that carries them. Dropping the three took
     * the manifest from 286 KB to 181 KB.
     */
    pages: Object.fromEntries(
      pages.map((page) => [
        page.route,
        {
          title: page.title,
          label: page.label ?? page.title,
          wing: page.wing ?? 'api',
          kind: page.kind ?? 'prose',
          asset: assetName(page.route),
        },
      ]),
    ),
    counts: {
      pages: pages.length,
      documents: prose.length,
      words: prose.reduce((total, page) => total + page.words, 0),
      diagrams: prose.reduce((total, page) => total + page.diagrams, 0),
      packages: reference.groups.length,
      exports: reference.pages.filter((page) => page.kind === 'api-member')
        .length,
    },
  }

  await writeJson(join(STAGED, 'manifest.json'), manifest)
  await writeJson(join(PUBLIC, 'manifest.json'), manifest)
  await writeJson(join(PUBLIC, 'search.json'), searchIndex(pages, manifest))

  if (dumpAt !== null && serialized !== null)
    await writeJson(join(ROOT, dumpAt), serialized)

  const ms = Number(process.hrtime.bigint() - started) / 1e6
  if (!quiet)
    console.log(
      `docs: ${manifest.counts.pages} pages ` +
        `(${manifest.counts.documents} documents, ${manifest.counts.exports} exports ` +
        `across ${manifest.counts.packages} packages), ` +
        `${manifest.counts.words.toLocaleString('en-US')} words, ` +
        `${manifest.counts.diagrams} diagrams, in ${ms.toFixed(0)} ms`,
    )
}

/* ------------------------------------------------------------------------- */
/* Prose                                                                      */
/* ------------------------------------------------------------------------- */

async function renderProse() {
  const listed = listedPages()
  await assertNothingUnlisted(listed)

  const seen = new Set()
  const pages = []
  for (const entry of listed) {
    const route = routeFor(entry.path)
    if (route === null)
      throw new Error(
        `${entry.path} is listed in scripts/docs/wings.mjs and has no route. ` +
          'Only files under docs/, and the ones routes.mjs adopts by name, can be pages.',
      )
    if (seen.has(route))
      throw new Error(`two entries claim ${route} (${entry.path})`)
    seen.add(route)

    const source = await readFile(join(ROOT, entry.path), 'utf8')
    const rendered = renderMarkdown(source, entry.path)
    /*
     * A document with no `# heading` has no title, and `null` propagates
     * further than it looks: the manifest carries it, the masthead and the
     * breadcrumb both `??` it into "Not Found" on a page that loaded, and
     * `searchDocs` lowercases every row's title on every keystroke — so one
     * untitled page is search returning nothing for every query, with a
     * `TypeError` in the console as the only sign. The wing table gates a file
     * nobody filed; this gates a file nobody named.
     */
    if ((entry.title ?? rendered.title) === null)
      throw new Error(
        `${entry.path} has no level-one heading, so it has no title. ` +
          'Give it a `# Title` line, or name it in scripts/docs/wings.mjs.',
      )
    pages.push({
      ...rendered,
      route,
      /*
       * The rail's label may be shorter than the document's own title. An ADR
       * is "Universe Coordinates" in a list of sixteen of them and
       * "ADR-0001: Universe coordinates are sectorized fixed-point plus a
       * double offset" at the top of its own page, and both are right for
       * where they are.
       */
      label: entry.label ?? rendered.title,
      title: entry.title ?? rendered.title,
      wing: entry.wing,
      group: entry.group,
      source: sourceUrl(entry.path),
      kind: 'prose',
    })
  }
  return pages
}

/**
 * A markdown file under `docs/` that no wing claims.
 *
 * A build error rather than a warning, and rather than a guess. The failure it
 * prevents is the quiet one: somebody adds `docs/concepts/lighting.md`,
 * everything passes, the site deploys, and the document is nowhere. It is
 * reachable only by a link from another page, absent from the navigation and
 * from search, with nothing anywhere saying so. A line in `wings.mjs` is the
 * price of the site being the documentation rather than most of it.
 */
async function assertNothingUnlisted(listed) {
  const claimed = new Set(listed.map((entry) => entry.path))
  const found = await documentsUnderDocs(ROOT)

  const missing = found.filter((path) => !claimed.has(path)).sort()
  if (missing.length > 0)
    throw new Error(
      `${missing.length} document(s) under docs/ are in no wing:\n` +
        missing.map((path) => `  ${path}`).join('\n') +
        '\nAdd each to scripts/docs/wings.mjs, in the wing it belongs to.',
    )
}

/* ------------------------------------------------------------------------- */
/* The reference                                                              */
/* ------------------------------------------------------------------------- */

/**
 * TypeDoc, through its Node API rather than its command line.
 *
 * The command line's job here would be to write a file this build reads back
 * immediately, and it is 2.2 MB of it. `typedoc.json` is picked up either way,
 * because `TypeDocReader` is what reads it. Nothing is lost; what is gained is
 * that a conversion failure arrives as a thrown exception with a stack rather
 * than as an exit code and a missing file.
 *
 * **`validate` is a second call and not a setting.** `typedoc.json` asks for
 * `validation.invalidLink`, which is what makes `{@link Observatory}` pointing
 * at a renamed symbol a build failure rather than words that link nowhere — but
 * `convert()` does not run it. Only `app.validate(project)` does, and it
 * reports through the logger rather than by throwing, so the count has to be
 * read afterwards. Left out, the option is configured and inert: a broken
 * cross-reference converts cleanly, emits no warning, and ships.
 */
async function convert() {
  const app = await Application.bootstrapWithPlugins({}, [
    new TypeDocReader(),
    new PackageJsonReader(),
    new TSConfigReader(),
  ])
  const project = await app.convert()
  if (project === undefined)
    throw new Error(
      'TypeDoc could not convert packages/*. Run `pnpm exec typedoc` for the diagnostics.',
    )
  app.validate(project)
  if (app.logger.hasErrors() || app.logger.hasWarnings())
    throw new Error(
      'TypeDoc reported the problems above. A `{@link}` naming a symbol that ' +
        'no longer exists is the common one — fix what points at it, or rename ' +
        'the target back.',
    )
  return app.serializer.projectToObject(project, ROOT)
}

/**
 * What each package says it is, from its own `package.json`.
 *
 * TypeDoc does not carry it: a module's comment comes from a `@module` block in
 * the source, and there is not one in any of the twelve `index.ts` files —
 * the sentence that describes the package is in the manifest beside it, which
 * is also where `pnpm` and npm read it from. Without this the reference's index
 * is a list of twelve names and a count, which is a directory listing rather
 * than a page.
 */
async function packageDescriptions() {
  const described = new Map()
  for (const item of await readdir(join(ROOT, 'packages'), {
    withFileTypes: true,
  })) {
    if (!item.isDirectory()) continue
    const manifest = JSON.parse(
      await readFile(join(ROOT, 'packages', item.name, 'package.json'), 'utf8'),
    )
    if (typeof manifest.description === 'string')
      described.set(manifest.name, manifest.description)
  }
  return described
}

/* ------------------------------------------------------------------------- */
/* Search                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * One row per page, small enough to fetch and match in the browser without a
 * server and without a second dependency.
 *
 * The body field holds a page's *vocabulary* rather than its prose:
 * deduplicated, lowercased, sorted. The corpus is a hundred and twenty-two
 * thousand words and its distinct words are a fraction of that, because a
 * document that is about reference frames says "frame" forty times and an index
 * needs to know it once. That is the difference between a full-text index of
 * this corpus being a file worth downloading and one worth paginating.
 *
 * What it gives up is phrase matching: the index knows `reference` and `frame`
 * both occur on a page, not that they occur together. The ranking below
 * recovers most of that, because a title hit outranks a heading hit outranks a
 * body hit, and the honest alternative is a positional index four times the
 * size for a query nobody types.
 */
function searchIndex(pages, manifest) {
  return {
    version: manifest.version,
    /*
     * The stop list travels with the index it was applied to.
     *
     * A word dropped from every page's vocabulary and *not* dropped from the
     * query is a word no page can match, and because the matcher is an `AND`
     * that is one word poisoning a whole query: "the harness" returned nothing,
     * because `the` is in no page's vocabulary by construction. Shipping the
     * list is what keeps the two ends from having separate opinions about which
     * words locate a page.
     */
    stop: [...STOP],
    rows: pages.map((page) => ({
      r: page.route,
      t: page.title,
      w: page.wing ?? 'api',
      k: page.kind ?? 'prose',
      l: page.lead,
      /* Anchor and text together, so a result can land on the section that
         matched rather than at the top of the page it is in. The anchors are
         GitHub's slugs, which the client has no way to re-derive — that is the
         whole reason they travel. */
      h: (page.headings ?? []).map((heading) => [heading.id, heading.text]),
      b: vocabulary(page.text ?? ''),
    })),
  }
}

/** The distinct words of a page, lowercased, sorted, space-separated. */
function vocabulary(text) {
  const words = new Set()
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    if (!STOP.has(word)) words.add(word)
  return [...words].sort().join(' ')
}

/*
 * The words that are in every document and therefore locate none of them.
 *
 * Short, and English only, on purpose: a long stop list is a list of words
 * somebody is eventually going to search for. `set`, `get`, `state` and `time`
 * are deliberately not on it, because in this corpus every one of them is a
 * term.
 */
const STOP = new Set(
  (
    'the and for that with this from are was were has have had not but they you ' +
    'its it is be been being can could would should will may might must one two ' +
    'all any each every some there their them then than when where which while ' +
    'what who whom how why into onto over under about after before between ' +
    'because both such only same other more most much many few own too very'
  ).split(' '),
)

/* ------------------------------------------------------------------------- */
/* Writing                                                                    */
/* ------------------------------------------------------------------------- */

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

/**
 * A wing entry, as the route the client asks for.
 *
 * Accepts what `wings.mjs` writes — a path, or a `[path, label]` pair — and
 * what `api.mjs` writes, which is already a route. A path that resolves to
 * nothing is a wing entry pointing at a file that is not a page, and the build
 * says so rather than emitting a link to it.
 */
function asRoute(entry) {
  const path = Array.isArray(entry) ? entry[0] : entry
  if (path.startsWith('/docs')) return path
  const route = routeFor(path)
  if (route === null)
    throw new Error(`${path} is in a wing and is not a page in this site`)
  return route
}

const digest = (pages) =>
  createHash('sha256')
    .update(pages.map((page) => `${page.route}:${page.html}`).join(' '))
    .digest('hex')
    .slice(0, 12)

function argumentAfter(flag) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

/*
 * A failure reads as one line before it reads as a stack. This build is run by
 * a person, and which of its two halves broke is the thing they need first; the
 * stack is still printed underneath.
 */
main().catch((cause) => {
  console.error(`\ndocs: ${cause.message}\n`)
  console.error(cause)
  process.exitCode = 1
})
