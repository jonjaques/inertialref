import { logger } from './log.ts'

/*
 * PostHog's browser SDK, relayed through this origin (docs/hosting.md § The
 * PostHog relay).
 *
 * Content blockers drop requests to PostHog's hosts by name, so a browser that
 * talks to them directly reports nothing from the visitors most likely to have
 * one installed. posthog-js is given `<origin>/api/relay` as its API host and
 * this forwards what it sends. Its requests are same-origin, so none of them is
 * ever preflighted: there is no `OPTIONS` to answer, and one that arrives came
 * from some other page.
 *
 * **An allowlist, not a pass-through.** A prefix rule would make this Worker an
 * open proxy to PostHog's whole API under the site's name. Every ingest path
 * below is one posthog-js 1.447.3 requests, spelled as it spells it, with the
 * one method it uses; a path the SDK gains in an upgrade answers 404 until it
 * is added here. A path PostHog serves and this site has no use for — product
 * tours, web experiments, conversations, metrics, site apps — is left out
 * whether or not the SDK can call it.
 *
 * **Nothing is read.** The body goes upstream as the stream it arrived as.
 * posthog-js gzips in the page and says so in the query string, not in a
 * header, so decoding is PostHog's and a byte changed here is an event lost.
 *
 * The service worker passes every `/api/` request to the network
 * (`isLive` in `apps/game/public/sw.js`), so none of this is ever answered from
 * its cache.
 */

const log = logger('server.relay')

/** US Cloud, where the project lives. The region cannot change after creation. */
const INGEST_HOST = 'https://us.i.posthog.com'
const ASSET_HOST = 'https://us-assets.i.posthog.com'

const SEND = ['POST'] as const
const READ = ['GET'] as const
const FETCH = ['GET', 'HEAD'] as const

/** Where one relayed request goes, and the methods it may arrive with. */
export interface RelayTarget {
  readonly host: typeof INGEST_HOST | typeof ASSET_HOST
  /** The upstream path, with its leading slash. */
  readonly path: string
  readonly methods: readonly string[]
}

/*
 * The ingest paths. Sources are posthog-js 1.447.3 (`lib/src/…`) and
 * `@posthog/browser-common` 0.10.7 (`dist/…`), which the SDK calls through
 * `sendRequest` with an `'api'` or `'flags'` target; with no `flags_api_host`
 * set, both resolve to the API host (`utils/request-router.js`).
 */
const INGEST: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  // Capture until remote config arrives: `analyticsDefaultEndpoint`,
  // `posthog-core.js`.
  ['/e/', SEND],
  // Capture after it: remote config's `analytics.endpoint` replaces `/e/`
  // (`posthog-core.js`, `_onRemoteConfig`), and PostHog's server sends
  // `NEW_ANALYTICS_CAPTURE_ENDPOINT`, `/i/v0/e/`.
  ['/i/v0/e/', SEND],
  // Session replay, `BASE_ENDPOINT` in
  // `extensions/replay/external/lazy-loaded-session-recorder.js`. Sent only
  // while the project has replay switched on.
  ['/s/', SEND],
  // Flags, `feature-flags.mjs`, as `/flags/?v=2`.
  ['/flags/', SEND],
  // OTLP logs, `logs.mjs`.
  ['/i/v1/logs', SEND],
  // Survey definitions, `surveys.mjs`.
  ['/api/surveys/', READ],
  // Early access features, `feature-flags.mjs`.
  ['/api/early_access_features/', READ],
])

/*
 * The asset host serves the SDK's lazily loaded extensions (`/static/…`) and
 * the project's remote config (`/array/<token>/config` and `config.js`),
 * through `endpointFor('assets', …)` in `entrypoints/external-scripts-loader.js`
 * and `remote-config.js`. With an API host that is not PostHog's own, the
 * router sends those to the API host too, so they arrive here. Both are public
 * files, and versioned names under them change with every SDK release, so they
 * are prefixes rather than a list.
 */
const ASSET_PREFIXES = ['/static/', '/array/'] as const

/**
 * Where a path under `RELAY_PREFIX` goes, given what follows the prefix, or
 * `null` for a path the relay does not serve.
 */
export function relayTarget(rest: string): RelayTarget | null {
  const path = `/${rest}`
  if (
    ASSET_PREFIXES.some(
      (prefix) => path.startsWith(prefix) && path.length > prefix.length,
    )
  )
    return { host: ASSET_HOST, path, methods: FETCH }
  const methods = INGEST.get(path)
  return methods === undefined ? null : { host: INGEST_HOST, path, methods }
}

/*
 * The request headers PostHog reads, and nothing else. The ones that matter
 * most are the ones left behind: on `inertialref.app` a same-origin request
 * carries Clerk's `__session` cookie, and nothing PostHog is sent may carry a
 * credential for this site.
 */
const FORWARDED = [
  'content-type',
  'content-encoding',
  'user-agent',
  'accept',
  'origin',
] as const

/**
 * The headers a relayed request goes upstream with.
 *
 * `x-forwarded-for` is where PostHog reads the visitor's address for GeoIP;
 * without it every event locates to the Cloudflare data center that relayed it.
 * It is taken from `cf-connecting-ip`, which Cloudflare sets at its edge, and
 * never from the visitor's own `x-forwarded-for`, which they can write.
 */
export function relayHeaders(incoming: Headers): Headers {
  const headers = new Headers()
  for (const name of FORWARDED) {
    const value = incoming.get(name)
    if (value !== null) headers.set(name, value)
  }
  const address = incoming.get('cf-connecting-ip')
  if (address !== null && address !== '')
    headers.set('x-forwarded-for', address)
  return headers
}

/**
 * The upstream URL. Concatenated, not resolved against the host: `new URL(path,
 * host)` reads a path that begins `//` as another host, and the host here must
 * be the one the allowlist chose.
 */
export const upstreamUrl = (target: RelayTarget, search: string): string =>
  `${target.host}${target.path}${search}`

/**
 * Forward one request whose method `target` allows, and answer with what
 * PostHog said less its cookies, or `null` when PostHog could not be reached.
 */
export async function relay(
  request: Request,
  target: RelayTarget,
): Promise<Response | null> {
  const bodied = request.method !== 'GET' && request.method !== 'HEAD'
  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl(target, new URL(request.url).search), {
      method: request.method,
      headers: relayHeaders(request.headers),
      body: bodied ? request.body : null,
    })
  } catch (error) {
    // The path and never the query, which carries the project token.
    log('warn', 'PostHog unreachable', {
      host: target.host,
      path: target.path,
      error: error instanceof Error ? error.name : String(error),
    })
    return null
  }
  // A cookie in a relayed answer is set on this origin, beside Clerk's.
  const headers = new Headers(upstream.headers)
  headers.delete('set-cookie')
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}
