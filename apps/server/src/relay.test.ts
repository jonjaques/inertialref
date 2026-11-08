import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELAY_PREFIX } from '@inertialref/protocol'
import worker from './index.ts'
import { relay, relayHeaders, relayTarget, upstreamUrl } from './relay.ts'
import { routeFor } from './routes.ts'

type IncomingRequest = Request<unknown, IncomingRequestCfProperties>

/*
 * The relay against `fetch` stubbed at the global, which is where the Worker
 * reaches PostHog. What is asserted is what crosses that boundary: the URL, the
 * method, the headers and the body bytes going up, and the answer coming back.
 */

const SITE = 'https://inertialref.app'
const INGEST = 'https://us.i.posthog.com'
const ASSETS = 'https://us-assets.i.posthog.com'

const upstream =
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  upstream.mockReset()
  upstream.mockResolvedValue(new Response('{"status":1}', { status: 200 }))
  vi.stubGlobal('fetch', upstream)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The request the stub received, as one object. */
function sent(): { url: string; init: RequestInit } {
  expect(upstream).toHaveBeenCalledOnce()
  const [input, init] = upstream.mock.calls[0]!
  return { url: String(input), init: init ?? {} }
}

const handle = (request: Request): Promise<Response> =>
  // A test's request has no edge, so none of the `cf` an incoming one carries.
  worker.fetch(request as IncomingRequest, {} as Env, {} as ExecutionContext)

describe('the PostHog relay', () => {
  it('routes the paths posthog-js requests, each to its host', () => {
    const cases: [string, string, string, readonly string[]][] = [
      ['e/', INGEST, '/e/', ['POST']],
      ['i/v0/e/', INGEST, '/i/v0/e/', ['POST']],
      ['s/', INGEST, '/s/', ['POST']],
      ['flags/', INGEST, '/flags/', ['POST']],
      ['i/v1/logs', INGEST, '/i/v1/logs', ['POST']],
      ['api/surveys/', INGEST, '/api/surveys/', ['GET']],
      [
        'api/early_access_features/',
        INGEST,
        '/api/early_access_features/',
        ['GET'],
      ],
      ['static/surveys.js', ASSETS, '/static/surveys.js', ['GET', 'HEAD']],
      [
        'static/1.447.3/recorder.js',
        ASSETS,
        '/static/1.447.3/recorder.js',
        ['GET', 'HEAD'],
      ],
      [
        'array/phc_token/config',
        ASSETS,
        '/array/phc_token/config',
        ['GET', 'HEAD'],
      ],
      [
        'array/phc_token/config.js',
        ASSETS,
        '/array/phc_token/config.js',
        ['GET', 'HEAD'],
      ],
    ]
    for (const [rest, host, path, methods] of cases) {
      const route = routeFor(`${RELAY_PREFIX}${rest}`)
      expect(route, rest).toEqual({
        kind: 'relay',
        target: { host, path, methods },
      })
    }
  })

  it('answers anything else under the prefix as an unknown endpoint', () => {
    for (const path of [
      '/api/relay',
      '/api/relay/',
      // Paths PostHog serves that posthog-js 1.447.3 never requests.
      '/api/relay/batch/',
      '/api/relay/decide/',
      '/api/relay/i/v1/metrics',
      '/api/relay/api/product_tours/',
      '/api/relay/api/web_experiments/',
      // PostHog's private API, which the allowlist exists to keep out of reach.
      '/api/relay/api/projects/719084/persons/bulk_delete/',
      // Spelled differently from the SDK, which is a different path.
      '/api/relay/e',
      '/api/relay/E/',
      '/api/relay/flags',
      '/api/relay/e/extra',
      // A bare asset prefix names no file.
      '/api/relay/static/',
      '/api/relay/array/',
      // A second slash would make `new URL(path, host)` read another host.
      '/api/relay//evil.example/e/',
      '/api/relay//static/x.js',
    ]) {
      expect(routeFor(path).kind, path).toBe('api-not-found')
    }
    expect(relayTarget('constructor')).toBeNull()
    expect(relayTarget('__proto__')).toBeNull()
  })

  it('keeps the upstream host the one the allowlist chose', () => {
    const target = relayTarget('e/')!
    expect(
      upstreamUrl(target, '?ip=0&_=1&ver=1.447.3&compression=gzip-js'),
    ).toBe(`${INGEST}/e/?ip=0&_=1&ver=1.447.3&compression=gzip-js`)
    expect(new URL(upstreamUrl(relayTarget('static/x.js')!, '')).host).toBe(
      'us-assets.i.posthog.com',
    )
  })

  it('forwards the headers PostHog reads, and never a credential', () => {
    const headers = relayHeaders(
      new Headers({
        'content-type': 'text/plain',
        'content-encoding': 'gzip',
        'user-agent': 'Mozilla/5.0 (test)',
        accept: '*/*',
        origin: SITE,
        cookie: '__session=eyJ.session.token; __client_uat=1',
        authorization: 'Bearer eyJ.session.token',
        'x-forwarded-for': '203.0.113.99',
        'cf-connecting-ip': '198.51.100.7',
        referer: `${SITE}/planetarium`,
        'x-posthog-anything': 'no',
      }),
    )
    expect(Object.fromEntries(headers)).toEqual({
      'content-type': 'text/plain',
      'content-encoding': 'gzip',
      'user-agent': 'Mozilla/5.0 (test)',
      accept: '*/*',
      origin: SITE,
      'x-forwarded-for': '198.51.100.7',
    })
  })

  it('sets no forwarded address when the edge named none', () => {
    // `cf dev` has no edge; the visitor's own header is still not trusted.
    const headers = relayHeaders(
      new Headers({ 'x-forwarded-for': '203.0.113.99' }),
    )
    expect(headers.has('x-forwarded-for')).toBe(false)
  })

  it('sends the body upstream byte for byte, with the query string', async () => {
    // A gzip member: the magic bytes, then bytes that are not valid UTF-8, so
    // anything that decoded or re-encoded the body as text would change them.
    const body = new Uint8Array([
      0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00, 0xc3,
    ])
    const request = new Request(
      `${SITE}/api/relay/i/v0/e/?ip=0&_=1730000000000&ver=1.447.3&compression=gzip-js`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          cookie: '__session=eyJ.session.token',
          'cf-connecting-ip': '198.51.100.7',
        },
        body,
      },
    )
    await relay(request, relayTarget('i/v0/e/')!)
    const { url, init } = sent()
    expect(url).toBe(
      `${INGEST}/i/v0/e/?ip=0&_=1730000000000&ver=1.447.3&compression=gzip-js`,
    )
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.7')
    expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(
      body,
    )
  })

  it('sends no body with a read', async () => {
    await relay(
      new Request(`${SITE}/api/relay/api/surveys/?token=phc_token`),
      relayTarget('api/surveys/')!,
    )
    const { url, init } = sent()
    expect(url).toBe(`${INGEST}/api/surveys/?token=phc_token`)
    expect(init.method).toBe('GET')
    expect(init.body).toBeNull()
  })

  it('passes the answer through, less its cookies', async () => {
    upstream.mockResolvedValue(
      new Response('console.log(1)', {
        status: 200,
        headers: [
          ['content-type', 'application/javascript'],
          ['cache-control', 'public, max-age=3600'],
          ['set-cookie', 'ph_tracking=1; Path=/'],
          ['set-cookie', 'other=2; Path=/'],
        ],
      }),
    )
    const response = await relay(
      new Request(`${SITE}/api/relay/static/surveys.js?v=1.447.3`),
      relayTarget('static/surveys.js')!,
    )
    expect(response?.status).toBe(200)
    expect(response?.headers.get('set-cookie')).toBeNull()
    expect(response?.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(response?.headers.get('content-type')).toBe('application/javascript')
    expect(await response?.text()).toBe('console.log(1)')
  })

  it("passes PostHog's refusals through as PostHog's", async () => {
    upstream.mockResolvedValue(
      new Response('{"type":"validation_error"}', { status: 400 }),
    )
    const response = await relay(
      new Request(`${SITE}/api/relay/e/`, { method: 'POST', body: 'x' }),
      relayTarget('e/')!,
    )
    expect(response?.status).toBe(400)
    expect(await response?.text()).toBe('{"type":"validation_error"}')
  })

  describe('through the handler', () => {
    it('refuses a method the path does not take, and asks PostHog nothing', async () => {
      for (const [path, method, allow] of [
        ['/api/relay/e/', 'GET', 'POST'],
        ['/api/relay/e/', 'OPTIONS', 'POST'],
        ['/api/relay/api/surveys/', 'POST', 'GET'],
        ['/api/relay/static/array.js', 'POST', 'GET, HEAD'],
      ] as const) {
        const response = await handle(new Request(`${SITE}${path}`, { method }))
        expect(response.status, `${method} ${path}`).toBe(405)
        expect(response.headers.get('allow')).toBe(allow)
      }
      expect(upstream).not.toHaveBeenCalled()
    })

    it('answers an unlisted path as JSON, and asks PostHog nothing', async () => {
      const response = await handle(
        new Request(`${SITE}/api/relay/batch/`, { method: 'POST', body: '[]' }),
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      expect(await response.json()).toEqual({ error: 'no such endpoint' })
      expect(upstream).not.toHaveBeenCalled()
    })

    it('answers 502 when PostHog cannot be reached, and says where', async () => {
      upstream.mockRejectedValue(new TypeError('Network connection lost.'))
      const response = await handle(
        new Request(`${SITE}/api/relay/flags/?v=2`, {
          method: 'POST',
          body: '{}',
        }),
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'PostHog is unreachable' })
      expect(console.warn).toHaveBeenCalledWith({
        scope: 'server.relay',
        message: 'PostHog unreachable',
        host: INGEST,
        path: '/flags/',
        error: 'TypeError',
      })
    })

    it('relays without asking for an account allowance', async () => {
      // `{}` has no ACCOUNT_LIMIT binding: reaching it would throw.
      const response = await handle(
        new Request(`${SITE}/api/relay/e/`, { method: 'POST', body: '{}' }),
      )
      expect(response.status).toBe(200)
      expect(sent().url).toBe(`${INGEST}/e/`)
    })
  })
})
