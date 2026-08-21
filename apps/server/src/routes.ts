import { API_PREFIX, HEALTH_PATH, SOCKET_PATH } from '@inertialref/protocol'

/*
 * Which handler a path belongs to.
 *
 * Separated from `index.ts` because it is the half with decisions in it and the
 * only half that can be tested in plain Node — `index.ts` imports
 * `cloudflare:workers` types and needs workerd to run. Durable Object tests
 * will need `@cloudflare/vitest-pool-workers` (and a Vitest bump) when there is
 * a Durable Object; routing does not, and should not wait for one.
 *
 * `run_worker_first` in wrangler.jsonc means `asset` is normally unreachable —
 * a path that is not `/api`, `/api/*` or `/ws` never wakes the script. It is
 * handled anyway, because "unreachable by configuration" is exactly the kind of
 * claim that stops being true in an edit nobody connects to this file.
 */

export type Route =
  | { readonly kind: 'health' }
  | { readonly kind: 'socket' }
  | { readonly kind: 'api-not-found' }
  | { readonly kind: 'asset' }

const API_ROOT = API_PREFIX.slice(0, -1)

export function routeFor(pathname: string): Route {
  if (pathname === HEALTH_PATH) return { kind: 'health' }
  if (pathname === SOCKET_PATH) return { kind: 'socket' }
  /*
   * Anything else under /api is a 404 from the API, not a page.
   *
   * This is the branch that matters most today: with the SPA fallback in front
   * of it, a typo'd endpoint would answer 200 with index.html, and the client
   * would report a healthy server it cannot talk to. Being strict about the
   * trailing slash is part of it — `/api/health/` is a different path, and
   * quietly treating it as the same one means two spellings of every endpoint
   * forever.
   */
  if (pathname === API_ROOT || pathname.startsWith(API_PREFIX)) {
    return { kind: 'api-not-found' }
  }
  return { kind: 'asset' }
}
