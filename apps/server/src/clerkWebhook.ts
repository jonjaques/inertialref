import { verifyWebhook } from '@clerk/backend/webhooks'
import { logger } from './log.ts'

/*
 * Clerk tells the Worker an account is gone, and the Worker tells PostHog
 * (docs/hosting.md § Account deletion).
 *
 * A person is keyed in PostHog by their Clerk user id, so deleting an account
 * in Clerk leaves its events and its person behind until something asks
 * PostHog to delete them. Clerk delivers the event through Svix, which signs
 * it and retries anything but a 2xx with backoff for days, so this route's
 * whole contract is its status: 200 for an event that is done with, 400 for
 * one nobody signed, and 503 for one PostHog has not yet accepted, which Svix
 * delivers again.
 *
 * **Both secrets are optional.** Every declared secret is required, and an
 * environment's upload fails while one is unset (`cloudflare.config.ts`). A
 * Clerk webhook names one URL, and a Worker Preview's URL changes with the
 * branch, so Previews Base can hold neither secret usefully and must not be
 * made to. They are therefore not declared: production holds them as Worker
 * secrets, `Env` does not know them, and this route reads them through
 * `WebhookSecrets`. Without either it answers 503, so a webhook pointed at a
 * deployment that cannot act on it keeps its events until one can.
 *
 * Nothing here is logged but the event type and status codes. The payload is a
 * person's account, and the user id is the one thing this route exists to
 * make PostHog forget.
 */

export const CLERK_WEBHOOK_PATH = '/api/clerk/webhook'

/** The two secrets this route reads, which no environment is required to hold. */
export interface WebhookSecrets {
  /** Svix's `whsec_…` signing secret, from the Clerk endpoint's page. */
  readonly CLERK_WEBHOOK_SIGNING_SECRET?: string
  /** A PostHog personal API key with `person:write`. */
  readonly POSTHOG_PERSON_DELETE_KEY?: string
}

/** What the route answers: a status Svix acts on, and a body its log shows. */
export interface WebhookAnswer {
  readonly status: 200 | 400 | 503
  readonly body: Readonly<Record<string, unknown>>
}

const log = logger('server.clerk')

/** PostHog's private API, US Cloud. */
const POSTHOG_APP_HOST = 'https://us.posthog.com'

/*
 * Under the 15 s Svix waits for an answer, so a PostHog that hangs is a 503
 * this route chose rather than a timeout Svix records with no body.
 */
const DELETE_TIMEOUT_MS = 10_000

/**
 * The deletion PostHog is asked for: the person, their events and their
 * recordings, by distinct id. `bulk_delete` rather than the single-person
 * `DELETE`, which takes the person's PostHog UUID and so needs a lookup first.
 */
export function personDeletion(
  projectId: string,
  key: string,
  userId: string,
): { readonly url: string; readonly init: RequestInit } {
  return {
    url: `${POSTHOG_APP_HOST}/api/projects/${encodeURIComponent(projectId)}/persons/bulk_delete/`,
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        distinct_ids: [userId],
        delete_events: true,
        delete_recordings: true,
      }),
    },
  }
}

/** Verify one delivery and act on it. The caller has checked it is a POST. */
export async function clerkWebhook(
  request: Request,
  env: Env & WebhookSecrets,
): Promise<WebhookAnswer> {
  const signingSecret = env.CLERK_WEBHOOK_SIGNING_SECRET ?? ''
  const key = env.POSTHOG_PERSON_DELETE_KEY ?? ''
  const projectId = String(env.POSTHOG_PROJECT_ID)
  if (signingSecret === '' || key === '' || projectId === '') {
    // The names, never the values; the values are the secrets.
    log('error', 'webhook not configured', {
      missing: [
        ...(signingSecret === '' ? ['CLERK_WEBHOOK_SIGNING_SECRET'] : []),
        ...(key === '' ? ['POSTHOG_PERSON_DELETE_KEY'] : []),
        ...(projectId === '' ? ['POSTHOG_PROJECT_ID'] : []),
      ],
    })
    return { status: 503, body: { error: 'not configured' } }
  }

  let event: Awaited<ReturnType<typeof verifyWebhook>>
  try {
    event = await verifyWebhook(request, { signingSecret })
  } catch {
    // Missing headers, a stale timestamp and a wrong signature all throw, and
    // all of them are a delivery nobody this route trusts signed.
    log('warn', 'webhook signature refused')
    return { status: 400, body: { error: 'signature refused' } }
  }

  if (event.type !== 'user.deleted') {
    log('info', 'webhook event ignored', { type: event.type })
    return { status: 200, body: { ignored: event.type } }
  }

  const userId = event.data.id
  if (typeof userId !== 'string' || userId === '') {
    /*
     * Signed and unusable. A retry carries the same payload, and Svix disables
     * an endpoint whose deliveries have failed for five days, which would stop
     * the deletions that do carry an id. So it is acknowledged, loudly.
     */
    log('error', 'deleted user carries no id', { type: event.type })
    return { status: 200, body: { ignored: 'no user id' } }
  }

  const { url, init } = personDeletion(projectId, key, userId)
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    })
  } catch (error) {
    log('error', 'PostHog unreachable', {
      type: event.type,
      error: error instanceof Error ? error.name : String(error),
    })
    return { status: 503, body: { error: 'PostHog unreachable' } }
  }

  if (!response.ok) {
    // A revoked or under-scoped key is a 401 or a 403 here, and a 503 to Svix
    // keeps the deletion queued while the key is fixed.
    log('error', 'person deletion refused', {
      type: event.type,
      status: response.status,
    })
    return {
      status: 503,
      body: { error: 'PostHog refused the deletion', status: response.status },
    }
  }

  /*
   * A 2xx can still carry `deletion_errors`: PostHog accepted the request
   * and failed the person. Answered 200 all the same, because a retry of a
   * permanent failure is five days of 503s until Svix disables the endpoint
   * and stops every deletion after it; logged as an error so it is read.
   */
  const counts = await deletionCounts(response)
  const failed = (counts['deletion_errors'] ?? 0) > 0
  log(
    failed ? 'error' : 'info',
    failed ? 'person deletion failed in part' : 'person deletion queued',
    {
      type: event.type,
      status: response.status,
      ...counts,
    },
  )
  return { status: 200, body: { deleted: !failed } }
}

/*
 * PostHog's 202 counts what it found and queued. `persons_found: 0` is an
 * account that never signed in while measured, which is a success; the counts
 * are logged so that it reads as one. A body that is not the expected shape
 * logs nothing extra, because the status has already decided the answer.
 */
async function deletionCounts(
  response: Response,
): Promise<Readonly<Record<string, number>>> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return {}
    const counts: Record<string, number> = {}
    for (const name of ['persons_found', 'persons_queued_for_deletion']) {
      const value: unknown = (body as Record<string, unknown>)[name]
      if (typeof value === 'number') counts[name] = value
    }
    const errors: unknown = (body as Record<string, unknown>)['deletion_errors']
    if (Array.isArray(errors)) counts['deletion_errors'] = errors.length
    return counts
  } catch {
    return {}
  }
}
