/*
 * Allowances, declared as rate-limit bindings in `cloudflare.config.ts`.
 *
 * Cloudflare counts per location and settles eventually, so a limit here is a
 * bound on abuse rather than an accounting: a burst spread across locations
 * gets somewhat past it, and a person never comes near it. That is the job.
 * What each one protects is the thing behind it that costs — Clerk's API and
 * its own rate limit for the account routes, the OpenAI project's budget for a
 * guide session — and the caches in `account.ts` already make the common path
 * free, so these only ever bite a script.
 *
 * A socket is one request here, however long it lives. Messages on it never
 * reach this Worker's `fetch`, so an authority holding sockets owns its own
 * per-connection allowance (ADR-0048).
 */

/**
 * Whether `key` is within `limiter`'s allowance. Absent is unlimited: the
 * tests construct an environment without bindings, and `cf dev` simulates
 * them locally.
 */
export async function allowed(
  limiter: RateLimit | undefined,
  key: string,
): Promise<boolean> {
  if (limiter === undefined) return true
  return (await limiter.limit({ key })).success
}

/**
 * The address a request came from, hashed with a scope. The limiter holds its
 * keys somewhere this Worker cannot see into, so what it is handed is a digest
 * rather than a person's address. `cf dev` has no edge to name one, and every
 * local request shares a key.
 */
export async function sourceKey(
  request: Request,
  scope: string,
): Promise<string> {
  const address = request.headers.get('cf-connecting-ip') ?? 'development'
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${scope}:${address}`),
  )
  return [...new Uint8Array(digest).subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** How long a refused caller should wait, in seconds: the limiters' period. */
export const RETRY_AFTER = '60'
