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
  CLERK_WEBHOOK_PATH,
  clerkWebhook,
  personDeletion,
  type WebhookSecrets,
} from './clerkWebhook.ts'
import worker from './index.ts'

type IncomingRequest = Request<unknown, IncomingRequestCfProperties>

/*
 * The webhook against Clerk's real verifier, with deliveries signed here the
 * way Svix signs them, and PostHog stubbed at `fetch`. The answer that matters
 * is the status: Svix retries anything but a 2xx, so a 200 is "done" and a 503
 * is "ask again".
 */

const SITE = 'https://inertialref.app'
const USER = 'user_2deletedcanary'
const KEY = 'phx_delete_key_canary'
const DELETION_URL =
  'https://us.posthog.com/api/projects/719084/persons/bulk_delete/'

const encoder = new TextEncoder()
// `btoa` rather than `Buffer`: this project type-checks against workerd's
// globals, where Node's are not declared.
const base64 = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))

/** A Svix signing secret: `whsec_` and 24 random bytes in base64. */
const newSecret = (): string =>
  `whsec_${base64(crypto.getRandomValues(new Uint8Array(24)))}`

/**
 * A delivery as Svix sends one: `v1,` and the base64 HMAC-SHA256 of
 * `<id>.<timestamp>.<body>` under the secret's decoded bytes.
 */
async function delivery(
  payload: unknown,
  secret: string,
  {
    timestamp = Math.floor(Date.now() / 1000),
    body = JSON.stringify(payload),
  } = {},
): Promise<Request> {
  const id = `msg_${crypto.randomUUID()}`
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) =>
      c.charCodeAt(0),
    ),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${id}.${timestamp}.${JSON.stringify(payload)}`),
  )
  return new Request(`${SITE}${CLERK_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': `v1,${base64(signature)}`,
    },
    body,
  })
}

const event = (type: string, data: Record<string, unknown>) => ({
  type,
  object: 'event',
  data,
  timestamp: 1_730_000_000_000,
  instance_id: 'ins_test',
})
/** A `user.deleted` event; `{}` is one that names no user. */
const deleted = (who: { readonly id?: string } = { id: USER }) =>
  event('user.deleted', { object: 'user', deleted: true, ...who })

let secret: string
const posthog =
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

function env(overrides: Partial<WebhookSecrets> = {}): Env & WebhookSecrets {
  return {
    POSTHOG_PROJECT_ID: '719084',
    CLERK_WEBHOOK_SIGNING_SECRET: secret,
    POSTHOG_PERSON_DELETE_KEY: KEY,
    ...overrides,
  } as unknown as Env & WebhookSecrets
}

/** Every record the route wrote, as the text Workers Logs would index. */
const records = (): string =>
  JSON.stringify(
    (['debug', 'info', 'warn', 'error'] as const).flatMap(
      (level) => vi.mocked(console[level]).mock.calls,
    ),
  )

beforeAll(() => {
  secret = newSecret()
})
beforeEach(() => {
  posthog.mockReset()
  posthog.mockResolvedValue(
    Response.json(
      { persons_found: 1, persons_queued_for_deletion: 1, deletion_errors: [] },
      { status: 202 },
    ),
  )
  vi.stubGlobal('fetch', posthog)
  for (const level of ['debug', 'info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the Clerk webhook', () => {
  it('asks PostHog to delete the person, their events and their recordings', async () => {
    const answer = await clerkWebhook(await delivery(deleted(), secret), env())
    expect(answer.status).toBe(200)
    expect(posthog).toHaveBeenCalledOnce()
    const [url, init] = posthog.mock.calls[0]!
    expect(String(url)).toBe(DELETION_URL)
    expect(init?.method).toBe('POST')
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      distinct_ids: [USER],
      delete_events: true,
      delete_recordings: true,
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('builds the deletion for the project it is given', () => {
    const { url } = personDeletion('42', KEY, USER)
    expect(url).toBe(
      'https://us.posthog.com/api/projects/42/persons/bulk_delete/',
    )
  })

  it('logs the counts PostHog returns, and never the user id or the key', async () => {
    await clerkWebhook(await delivery(deleted(), secret), env())
    expect(console.info).toHaveBeenCalledWith({
      scope: 'server.clerk',
      message: 'person deletion queued',
      type: 'user.deleted',
      status: 202,
      persons_found: 1,
      persons_queued_for_deletion: 1,
      deletion_errors: 0,
    })
    expect(records()).not.toContain(USER)
    expect(records()).not.toContain(KEY)
  })

  it('answers a deletion PostHog accepted and failed with 200, and logs it as an error', async () => {
    // A retry of a permanent failure is days of 503s until Svix disables the
    // endpoint, so the answer stays 200; the error log is what gets it read.
    posthog.mockResolvedValue(
      Response.json(
        {
          persons_found: 1,
          persons_queued_for_deletion: 0,
          deletion_errors: [{ distinct_id: 'x', error: 'boom' }],
        },
        { status: 202 },
      ),
    )
    const answer = await clerkWebhook(await delivery(deleted(), secret), env())
    expect(answer).toEqual({ status: 200, body: { deleted: false } })
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'person deletion failed in part',
        deletion_errors: 1,
      }),
    )
  })

  it('takes a deletion PostHog found nobody for as done', async () => {
    // An account that never signed in while measured has no person.
    posthog.mockResolvedValue(
      Response.json(
        { persons_found: 0, persons_queued_for_deletion: 0 },
        { status: 202 },
      ),
    )
    expect(
      (await clerkWebhook(await delivery(deleted(), secret), env())).status,
    ).toBe(200)
  })

  it('refuses a delivery nobody it trusts signed, and asks PostHog nothing', async () => {
    const good = await delivery(deleted(), secret)
    const cases: [string, Request][] = [
      ['another secret', await delivery(deleted(), newSecret())],
      [
        'a changed body',
        await delivery(deleted(), secret, {
          body: JSON.stringify(deleted({ id: 'user_2somebodyelse' })),
        }),
      ],
      [
        'a stale timestamp',
        await delivery(deleted(), secret, {
          timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
        }),
      ],
      [
        'no signature',
        new Request(good.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(deleted()),
        }),
      ],
    ]
    for (const [name, request] of cases) {
      const answer = await clerkWebhook(request, env())
      expect(answer.status, name).toBe(400)
    }
    expect(posthog).not.toHaveBeenCalled()
    expect(records()).not.toContain(USER)
  })

  it('acknowledges every other event type and does nothing with it', async () => {
    for (const type of ['user.created', 'user.updated', 'session.created']) {
      const answer = await clerkWebhook(
        await delivery(event(type, { id: USER, object: 'user' }), secret),
        env(),
      )
      expect(answer, type).toEqual({ status: 200, body: { ignored: type } })
    }
    expect(posthog).not.toHaveBeenCalled()
  })

  it('acknowledges a deletion with no id rather than have Svix retry it forever', async () => {
    const answer = await clerkWebhook(
      await delivery(deleted({}), secret),
      env(),
    )
    expect(answer.status).toBe(200)
    expect(posthog).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledOnce()
  })

  it('answers 503 while PostHog has not accepted the deletion, so Svix retries', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502]) {
      posthog.mockResolvedValueOnce(new Response('{}', { status }))
      const answer = await clerkWebhook(
        await delivery(deleted(), secret),
        env(),
      )
      expect(answer.status, String(status)).toBe(503)
      expect(answer.body).toEqual({
        error: 'PostHog refused the deletion',
        status,
      })
    }
    posthog.mockRejectedValueOnce(new TypeError('Network connection lost.'))
    const unreachable = await clerkWebhook(
      await delivery(deleted(), secret),
      env(),
    )
    expect(unreachable).toEqual({
      status: 503,
      body: { error: 'PostHog unreachable' },
    })
    expect(records()).not.toContain(USER)
  })

  it('answers 503 without its secrets, before reading the delivery', async () => {
    for (const [overrides, missing] of [
      [
        { CLERK_WEBHOOK_SIGNING_SECRET: undefined },
        ['CLERK_WEBHOOK_SIGNING_SECRET'],
      ],
      [{ POSTHOG_PERSON_DELETE_KEY: undefined }, ['POSTHOG_PERSON_DELETE_KEY']],
      [{ POSTHOG_PERSON_DELETE_KEY: '' }, ['POSTHOG_PERSON_DELETE_KEY']],
      [
        {
          CLERK_WEBHOOK_SIGNING_SECRET: undefined,
          POSTHOG_PERSON_DELETE_KEY: undefined,
        },
        ['CLERK_WEBHOOK_SIGNING_SECRET', 'POSTHOG_PERSON_DELETE_KEY'],
      ],
    ] as const) {
      vi.mocked(console.error).mockClear()
      const request = await delivery(deleted(), secret)
      const answer = await clerkWebhook(request, env(overrides))
      expect(answer).toEqual({ status: 503, body: { error: 'not configured' } })
      expect(request.bodyUsed).toBe(false)
      expect(console.error).toHaveBeenCalledOnce()
      expect(console.error).toHaveBeenCalledWith({
        scope: 'server.clerk',
        message: 'webhook not configured',
        missing,
      })
    }
    expect(posthog).not.toHaveBeenCalled()
  })

  describe('through the handler', () => {
    const handle = (request: Request, bindings: Env) =>
      worker.fetch(request as IncomingRequest, bindings, {} as ExecutionContext)

    it('answers a POST with the route verdict as JSON', async () => {
      const response = await handle(await delivery(deleted(), secret), env())
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ deleted: true })
    })

    it('refuses anything but a POST', async () => {
      const response = await handle(
        new Request(`${SITE}${CLERK_WEBHOOK_PATH}`),
        env(),
      )
      expect(response.status).toBe(405)
      expect(posthog).not.toHaveBeenCalled()
    })

    it('reads the optional secrets off the environment it is given', async () => {
      // Exactly the `Env` the declared bindings produce: no webhook secrets.
      const bare = { POSTHOG_PROJECT_ID: '719084' } as unknown as Env
      const response = await handle(await delivery(deleted(), secret), bare)
      expect(response.status).toBe(503)
    })
  })
})
