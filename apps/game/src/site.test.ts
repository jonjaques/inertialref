import { describe, expect, it } from 'vitest'
import { isMeasured } from './analytics.ts'
import {
  ABOUT,
  CINEMA,
  DOCS,
  HOME,
  KEYS,
  PLANETARIUM,
  PLAY_SOLO,
  SETTINGS,
  cinemaScene,
  settingsSection,
} from './pages/paths.ts'
import {
  PAGES,
  SITE,
  canonicalUrl,
  documentTitle,
  indexedPath,
  jsonLd,
  pageMetaFor,
} from './site.ts'

/*
 * What the site says about itself, and to whom.
 *
 * These are the two pieces of this area that are pure functions of a string,
 * and both of them fail silently in production. A description that resolves to
 * the wrong page is a search result describing something else; an analytics
 * gate that lets `localhost` through poisons the numbers with the maintainer's
 * own testing and nothing anywhere says so. Neither needs a browser to state.
 *
 * The layout interpolates these helpers into the served HTML; `checkHead.mjs`
 * is the gate that the layout still calls them. This file is the values.
 */

describe('page metadata', () => {
  it('matches the longest path, so a scene is the cinema page', () => {
    expect(pageMetaFor(cinemaScene('tng-intro')).path).toBe(CINEMA)
    expect(pageMetaFor(settingsSection('camera')).path).toBe(SETTINGS)
    expect(pageMetaFor(PLANETARIUM).path).toBe(PLANETARIUM)
  })

  it('falls back to the home page for anything unlisted', () => {
    expect(pageMetaFor('/nothing/here').path).toBe(HOME)
    expect(pageMetaFor(HOME).path).toBe(HOME)
  })

  it('does not treat a longer name as a section of a shorter one', () => {
    // `/aboutish` starts with `/about` as a *string* and is not under it as a
    // path. Matching on the raw prefix is the bug this guards.
    expect(pageMetaFor(`${ABOUT}ish`).path).toBe(HOME)
  })

  it('ignores a trailing slash, which is the same page', () => {
    expect(pageMetaFor(`${PLANETARIUM}/`).path).toBe(PLANETARIUM)
    expect(pageMetaFor(HOME).path).toBe(HOME)
  })

  it('orders specific paths before the ones they sit under', () => {
    // `pageMetaFor` takes the first match, so an entry whose path is a prefix
    // of another's must come after it. Stated as a property rather than as a
    // comment on the array, because the array is edited far more often than
    // the function that depends on its order.
    PAGES.forEach((page, index) => {
      const shadowed = PAGES.slice(0, index).find(
        (earlier) =>
          earlier.path !== HOME && page.path.startsWith(`${earlier.path}/`),
      )
      expect(shadowed).toBeUndefined()
    })
    expect(PAGES[PAGES.length - 1]?.path).toBe(HOME)
  })
})

describe('what a search result and a tab strip get', () => {
  it('leads a title with the page, not the product', () => {
    expect(documentTitle(pageMetaFor(PLANETARIUM))).toBe(
      `Planetarium · ${SITE.name}`,
    )
    expect(documentTitle(pageMetaFor(HOME))).toBe(
      `${SITE.name} — ${SITE.tagline}`,
    )
    expect(documentTitle(pageMetaFor(DOCS), 'Reference frames')).toBe(
      `Reference frames · ${SITE.name}`,
    )
  })

  it('keeps every description inside what a result actually shows', () => {
    /*
     * Google truncates a description around 160 characters on desktop and
     * nearer 120 on mobile. The upper bound is the desktop one: past it the
     * sentence does not end where its author ended it, which is the whole
     * difference between a description and the first 160 characters of one.
     *
     * The lower bound is not about search at all — it is the guard against a
     * page being added with a placeholder. Every page here is a *place*, and
     * three words cannot say what one is.
     */
    for (const page of PAGES) {
      expect(
        page.description.length,
        `${page.path} is ${page.description.length} characters`,
      ).toBeLessThanOrEqual(160)
      expect(
        page.description.length,
        `${page.path} is ${page.description.length} characters`,
      ).toBeGreaterThan(60)
    }
  })

  it('writes a canonical URL that is absolute and has no trailing slash', () => {
    expect(canonicalUrl(HOME)).toBe(SITE.origin)
    expect(canonicalUrl(PLANETARIUM)).toBe(`${SITE.origin}${PLANETARIUM}`)
    expect(canonicalUrl(HOME).endsWith('/')).toBe(false)
  })

  it('gives one page one canonical, whatever slash it was reached by', () => {
    /*
     * `pageMetaFor` already treats these as the same page and `sitemap.xml`
     * lists the slash-less form, so a shared `/planetarium/` link used to
     * declare itself canonical *and* disagree with the sitemap — two
     * canonicals for one page, which is the split the tag exists to prevent.
     * It divided the analytics `page_location` the same way.
     */
    for (const path of [PLANETARIUM, CINEMA, ABOUT]) {
      expect(canonicalUrl(`${path}/`)).toBe(canonicalUrl(path))
      expect(canonicalUrl(`${path}//`)).toBe(canonicalUrl(path))
    }
    // `/` is the one path where the slash *is* the path.
    expect(canonicalUrl(HOME)).toBe(SITE.origin)
  })

  it('strips the .html Astro file format puts on a pathname', () => {
    /*
     * `build.format: 'file'` writes `planetarium.html`. Pages that pass
     * `pathname` into the layout already name the public URL; pages that
     * do not — the front door, the 404, every documentation page — see
     * `Astro.url.pathname` as the file. The sitemap lists the extensionless
     * form. Two canonicals for one page is the split this function exists
     * to prevent.
     */
    expect(canonicalUrl('/index.html')).toBe(SITE.origin)
    expect(canonicalUrl(`${PLANETARIUM}.html`)).toBe(
      `${SITE.origin}${PLANETARIUM}`,
    )
    expect(canonicalUrl(`${DOCS}/concepts/frames.html`)).toBe(
      `${SITE.origin}${DOCS}/concepts/frames`,
    )
    expect(pageMetaFor(`${DOCS}/concepts/frames.html`).path).toBe(DOCS)
    expect(indexedPath('/404.html')).toBe(false)
  })

  it('states an origin that agrees with the host', () => {
    // Two constants, one fact. They are separate because one is compared
    // against `location.hostname` and the other is concatenated into a URL.
    expect(SITE.origin).toBe(`https://${SITE.host}`)
  })

  it('lists documentation pages and not dialogs or stubs', () => {
    expect(indexedPath(HOME)).toBe(true)
    expect(indexedPath(`${DOCS}/concepts/frames`)).toBe(true)
    expect(indexedPath(PLANETARIUM)).toBe(true)
    expect(indexedPath(SETTINGS)).toBe(false)
    expect(indexedPath(settingsSection('camera'))).toBe(false)
    expect(indexedPath(KEYS)).toBe(false)
    expect(indexedPath(PLAY_SOLO)).toBe(false)
  })
})

describe('who is measured', () => {
  const canonical = {
    production: true,
    hostname: SITE.host,
    measurementId: 'G-TEST',
    optedOut: false,
  }

  it('measures the canonical host in a production build', () => {
    expect(isMeasured(canonical)).toBe(true)
  })

  it('measures nothing anywhere else', () => {
    /*
     * Each of these is a real address this exact bundle answers on. The
     * versioned forms are the ones that still arrive: `workers_dev` is `false`
     * so the Worker has no shared `workers.dev` route, but `preview_urls` is
     * `true` and every uploaded version gets its own hostname on that subdomain.
     * The bare and aliased spellings stay listed because the gate is a
     * canonical-host allow-list, not a preview-shaped denylist.
     */
    for (const hostname of [
      'localhost',
      '127.0.0.1',
      'inertialrefd.jaquers.workers.dev',
      '1a2b3c4d-inertialrefd.jaquers.workers.dev',
      'preview-branch.inertialrefd.workers.dev',
    ]) {
      expect(isMeasured({ ...canonical, hostname })).toBe(false)
    }
  })

  it('measures nothing in a development build', () => {
    expect(isMeasured({ ...canonical, production: false })).toBe(false)
  })

  it('measures nothing without an id, which is what a fork builds with', () => {
    expect(isMeasured({ ...canonical, measurementId: '' })).toBe(false)
  })

  it('honors an explicit opt-out', () => {
    expect(isMeasured({ ...canonical, optedOut: true })).toBe(false)
  })
})

describe('the JSON-LD graph', () => {
  const graph = jsonLd() as {
    '@context': string
    '@graph': readonly Record<string, unknown>[]
  }

  it('is a schema.org graph of the site, the author, and the application', () => {
    expect(graph['@context']).toBe('https://schema.org')
    const types = graph['@graph'].map((node) => node['@type'])
    expect(types).toContain('WebSite')
    expect(types).toContain('Person')
    expect(types).toEqual(
      expect.arrayContaining([['SoftwareApplication', 'VideoGame']]),
    )
  })

  it('names this origin, never a preview host', () => {
    const blob = JSON.stringify(graph)
    expect(blob).toContain(SITE.origin)
    expect(blob).not.toContain('workers.dev')
    expect(blob).not.toContain('http://')
  })

  it('holds every structured description inside a paragraph, not a page', () => {
    for (const node of graph['@graph']) {
      if (typeof node.description !== 'string') continue
      expect(
        node.description.length,
        `${String(node['@type'])} is ${node.description.length} characters`,
      ).toBeGreaterThanOrEqual(60)
      expect(
        node.description.length,
        `${String(node['@type'])} is ${node.description.length} characters`,
      ).toBeLessThanOrEqual(300)
    }
  })

  it('states the application is free', () => {
    const app = graph['@graph'].find(
      (node) =>
        Array.isArray(node['@type']) && node['@type'].includes('VideoGame'),
    )
    expect(app?.isAccessibleForFree).toBe(true)
    expect(app?.offers).toEqual({
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    })
  })
})
