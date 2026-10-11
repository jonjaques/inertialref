import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
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
import { fakeClerk, session, type Signer, signer } from '../testTokens.ts'
import { serveTour } from './routes.ts'

/*
 * The route over the real verdict: `access.ts` decides, from the `Env` and
 * the token, against Clerk's Backend API stubbed at `fetch` beside the
 * provider. What each grant means is `access.test.ts`'s; here it is which
 * status and sentence each verdict becomes, and that the provider is asked
 * only for a granted account.
 */

const ORIGIN = 'http://localhost:5173'

let issuer: Signer
beforeAll(async () => {
  issuer = await signer()
})

/** Who is asking: nobody, or `user_2test` holding the given grant. */
let clerk: ReturnType<typeof fakeClerk>
let token: string | undefined
const provider =
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

async function signIn(privateMetadata: Record<string, unknown>) {
  clerk.state.users.user_2test = privateMetadata
  token = await issuer.sign(session({ azp: ORIGIN }))
}
const GRANT = { tour: true }

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

/*
 * A fresh secret key per test: the key set and the grants are held per key
 * for the isolate (`account.ts`), so a test reusing one would read the grant
 * the last one set.
 */
let instances = 0
function env(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: 'key-canary',
    CLERK_SECRET_KEY: `sk_test_route_${++instances}`,
    CLERK_ENABLED: 'true',
    TOUR_GUIDE_ENABLED: 'true',
    ...overrides,
  } as unknown as Env
}

const signedHeaders = (): Record<string, string> =>
  token === undefined ? {} : { authorization: `Bearer ${token}` }

function post(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...signedHeaders(),
    },
    body: JSON.stringify(body),
  })
}

describe('the guide Worker', () => {
  // Every refusal writes a record; the test output is not where they go.
  beforeEach(() => {
    clerk = fakeClerk(issuer)
    token = undefined
    provider.mockReset()
    provider.mockImplementation(async () => {
      throw new Error('the provider was asked')
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) =>
          clerk.answer(input, init) ?? provider(input, init),
      ),
    )
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('answers a verdict: granted with its voices, or refused with a reason', async () => {
    const ask = (overrides?: Partial<Env>, origin = ORIGIN) =>
      serveTour(
        new Request(`${origin}${GUIDE_VERDICT_PATH}`, {
          headers: { 'sec-fetch-site': 'same-origin', ...signedHeaders() },
        }),
        env(overrides),
      ).then((response) => {
        expect(response.status).toBe(200)
        return read(response, decodeGuideVerdict)
      })
    expect(await ask()).toEqual({ granted: false, reason: 'signed-out' })
    await signIn({})
    expect(await ask()).toEqual({ granted: false, reason: 'not-granted' })
    await signIn(GRANT)
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
    const ask = () =>
      serveTour(
        post(GUIDE_SESSIONS_PATH, { voice: 'marin', sdp: 'offer', scene: 'x' }),
        env(),
      )
    const anonymous = await ask()
    expect(anonymous.status).toBe(401)
    expect(await read(anonymous, decodeGuideError)).toEqual({
      error: GUIDE_REFUSAL_SENTENCES['signed-out'],
    })
    await signIn({})
    const ungranted = await ask()
    expect(ungranted.status).toBe(403)
    expect(await read(ungranted, decodeGuideError)).toEqual({
      error: GUIDE_REFUSAL_SENTENCES['not-granted'],
    })
    // The provider is never asked on behalf of either.
    expect(provider).not.toHaveBeenCalled()
  })

  it('refuses a session on a deployment that does not offer the guide, with 503', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await signIn(GRANT)
    for (const overrides of [
      { OPENAI_API_KEY: undefined },
      { TOUR_GUIDE_ENABLED: 'false' },
      { CLERK_ENABLED: 'false' },
      { CLERK_SECRET_KEY: undefined },
    ] as unknown as Partial<Env>[]) {
      const refused = await serveTour(
        post(GUIDE_SESSIONS_PATH, { voice: 'marin', sdp: 'offer', scene: 'x' }),
        env(overrides),
      )
      expect(refused.status).toBe(503)
      expect(await read(refused, decodeGuideError)).toEqual({
        error: GUIDE_REFUSAL_SENTENCES.unavailable,
      })
    }
    // The deployment's fault, so logged as one.
    expect(error).toHaveBeenCalledTimes(4)
    expect(clerk.state.calls).toEqual([])
    expect(provider).not.toHaveBeenCalled()
  })

  it('answers 503 when the accounts behind the grant cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await signIn(GRANT)
    clerk.state.status = 500
    const response = await serveTour(
      post(GUIDE_SESSIONS_PATH, { voice: 'marin', sdp: 'offer', scene: 'x' }),
      env(),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'The guide is unavailable.',
    })
    expect(provider).not.toHaveBeenCalled()
  })

  it('refuses a session past the account’s allowance, before the provider is asked', async () => {
    await signIn(GRANT)
    const limit = vi.fn(async (_options: RateLimitOptions) => ({
      success: false,
    }))
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
    expect(provider).not.toHaveBeenCalled()
  })

  it('creates a session for a granted account, with the authored configuration', async () => {
    await signIn(GRANT)
    provider.mockImplementation(async () =>
      Response.json({
        session: { id: 'live_1', expires_at: 1_789_367_057 },
        transport: { sdp: 'answer' },
      }),
    )
    const badVoice = await serveTour(
      post(GUIDE_SESSIONS_PATH, { voice: 'alloy', sdp: 'offer', scene: 'x' }),
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
    expect(provider).toHaveBeenCalledOnce()
    const call = provider.mock.calls[0]!
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
  })

  it('answers a provider failure with 503 and no detail', async () => {
    await signIn(GRANT)
    provider.mockImplementation(
      async () => new Response('upstream detail', { status: 500 }),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await serveTour(
      post(GUIDE_SESSIONS_PATH, { voice: 'marin', sdp: 'offer', scene: 'x' }),
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
  })

  it("logs the provider's error record for a refused key, without the key", async () => {
    await signIn(GRANT)
    provider.mockImplementation(
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
          { status: 401, headers: { 'x-request-id': 'req_probe' } },
        ),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await serveTour(
      post(GUIDE_SESSIONS_PATH, { voice: 'marin', sdp: 'offer', scene: 'x' }),
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
  })

  it('names a thrown fetch as the cause when the provider never answers', async () => {
    await signIn(GRANT)
    provider.mockImplementation(async () => {
      throw new TypeError('Invalid header value')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await serveTour(
      post(GUIDE_SESSIONS_PATH, { voice: 'marin', sdp: 'offer', scene: 'x' }),
      env(),
    )
    expect(response.status).toBe(503)
    expect(error.mock.calls[0]![0]).toMatchObject({
      code: 'unavailable',
      cause: 'TypeError: Invalid header value',
    })
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
