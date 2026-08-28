import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assetName, DOCS, linkFor, routeFor } from './routes.mjs'
import { documentsUnderDocs, listedPages, WINGS } from './wings.mjs'

/*
 * The two halves of the documentation build that can be wrong silently.
 *
 * A markdown renderer that breaks announces itself: the page is empty. These do
 * not. A link that resolves to the wrong route renders as a link, in the right
 * colour, with the right words on it, and goes to a page that is not the one
 * the author wrote down — and a document nobody filed lands in no wing and is
 * absent from a navigation that looks complete.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

describe('the route a file gets', () => {
  it('mirrors the path under docs/', () => {
    expect(routeFor('docs/concepts/frames.md')).toBe(`${DOCS}/concepts/frames`)
    expect(routeFor('docs/vision.md')).toBe(`${DOCS}/vision`)
  })

  it('gives a README the name of its directory, never its own', () => {
    expect(routeFor('docs/README.md')).toBe(DOCS)
    expect(routeFor('docs/design/README.md')).toBe(`${DOCS}/design`)
    expect(routeFor('docs/adr/README.md')).toBe(`${DOCS}/adr`)
  })

  it('lowercases, because a URL is typed and read aloud', () => {
    expect(routeFor('docs/STYLE.md')).toBe(`${DOCS}/style`)
  })

  it('adopts the working card and nothing else outside docs/', () => {
    expect(routeFor('AGENTS.md')).toBe(`${DOCS}/working-card`)
    expect(routeFor('CONTEXT.md')).toBeNull()
    expect(routeFor('README.md')).toBeNull()
    expect(routeFor('packages/spatial/src/index.ts')).toBeNull()
  })
})

describe('where a link in a document points', () => {
  it('resolves against the file, not against the site', () => {
    expect(linkFor('../adr/README.md', 'docs/concepts/frames.md')).toEqual({
      href: `${DOCS}/adr`,
      external: false,
    })
  })

  it('carries the anchor through the mapping', () => {
    expect(
      linkFor('../concepts/determinism.md#the-rule', 'docs/guides/testing.md'),
    ).toEqual({
      href: `${DOCS}/concepts/determinism#the-rule`,
      external: false,
    })
  })

  it('leaves a bare fragment alone', () => {
    expect(linkFor('#accuracy', 'docs/README.md')).toEqual({
      href: '#accuracy',
      external: false,
    })
  })

  /*
   * The rule that keeps a documentation site honest about what it does not
   * contain. Every one of these seventy files links to source, to scripts and
   * to data as a matter of course, and the alternative to sending those to
   * GitHub is a page full of links that look live and are not.
   */
  it('sends a path that is not a page to the repository', () => {
    const source = linkFor(
      '../../packages/devtools/src/shots.ts',
      'docs/agents/driving.md',
    )
    expect(source.external).toBe(true)
    expect(source.href).toContain('/blob/main/packages/devtools/src/shots.ts')
  })

  it('keeps a directory a tree and a file a blob', () => {
    expect(linkFor('../adr/', 'docs/concepts/frames.md').href).toContain(
      '/tree/main/docs/adr',
    )
  })

  /*
   * A comment in `packages/universe/src/galaxy.ts` writing `docs/design/galaxy.md`
   * means the path from the repository root, which is how every comment in this
   * codebase names a document. Read against the file it would be
   * `packages/universe/src/docs/design/galaxy.md`, which is nothing.
   */
  it('reads a repository path in a source comment as one', () => {
    expect(
      linkFor('docs/design/galaxy.md', 'packages/universe/src/galaxy.ts'),
    ).toEqual({ href: `${DOCS}/design/galaxy`, external: false })
  })

  it('does not touch an absolute URL', () => {
    expect(linkFor('https://example.test/x', 'docs/README.md')).toEqual({
      href: 'https://example.test/x',
      external: true,
    })
  })
})

/*
 * The reference exports `Vec3` and `vec3`, `Session` and `session`, and
 * twenty-two more pairs that differ only in case. On APFS and NTFS those are
 * one filename, so 905 pages produced 881 files and the twenty-four that
 * vanished were whichever of each pair was written second — on Linux, where CI
 * and the deploy build run, all 905 survived. A generator whose output depends
 * on the developer's filesystem is a generator whose output cannot be checked.
 */
describe('the file a page is written to', () => {
  it('separates two routes that differ only in case', () => {
    const upper = assetName(`${DOCS}/api/spatial/Vec3`)
    const lower = assetName(`${DOCS}/api/spatial/vec3`)
    expect(upper).not.toBe(lower)
    expect(upper.toLowerCase()).not.toBe(lower)
  })

  it('is lowercase, so no two of them can collide on a case-blind disk', () => {
    const name = assetName(`${DOCS}/api/spatial/UniverseVector`)
    expect(name).toBe(name.toLowerCase())
  })

  it('is stable for a route', () => {
    expect(assetName(`${DOCS}/concepts/frames`)).toBe(
      assetName(`${DOCS}/concepts/frames`),
    )
  })
})

describe('the wing table', () => {
  it('claims every markdown file under docs/', async () => {
    const claimed = new Set(listedPages().map((entry) => entry.path))
    const found = await documentsUnderDocs(ROOT)
    expect(found.filter((path) => !claimed.has(path))).toEqual([])
  })

  it('claims each file once, and gives each one a route', () => {
    const routes = listedPages().map((entry) => {
      const route = routeFor(entry.path)
      expect(route, entry.path).not.toBeNull()
      return route
    })
    expect(new Set(routes).size).toBe(routes.length)
  })

  /* A wing with no framing is a masthead with no camera, which is a black band
     at the top of every page in it. */
  it('gives every wing a framing and a blurb', () => {
    for (const wing of WINGS) {
      expect(wing.blurb.length, wing.id).toBeGreaterThan(20)
      expect(wing.framing.address, wing.id).toMatch(/^s:/)
      expect(wing.framing.fill, wing.id).toBeGreaterThan(0)
    }
  })
})
