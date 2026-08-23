import {
  API_PREFIX,
  HEALTH_PATH,
  MEDIA_PREFIX,
  SOCKET_PATH,
} from '@inertialref/protocol'
import { type MediaObject, mediaFor } from './media.ts'

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
 * a path that is not `/api`, `/api/*`, `/ws` or `/media/*` never wakes the
 * script. It is handled anyway, because "unreachable by configuration" is
 * exactly the kind of claim that stops being true in an edit nobody connects to
 * this file.
 */

export type Route =
  | { readonly kind: 'health' }
  | { readonly kind: 'socket' }
  | { readonly kind: 'api-not-found' }
  | { readonly kind: 'media'; readonly object: MediaObject }
  | { readonly kind: 'media-not-found' }
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
  /*
   * Object storage, and an allow-list rather than a prefix rule.
   *
   * `apps/server/src/media.ts` says why that matters — the bucket is the site's
   * general storage, not a public directory. The second branch is the one that
   * earns its place here: a name that is not served has to 404, because the SPA
   * fallback would otherwise answer a request for an `.mp3` with `index.html`
   * and a 200, and an `<audio>` element handed HTML fails in a way that looks
   * like a decoding bug.
   */
  if (pathname.startsWith(MEDIA_PREFIX)) {
    const object = mediaFor(pathname.slice(MEDIA_PREFIX.length))
    return object === null
      ? { kind: 'media-not-found' }
      : { kind: 'media', object }
  }
  return { kind: 'asset' }
}
