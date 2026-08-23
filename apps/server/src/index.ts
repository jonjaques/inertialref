import {
  NET_PROTOCOL_VERSION,
  SOCKET_PATH,
  type ServerHealth,
} from '@inertialref/protocol'
import { GENERATION_VERSIONS } from '@inertialref/universe'
/*
 * The catalog the *bundle this Worker serves* was built against.
 *
 * Read from the manifest rather than from the packed catalog itself: both are
 * written by the same `pnpm catalog:build` run, and the manifest is 1 KB of
 * JSON where the catalog is 460 KB of binary this script has no reason to
 * decode. `apps/headless/src/catalog.test.ts` holds the two together.
 *
 * Stating it is what closes the hole the handshake had: a client whose catalog
 * had moved could agree with a server whose catalog had not, cleanly, and then
 * disagree about where the stars were.
 */
import catalogManifest from '../../../data/catalog/manifest.json' with { type: 'json' }
import { routeFor } from './routes.ts'
import { type MediaStores, serveMedia } from './serveMedia.ts'

/*
 * The Worker (docs/hosting.md).
 *
 * The server's job is small, and the architecture's job is to keep it small.
 * The universe is a pure function of (seed, catalog version, address), so a
 * server never has to store, serve or simulate a galaxy — it holds only what a
 * client cannot derive, which is other entities and persistent mutations. This
 * file holds neither yet, and that is the point of the milestone: everything
 * stood up, nothing load-bearing.
 *
 * What it does hold is the one thing worth getting right first — a statement of
 * which universe this server believes in, decoded rather than trusted by the
 * client at the other end.
 *
 * Two Cloudflare facts shape the code more than they look like they should:
 *
 *   - `Date.now()` returns the time of the last I/O and does not advance during
 *     execution. That is a Spectre mitigation, not a bug: a Worker is denied
 *     the ability to time itself. Nothing here reads a clock, and when an
 *     authority needs a cadence it will come from `ctx.storage.setAlarm()`
 *     rather than wall time.
 *   - Static asset requests never reach this script and are not billed, so
 *     serving the client from the same origin as the API is free. `assets` and
 *     `run_worker_first` in wrangler.jsonc are what make that true.
 */

/** The client's universe, as this deployment derives it. */
const IDENTITY = {
  status: 'ok',
  protocol: NET_PROTOCOL_VERSION,
  generation: GENERATION_VERSIONS,
  catalog: catalogManifest.version,
} as const satisfies Omit<ServerHealth, 'revision' | 'colo'>

export default {
  async fetch(request, env): Promise<Response> {
    const route = routeFor(new URL(request.url).pathname)

    switch (route.kind) {
      case 'health': {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return api({ error: 'health is a GET' }, 405)
        }
        const health: ServerHealth = {
          ...IDENTITY,
          revision: env.CF_VERSION_METADATA?.id ?? 'unknown',
          // Absent under `wrangler dev`, where there is no edge to name.
          colo: request.cf?.colo ?? '',
        }
        return api(health)
      }

      case 'socket':
        /*
         * Reserved, not forgotten. The path exists so the client, the service
         * worker's cache bypass and `run_worker_first` can all be written
         * against it now; the authority behind it arrives with the Durable
         * Object. A definite 501 is worth far more than a 404 here — it says
         * "this is the right address and there is nothing home yet", which is
         * what a client trying to reconnect needs to distinguish.
         */
        return api(
          { error: `${SOCKET_PATH} is not implemented yet`, milestone: 'H4' },
          501,
        )

      case 'api-not-found':
        return api({ error: 'no such endpoint' }, 404)

      case 'media':
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return api({ error: 'media is a GET' }, 405)
        }
        return serveMedia(request, route.object, stores(env))

      case 'media-not-found':
        return new Response('no such media object', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })

      case 'asset':
        // Unreachable under the current `run_worker_first`, and handled anyway
        // so that changing that config cannot silently turn the site into 404s.
        return env.ASSETS.fetch(request)
    }
  },
} satisfies ExportedHandler<Env>

/**
 * workerd's half of the `MediaStores` seam.
 *
 * Three arrows rather than three method references: `env.ASSETS.fetch` and
 * `env.MEDIA.get` are methods on host objects and lose their receiver when
 * detached, so passing them bare is a `TypeError` at the first request rather
 * than a type error here. The `get` call is also where the overload is chosen
 * — `MediaGetOptions` requires `onlyIf`, which is what selects the overload
 * that can return a body-less object for a 304.
 */
function stores(env: Env): MediaStores {
  return {
    asset: (request) => env.ASSETS.fetch(request),
    get: (key, options) => env.MEDIA.get(key, options),
    head: (key) => env.MEDIA.head(key),
  }
}

/**
 * A JSON response that nothing is allowed to cache.
 *
 * `no-store` is the server's half of a two-sided problem. The service worker is
 * cache-first for same-origin GETs, which is correct for content-hashed assets
 * and catastrophic for live state: the first health response would be pinned
 * for the lifetime of the cache, and because that cache survives a reload it
 * presents as a broken server rather than a broken cache. The service worker
 * skips `/api` for exactly that reason — this header is what protects the
 * request from every other cache between here and the tab.
 */
function api(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
