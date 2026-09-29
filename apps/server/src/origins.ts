/*
 * Which origins are this site, from the Worker's side.
 *
 * Two checks read these and they must agree: the guide's `allowedOrigin`, which
 * refuses a request made from anywhere else, and the account check's
 * authorized parties, which refuses a session token minted for anywhere else.
 * A host added to one and not the other is a site where the guide works and
 * nobody is signed in, or the reverse.
 */

/** The deployment's own hosts. Both answer; neither redirects. */
export const HOSTS: ReadonlySet<string> = new Set([
  'https://inertialref.app',
  'https://inertialref.jonjaques.com',
])

/**
 * `pnpm dev` and `pnpm preview`. Vite proxies `/api` to the Worker on 8787
 * with the browser's own `Origin`, so the page's port and the Worker's are
 * both in here.
 */
export const DEVELOPMENT: ReadonlySet<string> = new Set([
  'http://localhost',
  'http://127.0.0.1',
  'http://localhost:5173',
  'http://localhost:8787',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8787',
])

/**
 * A version preview URL, which is exact rather than a family: the request
 * cannot choose another host. The account's workers.dev subdomain is
 * `jaquers`, whatever the custom domains say, so a preview reads
 * `<version>-inertialrefd.jaquers.workers.dev`.
 */
export function isPreviewOrigin(target: URL): boolean {
  return (
    target.protocol === 'https:' &&
    target.hostname.endsWith('-inertialrefd.jaquers.workers.dev')
  )
}

/**
 * The origins a page talking to this request's host may be served from.
 *
 * Grouped by where the request *arrived*, not merged into one list: a
 * production host has no business accepting a token a page on `localhost`
 * asked for, and a preview accepts only itself.
 */
export function siteOrigins(request: Request): readonly string[] {
  const target = new URL(request.url)
  if (HOSTS.has(target.origin)) return [...HOSTS]
  if (DEVELOPMENT.has(target.origin)) return [...DEVELOPMENT]
  return isPreviewOrigin(target) ? [target.origin] : []
}
