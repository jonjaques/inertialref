import { logger } from './log.ts'

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

const log = logger('server.limits')

/**
 * Whether `key` is within `limiter`'s allowance. Absent is unlimited: the
 * tests construct an environment without bindings, and `cf dev` simulates
 * them locally.
 *
 * A limiter that fails admits, and says so. The allowance bounds a script; a
 * binding error answered with a throw would be a Worker exception on every
 * account and guide request, which is an outage the limit exists to prevent.
 */
export async function allowed(
  limiter: RateLimit | undefined,
  key: string,
): Promise<boolean> {
  if (limiter === undefined) return true
  try {
    return (await limiter.limit({ key })).success
  } catch (error) {
    log('error', 'rate limiter failed', {
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    })
    return true
  }
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
  const address = subnet(
    request.headers.get('cf-connecting-ip') ?? 'development',
  )
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${scope}:${address}`),
  )
  return [...new Uint8Array(digest).subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The unit one caller controls: an IPv4 address, or an IPv6 address's /64.
 *
 * A subscriber is routinely delegated a whole /64 and picks addresses in it
 * freely, so keyed on the full IPv6 address a script rotates past any
 * per-address allowance with 2^64 keys to spare. Anything that is not plain
 * IPv6 — IPv4, an IPv4-mapped form, `development` — is its own key.
 */
export function subnet(address: string): string {
  if (!address.includes(':') || address.includes('.')) return address
  const [head = '', tail] = address.toLowerCase().split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill(
            '0',
          ),
          ...right,
        ]
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

/** How long a refused caller should wait, in seconds: the limiters' period. */
export const RETRY_AFTER = '60'
