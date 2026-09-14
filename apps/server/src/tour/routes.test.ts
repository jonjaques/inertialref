import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GUIDE_CLIENT_EVENTS, GUIDE_TOOLS } from '@inertialref/protocol'
import { loginCookie } from './auth.ts'
import { serveTour } from './routes.ts'

const ORIGIN = 'http://localhost:5173'
const PASSWORD = 'alpha-password'

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: 'key-canary',
    TOUR_GUIDE_PASSWORD: PASSWORD,
    TOUR_GUIDE_ENABLED: 'true',
    ...overrides,
  } as unknown as Env
}

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })
}

describe('the guide Worker', () => {
  // Every refusal writes a record; the test output is not where they go.
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports availability and voices without a cookie', async () => {
    const response = await serveTour(
      new Request(`${ORIGIN}/api/tour/capabilities`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      env(),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.available).toBe(true)
    expect(body.authenticated).toBe(false)
    expect(body.voices).toContain('marin')
    expect(body.voices).toContain('cedar')
    const off = await serveTour(
      new Request(`${ORIGIN}/api/tour/capabilities`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      env({ TOUR_GUIDE_ENABLED: 'false' } as unknown as Partial<Env>),
    )
    expect(((await off.json()) as { available: boolean }).available).toBe(false)
  })

  it('issues the cookie for the password and refuses a wrong one', async () => {
    const wrong = await serveTour(
      post('/api/tour/login', { password: 'guess' }),
      env(),
    )
    expect(wrong.status).toBe(401)
    const right = await serveTour(
      post('/api/tour/login', { password: PASSWORD }),
      env(),
    )
    expect(right.status).toBe(200)
    expect(right.headers.get('set-cookie')).toMatch(/^tour_access=/)
  })

  it('throttles sign-in through the platform counter when it is bound', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const response = await serveTour(
      post('/api/tour/login', { password: PASSWORD }),
      env({ TOUR_LOGIN_LIMIT: { limit } } as unknown as Partial<Env>),
    )
    expect(response.status).toBe(429)
    expect(limit).toHaveBeenCalledOnce()
  })

  it('creates a session only for a signed-in browser, with the authored configuration', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          session: { id: 'live_1', expires_at: 1_789_367_057 },
          transport: { sdp: 'answer' },
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    try {
      const anonymous = await serveTour(
        post('/api/tour/sessions', {
          voice: 'marin',
          sdp: 'offer',
          scene: 'x',
        }),
        env(),
      )
      expect(anonymous.status).toBe(401)
      const cookie = (await loginCookie(PASSWORD, ORIGIN, Date.now())).split(
        ';',
      )[0]!
      const badVoice = await serveTour(
        post(
          '/api/tour/sessions',
          { voice: 'alloy', sdp: 'offer', scene: 'x' },
          cookie,
        ),
        env(),
      )
      expect(badVoice.status).toBe(400)
      const created = await serveTour(
        post(
          '/api/tour/sessions',
          {
            voice: 'cedar',
            sdp: 'offer',
            scene: 'Current view: Saturn. Local time 21:04.',
          },
          cookie,
        ),
        env(),
      )
      expect(created.status).toBe(200)
      expect(await created.json()).toEqual({
        sessionId: 'live_1',
        expiresAt: 1_789_367_057_000,
        sdp: 'answer',
      })
      const call = fetcher.mock.calls[0]!
      expect(String(call[0])).toBe('https://api.openai.com/v1/live/sessions')
      const sent = JSON.parse(String(call[1]?.body)) as {
        session: Record<string, unknown>
        transport: { type: string; sdp: string }
      }
      expect(sent.transport).toEqual({ type: 'webrtc', sdp: 'offer' })
      expect(sent.session.audio).toEqual({ output: { voice: 'cedar' } })
      expect(sent.session.input).toEqual([
        {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: 'Current view: Saturn. Local time 21:04.',
            },
          ],
        },
      ])
      const delegation = sent.session.delegation as {
        type: string
        responses: Record<string, unknown>
      }
      expect(delegation.type).toBe('responses')
      expect(delegation.responses.model).toBe('gpt-6-astra')
      expect(delegation.responses.parallel_tool_calls).toBe(true)
      expect(delegation.responses.tools).toEqual(GUIDE_TOOLS)
      const client = sent.session.client as {
        data_channel: {
          allowed_client_events: string[]
          allowed_server_events: string
        }
      }
      expect(client.data_channel.allowed_client_events).toEqual([
        ...GUIDE_CLIENT_EVENTS,
      ])
      expect(client.data_channel.allowed_client_events).not.toContain(
        'session.update',
      )
      expect(client.data_channel.allowed_server_events).toBe('all')
      expect(sent.session.store).toBe(false)
      expect(JSON.stringify(sent)).not.toContain('key-canary')
      expect(String(call[1]?.headers)).not.toContain('key-canary')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('answers a provider failure with 503 and no detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream detail', { status: 500 })),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cookie = (await loginCookie(PASSWORD, ORIGIN, Date.now())).split(
        ';',
      )[0]!
      const response = await serveTour(
        post(
          '/api/tour/sessions',
          { voice: 'marin', sdp: 'offer', scene: 'x' },
          cookie,
        ),
        env(),
      )
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('upstream detail')
      // The browser gets nothing; the log gets the status and the path.
      expect(error).toHaveBeenCalledOnce()
      expect(error.mock.calls[0]![0]).toMatchObject({
        scope: 'server.tour',
        message: 'provider refused the session',
        path: '/api/tour/sessions',
        code: 'unavailable',
        status: 500,
      })
    } finally {
      error.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it("logs the provider's error record for a refused key, without the key", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: 'Your API key has been invalidated.',
                type: 'invalid_request_error',
                code: 'token_invalidated',
                param: null,
              },
            }),
            {
              status: 401,
              headers: { 'x-request-id': 'req_probe' },
            },
          ),
      ),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cookie = (await loginCookie(PASSWORD, ORIGIN, Date.now())).split(
        ';',
      )[0]!
      const response = await serveTour(
        post(
          '/api/tour/sessions',
          { voice: 'marin', sdp: 'offer', scene: 'x' },
          cookie,
        ),
        env(),
      )
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('token_invalidated')
      expect(error.mock.calls[0]![0]).toMatchObject({
        status: 401,
        providerType: 'invalid_request_error',
        providerCode: 'token_invalidated',
        providerMessage: 'Your API key has been invalidated.',
        requestId: 'req_probe',
      })
      expect(JSON.stringify(error.mock.calls)).not.toContain('key-canary')
    } finally {
      error.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('names a thrown fetch as the cause when the provider never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Invalid header value')
      }),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cookie = (await loginCookie(PASSWORD, ORIGIN, Date.now())).split(
        ';',
      )[0]!
      const response = await serveTour(
        post(
          '/api/tour/sessions',
          { voice: 'marin', sdp: 'offer', scene: 'x' },
          cookie,
        ),
        env(),
      )
      expect(response.status).toBe(503)
      expect(error.mock.calls[0]![0]).toMatchObject({
        code: 'unavailable',
        cause: 'TypeError: Invalid header value',
      })
    } finally {
      error.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('runs each route inside a span that records the status', async () => {
    const attributes: Record<string, unknown> = {}
    const spans: string[] = []
    const tracing = {
      enterSpan: (name: string, callback: (span: unknown) => unknown) => {
        spans.push(name)
        return callback({
          setAttribute: (key: string, value: unknown) => {
            attributes[key] = value
          },
          setAttributes: (values: Record<string, unknown>) => {
            Object.assign(attributes, values)
          },
        })
      },
    } as unknown as Tracing
    const response = await serveTour(
      new Request(`${ORIGIN}/api/tour/capabilities`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      env(),
      tracing,
    )
    expect(response.status).toBe(200)
    expect(spans).toEqual(['tour GET /api/tour/capabilities'])
    expect(attributes).toEqual({
      'http.request.method': 'GET',
      'url.path': '/api/tour/capabilities',
      'http.response.status_code': 200,
    })
  })
})
