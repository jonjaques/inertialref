import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decode,
  decodeGuideError,
  decodeGuideSessionCreated,
  decodeGuideVerdict,
  GUIDE_CLIENT_EVENTS,
  GUIDE_REFUSAL_SENTENCES,
  GUIDE_SESSIONS_PATH,
  GUIDE_TOOLS,
  GUIDE_VERDICT_PATH,
  type Decoder,
} from '@inertialref/protocol'
import { AccountUnavailableError } from '../account.ts'
import type { GuideAccess } from './access.ts'
import { serveTour } from './routes.ts'

/*
 * The route's decisions, with the account verdict as an input. Who is signed
 * in and what their metadata grants is `access.test.ts`'s, against real
 * tokens; here it is whatever the test says it is.
 */
const verdict = vi.hoisted(() => ({
  current: { signedIn: false, authorized: false, userId: null } as
    GuideAccess | Error,
}))
vi.mock('./access.ts', () => ({
  guideAccess: async () => {
    if (verdict.current instanceof Error) throw verdict.current
    return verdict.current
  },
}))
const GRANTED: GuideAccess = {
  signedIn: true,
  authorized: true,
  userId: 'user_2test',
}

const ORIGIN = 'http://localhost:5173'

/*
 * Every answer is read through the protocol's own decoder, which is the
 * contract test across the network: the browser decodes with the same one,
 * so a field the Worker renames fails here rather than in a visitor's panel.
 */
async function read<T>(response: Response, decoder: Decoder<T>): Promise<T> {
  const decoded = decode(decoder, await response.json())
  if (!decoded.ok) throw new Error(decoded.error)
  return decoded.value
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: 'key-canary',
    CLERK_SECRET_KEY: 'sk_test_route',
    CLERK_ENABLED: 'true',
    TOUR_GUIDE_ENABLED: 'true',
    ...overrides,
  } as unknown as Env
}

function post(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('the guide Worker', () => {
  // Every refusal writes a record; the test output is not where they go.
  beforeEach(() => {
    verdict.current = { signedIn: false, authorized: false, userId: null }
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers a verdict: granted with its voices, or refused with a reason', async () => {
    const ask = (overrides?: Partial<Env>, origin = ORIGIN) =>
      serveTour(
        new Request(`${origin}${GUIDE_VERDICT_PATH}`, {
          headers: { 'sec-fetch-site': 'same-origin' },
        }),
        env(overrides),
      ).then((response) => {
        expect(response.status).toBe(200)
        return read(response, decodeGuideVerdict)
      })
    expect(await ask()).toEqual({ granted: false, reason: 'signed-out' })
    verdict.current = { signedIn: true, authorized: false, userId: 'user_2' }
    expect(await ask()).toEqual({ granted: false, reason: 'not-granted' })
    verdict.current = GRANTED
    const granted = await ask()
    expect(granted.granted && granted.voices).toEqual(
      expect.arrayContaining(['marin', 'cedar']),
    )
    // Switched off, or with no way to read a grant, nobody is told they have it.
    for (const overrides of [
      { TOUR_GUIDE_ENABLED: 'false' },
      { CLERK_ENABLED: 'false' },
      { CLERK_SECRET_KEY: undefined },
    ] as unknown as Partial<Env>[])
      expect(await ask(overrides)).toEqual({
        granted: false,
        reason: 'unavailable',
      })
    // The production host Clerk does not serve has no accounts, so no guide.
    expect(await ask({}, 'https://inertialref.jonjaques.com')).toEqual({
      granted: false,
      reason: 'unavailable',
    })
  })

  it('refuses a session to a visitor who is not signed in, or not granted the guide', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    try {
      const ask = () =>
        serveTour(
          post(GUIDE_SESSIONS_PATH, {
            voice: 'marin',
            sdp: 'offer',
            scene: 'x',
          }),
          env(),
        )
      const anonymous = await ask()
      expect(anonymous.status).toBe(401)
      expect(await read(anonymous, decodeGuideError)).toEqual({
        error: GUIDE_REFUSAL_SENTENCES['signed-out'],
      })
      verdict.current = {
        signedIn: true,
        authorized: false,
        userId: 'user_2test',
      }
      const ungranted = await ask()
      expect(ungranted.status).toBe(403)
      expect(await read(ungranted, decodeGuideError)).toEqual({
        error: GUIDE_REFUSAL_SENTENCES['not-granted'],
      })
      // The provider is never asked on behalf of either.
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('answers 503 when the accounts behind the grant cannot be reached', async () => {
    verdict.current = new AccountUnavailableError('backend-500')
    const response = await serveTour(
      post(GUIDE_SESSIONS_PATH, { voice: 'marin', sdp: 'offer', scene: 'x' }),
      env(),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'The guide is unavailable.',
    })
  })

  it('refuses a session past the account’s allowance, before the provider is asked', async () => {
    verdict.current = GRANTED
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const limit = vi.fn(async (_options: RateLimitOptions) => ({
      success: false,
    }))
    try {
      const refused = await serveTour(
        post(GUIDE_SESSIONS_PATH, { voice: 'cedar', sdp: 'offer', scene: '' }),
        env({ GUIDE_SESSION_LIMIT: { limit } } as Partial<Env>),
      )
      expect(refused.status).toBe(429)
      expect(refused.headers.get('retry-after')).toBe('60')
      expect(await refused.json()).toEqual({
        error: 'Too many guide sessions. Try again in a minute.',
      })
      // Keyed on the account, which is what a granted token in a script shares.
      expect(limit).toHaveBeenCalledWith({ key: 'user_2test' })
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('creates a session for a granted account, with the authored configuration', async () => {
    verdict.current = GRANTED
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          session: { id: 'live_1', expires_at: 1_789_367_057 },
          transport: { sdp: 'answer' },
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    try {
      const badVoice = await serveTour(
        post(GUIDE_SESSIONS_PATH, {
          voice: 'alloy',
          sdp: 'offer',
          scene: 'x',
        }),
        env(),
      )
      expect(badVoice.status).toBe(400)
      const created = await serveTour(
        post(GUIDE_SESSIONS_PATH, {
          voice: 'cedar',
          sdp: 'offer',
          scene: 'Current view: Saturn. Local time 21:04.',
        }),
        env(),
      )
      expect(created.status).toBe(200)
      expect(await read(created, decodeGuideSessionCreated)).toEqual({
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
      verdict.current = GRANTED
      const response = await serveTour(
        post(GUIDE_SESSIONS_PATH, {
          voice: 'marin',
          sdp: 'offer',
          scene: 'x',
        }),
        env(),
      )
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('upstream detail')
      // The browser gets nothing; the log gets the status and the path.
      expect(error).toHaveBeenCalledOnce()
      expect(error.mock.calls[0]![0]).toMatchObject({
        scope: 'server.tour',
        message: 'provider refused the session',
        path: GUIDE_SESSIONS_PATH,
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
      verdict.current = GRANTED
      const response = await serveTour(
        post(GUIDE_SESSIONS_PATH, {
          voice: 'marin',
          sdp: 'offer',
          scene: 'x',
        }),
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
      verdict.current = GRANTED
      const response = await serveTour(
        post(GUIDE_SESSIONS_PATH, {
          voice: 'marin',
          sdp: 'offer',
          scene: 'x',
        }),
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
