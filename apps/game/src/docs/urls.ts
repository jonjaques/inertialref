import { DOCS } from '../pages/paths.ts'

/*
 * The documentation URL, as an Astro rest param and back.
 *
 * `astro/pages/docs/[...route].astro` is one file for nine hundred pages, and
 * the index is the interesting case: `/docs` has no rest, so the param is
 * `undefined`, and a mapping that turned that into `/docs/undefined` would
 * be a 404 on the one page every wing points at. The round trip is the test;
 * this module is the only thing that does it.
 */

/**
 * The `[...route]` param for a documentation URL, or `undefined` for `/docs`.
 *
 * `undefined` rather than `''` because Astro's rest param treats the empty
 * string and a missing segment as the same path only sometimes, and the
 * missing segment is the one `getStaticPaths` actually emits for the index.
 */
export function docsParam(route: string): string | undefined {
  if (route === DOCS) return undefined
  if (!route.startsWith(`${DOCS}/`)) {
    throw new Error(`${route} is not a documentation route`)
  }
  return route.slice(DOCS.length + 1)
}

/** The documentation URL for a rest param. The inverse of `docsParam`. */
export function docsRoute(param: string | undefined): string {
  return param === undefined || param.length === 0 ? DOCS : `${DOCS}/${param}`
}

/**
 * The sentence a documentation card carries.
 *
 * The page's own lead when it is a description, and the section's when it
 * is not. A lead of three words is a placeholder; a lead of four hundred
 * is the first paragraph of the page, which is what the article is for.
 * The 60–160 bound is the same one `site.test.ts` holds every PageMeta to.
 */
export function docCardDescription(lead: string, fallback: string): string {
  return lead.length >= 60 && lead.length <= 160 ? lead : fallback
}
