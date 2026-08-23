import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SITE } from '../../apps/game/src/site.ts'
import { checkPublicSurface, headOf, metaTags } from './checkHead.mjs'

/*
 * A gate that cannot fail is not a gate.
 *
 * Half of this file is the gate passing against the real files, which is what
 * `pnpm check` runs. The other half is the gate failing against a head with one
 * thing wrong in it — each case a way the static head has drifted or nearly
 * drifted from `src/site.ts`, since nothing has ever compared them.
 */

const ROOT = new URL('../../', import.meta.url)
const HTML = readFileSync(new URL('apps/game/index.html', ROOT), 'utf8')
const SW = readFileSync(new URL('apps/game/public/sw.js', ROOT), 'utf8')
const PUBLIC_FILES = new Set(readdirSync(new URL('apps/game/public/', ROOT)))

/**
 * The real sources with one substitution applied, everywhere it appears.
 *
 * `replaceAll`, because the head repeats itself on purpose — the description is
 * written three times and the title twice — and a realistic drift is `site.ts`
 * moving while every copy in the head stays behind.
 */
const drifted = (from, to, sources = {}) =>
  checkPublicSurface({
    html: HTML.replaceAll(from, to),
    sw: SW,
    publicFiles: PUBLIC_FILES,
    ...sources,
  })

describe('the static head', () => {
  it('agrees with src/site.ts as committed', () => {
    expect(
      checkPublicSurface({ html: HTML, sw: SW, publicFiles: PUBLIC_FILES }),
    ).toEqual([])
  })

  it('reads past the commentary that quotes the tags it explains', () => {
    // The head's own comments contain `<title>` and the word `og:title`. An
    // extractor that does not strip comments reads four hundred words of prose
    // as the page's title and then reports the real one as missing.
    const head = headOf(HTML)
    expect(head).not.toContain('<!--')
    expect(metaTags(head).get('og:type')).toBe('website')
  })
})

describe('the gate can fail', () => {
  it('catches a title that no longer matches documentTitle', () => {
    const problems = drifted(
      '<title>InertialRef — A real sky, in a browser tab</title>',
      '<title>InertialRef</title>',
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('<title>')
  })

  it('catches a canonical that moved', () => {
    // The near miss this exists for: `d4f4065` fixed `canonicalUrl` to drop a
    // trailing slash. The generated sitemap fixed itself; the hand-typed
    // canonical was right by luck.
    const problems = drifted(
      `<link rel="canonical" href="${SITE.origin}" />`,
      `<link rel="canonical" href="${SITE.origin}/" />`,
    )
    expect(problems.join(' ')).toContain('canonical')
  })

  it('catches this site under a name that is not SITE.origin', () => {
    const problems = drifted(
      `<meta property="og:url" content="${SITE.origin}" />`,
      '<meta property="og:url" content="https://inertialrefd.jaquers.workers.dev" />',
    )
    expect(problems.join(' ')).toContain('not SITE.origin')
  })

  it('catches a host the head is not declared to use', () => {
    const problems = drifted(
      'https://schema.org',
      'https://cdn.example.com/schema',
    )
    expect(problems.join(' ')).toContain('not declared to use')
  })

  it('catches a padded description', () => {
    // The bound `site.test.ts` holds every PageMeta to, applied for the first
    // time to the strings a search result actually shows.
    const problems = drifted(
      'content="An open-source spaceflight simulator that runs in a browser tab. The Milky Way is the real one, derived rather than downloaded."',
      `content="${'x'.repeat(200)}"`,
    )
    expect(problems.join(' ')).toMatch(/twitter:description is 200 characters/)
  })

  it('catches a description that drifted from SITE.description', () => {
    const problems = drifted(
      SITE.description,
      SITE.description.replace('7,123', '7,124'),
    )
    // Both the meta and the og tag carry it, so both report.
    expect(problems).toHaveLength(2)
    expect(problems.join(' ')).toContain('SITE.description')
  })

  it('catches a theme-color that is no longer the page background', () => {
    const problems = drifted(
      `<meta name="theme-color" content="${SITE.background}" />`,
      '<meta name="theme-color" content="#000000" />',
    )
    expect(problems.join(' ')).toContain('theme-color')
  })

  it('catches a tag the extraction cannot see', () => {
    /*
     * The census. The extraction is regex over HTML, so a tag it cannot parse
     * is a tag it silently reports as correct — which is the failure mode that
     * makes a checker worse than nothing.
     */
    const problems = drifted(
      '<meta property="og:locale" content="en" />',
      '<meta property="og:locale" content="en" /><meta name="keywords" content="space" />',
    )
    expect(problems.join(' ')).toContain('expected 25')
  })

  it('catches a precached file that nothing generates or ships', () => {
    const problems = checkPublicSurface({
      html: HTML,
      sw: SW.replace("'/favicon.svg'", "'/favicon-old.svg'"),
      publicFiles: PUBLIC_FILES,
    })
    expect(problems.join(' ')).toContain('/favicon-old.svg')
  })

  it('catches a precache list it can no longer find', () => {
    const problems = checkPublicSurface({
      html: HTML,
      sw: SW.replace('const PRECACHE = [', 'const PRECACHE_LIST = ['),
      publicFiles: PUBLIC_FILES,
    })
    expect(problems.join(' ')).toContain('no PRECACHE list')
  })
})
