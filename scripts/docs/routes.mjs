import { createHash } from 'node:crypto'
import { posix } from 'node:path'

/*
 * Where a file in this repository lands in the site, and where a link in it
 * points once it gets there.
 *
 * One module because four things need the same answer and disagreeing is
 * invisible: the page emitter names the file, the link rewriter rewrites into
 * it, the navigation orders it, and the sitemap advertises it. A rewriter that
 * mapped `docs/design/README.md` to `/docs/design/readme` while the emitter
 * wrote `/docs/design` produces a site whose internal links all 404 and whose
 * every page renders correctly — nothing errors, and nothing works.
 *
 * **The route mirrors the repository path.** That is a decision rather than a
 * convenience: the source of every page in this site is a markdown file a
 * contributor edits by hand, those files link to each other by relative path,
 * and any mapping that is not mechanical is a mapping the rewriter has to be
 * told about one link at a time. Editorial grouping happens in `wings.mjs`,
 * over these routes, so a page can be filed under "Start Here" while still
 * living at `/docs/guides/getting-started`.
 */

/** Everything the site serves hangs off this. Mirrors `pages/paths.ts`. */
export const DOCS = '/docs'

/** Where a file that is not in the site is read instead. */
const REPOSITORY = 'https://github.com/jonjaques/inertialref'
const BRANCH = 'main'

/**
 * The files outside `docs/` that are part of the documentation anyway.
 *
 * `AGENTS.md` is the working card — every page under `docs/agents/` links to
 * it, `docs/README.md` links to it twice, and a documentation site that
 * answered those links with a hop to GitHub would be sending the reader out of
 * the building to read the one page the rest of them are about. Named after
 * what its own first line calls it.
 *
 * Nothing else joins it. `CONTEXT.md` is a dated build log written to itself,
 * `README.md` is the front door this site already is, and `PRODUCT.md` and
 * `DESIGN.md` are working artifacts rather than documents — all four are
 * one `linkFor` hop away on GitHub, which is where they read correctly.
 */
const ADOPTED = new Map([['AGENTS.md', `${DOCS}/working-card`]])

/**
 * The route for a repository path, or `null` when the file is not in the site.
 *
 * `null` is the interesting return: it is what turns a relative link into a
 * link to GitHub rather than into a dead internal route, and it is why this
 * function does not throw on an unknown path. A document may legitimately point
 * at a source file, a data manifest or a script, and all three are real
 * destinations that simply are not pages here.
 */
export function routeFor(repoPath) {
  const path = normalize(repoPath)
  const adopted = ADOPTED.get(path)
  if (adopted !== undefined) return adopted
  if (!path.startsWith('docs/') || !path.endsWith('.md')) return null

  // `docs/README.md` is the site's own front page, and `docs/design/README.md`
  // is the design bible's — a README names the directory it is in rather than
  // itself, so it takes the directory's route and `/readme` never appears.
  const stem = path.slice('docs/'.length).replace(/\.md$/, '')
  const withoutIndex = stem.replace(/(^|\/)README$/, '')
  const slug = withoutIndex
    .split('/')
    .filter((part) => part.length > 0)
    // `STYLE.md` is the one shouted filename in `docs/`, and a URL is read
    // aloud and typed. Lowercasing here rather than renaming the file keeps the
    // repository's own convention — a document about writing, named the way the
    // repository names its own conventions — out of the address bar.
    .map((part) => part.toLowerCase())
    .join('/')
  return slug === '' ? DOCS : `${DOCS}/${slug}`
}

/**
 * Where a link written inside `from` should point.
 *
 * Returns `{ href, external }`. Everything a markdown file can write is handled
 * here rather than at three call sites, because the interesting cases are all
 * the ones that do not look like links to documents:
 *
 *   - `#section`               an anchor within the page, left alone
 *   - `concepts/frames.md`     relative to the *file*, not to the site
 *   - `../AGENTS.md#rules`     resolved, then mapped, anchor carried through
 *   - `../../data/models/`     a real path that is not a page — GitHub
 *   - `https://…`, `mailto:`   external, untouched
 *
 * The GitHub fallback is what makes the site safe to generate from a directory
 * nobody wrote for it. Every one of the seventy files here links to source,
 * scripts and data as a matter of course, and the alternative to sending those
 * somewhere real is a documentation site full of links that look live and are
 * not.
 */
export function linkFor(href, from) {
  if (href.startsWith('#')) return { href, external: false }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))
    return { href, external: true }
  // Already a site path — a document that knows where it is being published.
  if (href.startsWith('/')) return { href, external: false }

  const hash = href.indexOf('#')
  const target = hash === -1 ? href : href.slice(0, hash)
  const anchor = hash === -1 ? '' : href.slice(hash)
  const resolved = normalize(posix.join(posix.dirname(from), target))

  const route = routeFor(resolved)
  if (route !== null) return { href: `${route}${anchor}`, external: false }

  /*
   * A second reading, for links written inside source comments rather than
   * inside `docs/`.
   *
   * A comment in `packages/universe/src/galaxy.ts` that writes
   * `docs/design/galaxy.md` means the path from the repository root — it is how
   * every comment in this codebase names a document, because that is how the
   * document is found by anyone reading the file. Resolved against the *file*
   * it would be `packages/universe/src/docs/design/galaxy.md`, which is
   * nothing, so a link that only resolves from the root is taken as one.
   *
   * It cannot fire for a genuine relative link: `../adr/README.md` from a
   * document already resolved above, and a path that resolves both ways is one
   * that names a real file either way, in which case the file-relative reading
   * has already won.
   */
  const fromRoot = routeFor(normalize(target))
  if (fromRoot !== null)
    return { href: `${fromRoot}${anchor}`, external: false }

  /*
   * A directory link keeps its trailing slash, because GitHub's `tree` and
   * `blob` are different URLs and guessing wrong renders a 404 rather than a
   * listing. The markdown says which it meant — `docs/adr/` is a directory and
   * `docs/adr/README.md` is a file — so the slash is the whole signal.
   */
  const kind = target.endsWith('/') || resolved.endsWith('/') ? 'tree' : 'blob'
  return {
    href: `${REPOSITORY}/${kind}/${BRANCH}/${trimSlash(resolved)}${anchor}`,
    external: true,
  }
}

/** Where the reader edits the page they are looking at. */
export const sourceUrl = (repoPath) =>
  `${REPOSITORY}/blob/${BRANCH}/${normalize(repoPath)}`

/**
 * The file a route's content is written to, as one flat name.
 *
 * Flat rather than nested so the output is a directory of pages rather than a
 * second copy of the repository's tree, and **lowercase with a digest of the
 * route on the end**, which is the half that is not cosmetic.
 *
 * The reference exports `Vec3` and `vec3`, `Session` and `session`, and
 * twenty-two more pairs that differ only in case. On APFS and NTFS those are
 * one filename, so the second page written silently replaced the first — 902
 * pages produced 878 files, and the twenty-four that vanished were whichever
 * of each pair happened to be written second. On Linux, where CI and the
 * deploy build run, all 902 survive. A generator whose output depends on the
 * developer's filesystem is a generator whose output cannot be checked.
 *
 * The digest also means nothing has to agree about the escaping rules: the
 * manifest carries each page's filename, so the client looks a name up rather
 * than deriving one, and there is no second implementation of this function to
 * drift from it.
 */
export const assetName = (route) => {
  const stem =
    route === DOCS
      ? 'index'
      : route.slice(`${DOCS}/`.length).replace(/\//g, '-')
  const hash = createHash('sha256').update(route).digest('hex').slice(0, 5)
  return `${stem.toLowerCase()}-${hash}.json`
}

const normalize = (path) => posix.normalize(path).replace(/^\.\//, '')
const trimSlash = (path) => path.replace(/\/+$/, '')
