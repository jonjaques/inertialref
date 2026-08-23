import { describe, expect, it } from 'vitest'
import { isMeasured } from './analytics.ts'
import {
  ABOUT,
  CINEMA,
  HOME,
  PLANETARIUM,
  SETTINGS,
  cinemaScene,
  settingsSection,
} from './pages/paths.ts'
import {
  PAGES,
  SITE,
  canonicalUrl,
  documentTitle,
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
 * The tags actually written into the document are `pages/DocumentMeta.tsx`'s
 * job and are not tested here — that needs a DOM, and what would be under test
 * is `setAttribute`.
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

  it('states an origin that agrees with the host', () => {
    // Two constants, one fact. They are separate because one is compared
    // against `location.hostname` and the other is concatenated into a URL.
    expect(SITE.origin).toBe(`https://${SITE.host}`)
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
    // Each of these is a real address this exact bundle answers on.
    for (const hostname of [
      'localhost',
      '127.0.0.1',
      'inertialrefd.jaquers.workers.dev',
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

  it('honours an explicit opt-out', () => {
    expect(isMeasured({ ...canonical, optedOut: true })).toBe(false)
  })
})
