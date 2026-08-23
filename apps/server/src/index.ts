import {
  NET_PROTOCOL_VERSION,
  SOCKET_PATH,
  type ServerHealth,
} from '@inertialref/protocol'
import { GENERATION_VERSIONS } from '@inertialref/universe'
import { type MediaObject, resolveRange } from './media.ts'
import { routeFor } from './routes.ts'

/*
 * The Worker (docs/hosting.md).
 *
 * The server's job is small, and the architecture's job is to keep it small.
 * The universe is a pure function of (seed, catalogue version, address), so a
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
        return media(request, env, route.object)

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
 * One media object, from the bundle if it is there and from R2 if it is not.
 *
 * The order is not a preference, it is a cost: an asset request is free, never
 * leaves the asset store, and gets `Range` right without any of the code below.
 * R2 is the guarantee behind it — a build that ran without credentials produces
 * a bundle with no audio, and this is what makes that a slower first byte
 * rather than a missing feature. `media.ts` has the whole arrangement.
 *
 * **The miss is detected by content type, and that is not a heuristic.**
 * `not_found_handling: single-page-application` means the asset store answers a
 * path it does not have with `index.html` and a **200**, so there is no status
 * code to test. Nothing under `/media/` is ever HTML, so an HTML answer to a
 * request for an `.mp3` is unambiguous — and the alternative, trusting the 200,
 * hands an `<audio>` element a page of markup.
 *
 * **`env.ASSETS` does not serve ranges**, which is the second reason R2 is
 * here. Measured against the deployed review app: a `Range: bytes=0-1023` for
 * this file comes back `200` with all 2.7 MB of it. A browser copes — it
 * buffers the whole track and then seeks locally — but the cutscene overlay
 * drives `currentTime` against a reference clock, so on a slow connection every
 * seek waits for a download that a 206 would have made unnecessary. When a
 * range is asked for and the asset store ignores it, the bucket answers
 * instead.
 */
async function media(
  request: Request,
  env: Env,
  object: MediaObject,
): Promise<Response> {
  const wantsRange = request.headers.has('range')
  const asset = await env.ASSETS.fetch(request)
  const type = asset.headers.get('content-type') ?? ''
  const servedByAssets =
    !type.startsWith('text/html') && !(wantsRange && asset.status === 200)
  if (servedByAssets) return asset

  /*
   * `range` and `onlyIf` are handed the request's own headers: R2 parses
   * `Range`, `If-None-Match` and the rest itself, which is the only way to get
   * this right without reimplementing RFC 9110 in a Worker.
   */
  const stored = await env.MEDIA.get(object.key, {
    range: request.headers,
    onlyIf: request.headers,
  })
  if (stored === null) {
    return new Response('not in storage', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const headers = new Headers()
  stored.writeHttpMetadata(headers)
  headers.set('etag', stored.httpEtag)
  headers.set('accept-ranges', 'bytes')
  /*
   * Immutable, and it is true rather than optimistic: the name is an
   * allow-listed constant in `media.ts`, so a *different* track is a different
   * entry and a different URL. This is also what keeps the invocation cost of
   * `run_worker_first` on this path down to roughly one per client.
   */
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  if (!headers.has('content-type')) headers.set('content-type', object.type)

  // No body means R2 answered a conditional request: the client already has it.
  if (!('body' in stored) || stored.body === null) {
    return new Response(null, { status: 304, headers })
  }

  /*
   * A 206 only when one was asked for.
   *
   * `stored.range` is populated whether or not the request carried a `Range`
   * header — an unranged get reports the whole object as its range — so keying
   * the status off it alone answers every plain GET with 206 Partial Content.
   * Nothing errors: the bytes are right, and a browser mostly copes. What it
   * breaks is every cache in between, which is entitled to treat a partial
   * response as one it must not reuse as a whole one.
   */
  const range = wantsRange
    ? resolveRange(stored.range ?? {}, stored.size)
    : null
  if (range === null) {
    headers.set('content-length', String(stored.size))
    return new Response(request.method === 'HEAD' ? null : stored.body, {
      status: 200,
      headers,
    })
  }
  headers.set('content-range', range.contentRange)
  headers.set('content-length', String(range.length))
  return new Response(request.method === 'HEAD' ? null : stored.body, {
    status: 206,
    headers,
  })
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
