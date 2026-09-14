import { describe, expect, it, vi } from 'vitest'
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
      expect(delegation.responses.parallel_tool_calls).toBe(false)
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
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
