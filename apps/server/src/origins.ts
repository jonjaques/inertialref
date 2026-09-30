/*
 * Which origins are this site, from the Worker's side.
 *
 * Two checks read these and they must agree: `allowedOrigin`, which refuses a
 * mutation made from a page anywhere else, and the account check's authorized
 * parties, which refuses a session token minted for a page anywhere else. A
 * host added to one and not the other is a site where one of them silently
 * refuses everything.
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
 * The one production host where accounts, and the guide with them, answer.
 *
 * Clerk's production instance is configured for `inertialref.app`, and its
 * Frontend API refuses a page on any other origin (`origin_invalid`). Serving
 * the second host too is a satellite domain, which is a paid plan. So the
 * second host answers as a deployment with no accounts at all — "not
 * configured", and no guide — rather than as one where every sign-in fails.
 * The browser makes the same decision from the page's own host
 * (`apps/game/src/account/accounts.ts`), and never loads Clerk there.
 */
export const ACCOUNT_HOST = 'https://inertialref.app'

/**
 * Whether accounts answer at the host this request arrived at: the account
 * host in production, and every preview and development host, which sign in
 * against the development instance and are not held to one origin.
 */
export function offersAccounts(request: Request): boolean {
  const target = new URL(request.url)
  if (HOSTS.has(target.origin)) return target.origin === ACCOUNT_HOST
  return DEVELOPMENT.has(target.origin) || isPreviewOrigin(target)
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

/**
 * Whether a request came from a page of this site.
 *
 * Exact origins, never a suffix: `inertialref.app.evil.test` ends with the
 * host. A development host accepts any development origin, because Vite
 * proxies `/api` from 5173 to the Worker on 8787 with the browser's own
 * `Origin`. A preview accepts only itself.
 */
export function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  const target = new URL(request.url).origin
  if (!origin) {
    // Browsers omit Origin on same-origin GETs. Mutations and WebSocket
    // upgrades still require the exact origin.
    return (
      request.method === 'GET' &&
      request.headers.get('upgrade') === null &&
      request.headers.get('sec-fetch-site') === 'same-origin' &&
      (HOSTS.has(target) || DEVELOPMENT.has(target))
    )
  }
  if (HOSTS.has(target)) return origin === target
  if (DEVELOPMENT.has(target)) return DEVELOPMENT.has(origin)
  return isPreviewOrigin(new URL(request.url)) && origin === target
}
