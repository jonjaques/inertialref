import { createClerkClient } from '@clerk/backend'
import {
  isClerkAPIResponseError,
  TokenVerificationError,
} from '@clerk/backend/errors'
import { decodeJwt, verifyJwt } from '@clerk/backend/jwt'
import type { AccountStatus } from '@inertialref/protocol'
import { logger } from './log.ts'
import { siteOrigins } from './origins.ts'

/*
 * Who is asking, as the Worker decides it (docs/hosting.md H-2).
 *
 * The identity provider is Clerk, and this is the only file in the Worker that
 * knows it. The browser signs in against Clerk directly — the Worker is never in
 * that conversation and never holds a password — and then presents the
 * short-lived session token Clerk minted for it. What the Worker owns is the
 * verdict on that token: signature, lifetime, and which page asked for it.
 *
 * **The token arrives as a bearer header, never as the `__session` cookie.**
 * The cookie is on this origin and a same-origin request carries it, so reading
 * it would work — and would make every endpoint that trusts it a cross-site
 * request forgery target, because the browser attaches a cookie to a request a
 * hostile page started. A header is something only this site's own script can
 * set. It is also fresher: the cookie is refreshed on a timer that a background
 * tab throttles, while `getToken()` refreshes on demand, so a tab left open
 * overnight is signed in the moment it asks rather than one refresh later.
 *
 * **Verified here, not by `authenticateRequest`, and not by `verifyToken`
 * either.** The first is Clerk's answer for a server that renders documents:
 * it reads the cookie, compares it with `__client_uat`, and answers a stale
 * one with a redirect handshake. None of that applies to a JSON endpoint
 * behind `runWorkerFirst`. The second is the part underneath it, and its key
 * handling is wrong for this Worker in three ways `signingKey` below spells
 * out. What is left once the key is in hand is `verifyJwt` — the function
 * `verifyToken` itself ends in — and one claim check it adds, made here.
 *
 * **Every check after the first is arithmetic.** The key set is held for the
 * isolate and a grant for a minute, so the hot path of a request makes no call
 * to Clerk. That is what lets the same verdict serve a socket that re-presents
 * a fresh token every minute for as long as a player is online (ADR-0048): the
 * socket calls `verifySession` with each one, and each costs a signature check.
 */

/** The two ways this deployment can check a signature, from the Worker's secrets. */
export interface AccountKeys {
  /**
   * `CLERK_SECRET_KEY`. Enough on its own: the instance's signing keys are
   * fetched with it and held for the isolate (`signingKey`).
   */
  readonly secretKey?: string | undefined
  /**
   * The instance's PEM public key: with it the signature check makes no
   * network call. The Worker does not carry one — a declared secret is a
   * required one (`cloudflare.config.ts`) — and the tests do, because it is
   * the path that verifies a token without Clerk on the other end.
   */
  readonly jwtKey?: string | undefined
}

/**
 * The keys this deployment checks accounts with, or none while
 * `CLERK_ENABLED` is off.
 *
 * Which Clerk instance that is was decided before the request arrived: each
 * environment holds its own `CLERK_SECRET_KEY` — production the production
 * instance's, Previews Base the development instance's — and the browser was
 * built with the matching publishable key. Off means "not configured", the
 * answer a fork gets, and the guide admits nobody.
 */
export function accountKeys(env: Env): AccountKeys {
  return String(env.CLERK_ENABLED) === 'false'
    ? {}
    : { secretKey: env.CLERK_SECRET_KEY }
}

const log = logger('server.account')

const UNCONFIGURED: AccountStatus = {
  configured: false,
  signedIn: false,
  userId: null,
}
const SIGNED_OUT: AccountStatus = {
  configured: true,
  signedIn: false,
  userId: null,
}

/**
 * The deployment could not reach a verdict — no keys, or Clerk unreachable
 * with nothing held.
 *
 * Answering that as "signed out" would send a visitor with a perfectly good
 * session round a sign-in loop that cannot fix a secret nobody set. It throws,
 * and the route answers 503 — the same split the guide makes between a 4xx
 * and a misconfigured provider.
 */
export class AccountUnavailableError extends Error {}

/** A session token the Worker accepted: who, which session, and until when. */
export interface Session {
  readonly userId: string
  /** Clerk's session id, which is what signing out elsewhere revokes. */
  readonly sessionId: string
  /**
   * When the token stops being evidence, in seconds since the epoch. A
   * connection that outlives it needs a fresh token before then.
   */
  readonly expiresAt: number
}

/**
 * The verdict on one session token, for a page on one of `parties`.
 *
 * `null` is a token that proves nobody — forged, expired, for another site,
 * signed by a key this instance does not hold, or a session still pending its
 * tasks — and the reason is logged. A throw is `AccountUnavailableError`.
 * This takes the bare token so that a caller with no request to read it from,
 * a socket re-presenting one, gets the same verdict as a request does.
 */
export async function verifySession(
  token: string,
  keys: AccountKeys,
  parties: readonly string[],
): Promise<Session | null> {
  /*
   * An empty list is not "no restriction" here, though it is to Clerk: its
   * check skips the claim entirely when there are no parties. A request to a
   * host this Worker does not recognize has no page it could have come from.
   */
  if (parties.length === 0) return refused('unrecognized-host')

  /*
   * The token's shape is judged before anything else sees it. Clerk
   * destructures the header ahead of its own error handling, so a header that
   * decodes to JSON `null` escapes as a `TypeError` — which would read as the
   * deployment's fault, a 503 any visitor could provoke at will. And the key
   * id is what the key set is looked up by.
   */
  const kid = keyId(token)
  if (kid === null) return refused('token-malformed')

  let key: JsonWebKey | string | null
  if (keys.jwtKey) key = keys.jwtKey
  else if (keys.secretKey) key = await signingKey(kid, keys.secretKey)
  else throw new AccountUnavailableError('unconfigured')
  if (key === null) return refused('jwk-kid-mismatch')

  let claims: Readonly<Record<string, unknown>>
  try {
    claims = await verifyJwt(token, {
      key,
      authorizedParties: [...parties],
    })
  } catch (error) {
    /*
     * The package's exports throw where its internals return a result. Every
     * `TokenVerificationError` from here is a verdict on the token — the key
     * is already in hand — and anything else is not, so it is the
     * deployment's, whatever its class.
     */
    if (error instanceof TokenVerificationError) return refused(error.reason)
    log('error', 'token check failed', { error: errorText(error) })
    throw new AccountUnavailableError('unexpected')
  }

  /*
   * A session token names its session. That is the check `verifyToken` makes
   * and `verifyJwt` does not: the instance's key also signs machine tokens,
   * whose subject is a machine and which carry no session to revoke.
   */
  const { sub, sid, exp, sts } = claims
  if (
    typeof sub !== 'string' ||
    typeof sid !== 'string' ||
    typeof exp !== 'number'
  )
    return refused('not-a-session')
  /*
   * A pending session has signed in and not finished what the instance
   * requires of it — choosing an organization, say. Clerk's own request
   * check treats it as signed out by default, and so does this.
   */
  if (sts === 'pending') return refused('session-pending')
  return { userId: sub, sessionId: sid, expiresAt: exp }
}

/** Who a request is from, by the bearer token it carries. */
export async function identify(
  request: Request,
  keys: AccountKeys,
): Promise<AccountStatus> {
  if (!keys.secretKey && !keys.jwtKey) return UNCONFIGURED
  const token = bearer(request)
  if (token === null) return SIGNED_OUT
  const session = await verifySession(token, keys, siteOrigins(request))
  return session === null
    ? SIGNED_OUT
    : { configured: true, signedIn: true, userId: session.userId }
}

/*
 * The instance's signing keys, held for the isolate.
 *
 * `verifyToken` given the secret key fetches the key set itself and keeps it
 * five minutes, and three things about that are wrong here. A token naming a
 * key the cache lacks is a fetch every time, so an invented `kid` makes every
 * request a call to Clerk — five of them over two seconds while Clerk is
 * failing. An expired cache is emptied before the refetch, so a Clerk outage
 * signs out every visitor five minutes in, including keys verified a second
 * ago. And a socket re-presenting a token every minute for hours should pay a
 * signature check each time, not a round trip.
 *
 * So the set is fetched here, one request at a time per isolate:
 *
 *   fresh   A key younger than `KEYS_FRESH_MS` is used with no I/O. Five
 *           minutes is Clerk's own window, so a signing key removed from the
 *           instance is trusted no longer than the SDK would trust it.
 *   stale   An older one is refreshed first. If the refresh fails the held
 *           key is used anyway, until `KEYS_STALE_MS` — past that, a check
 *           Clerk could not confirm fails closed.
 *   unknown A `kid` the set lacks is one refetch, then a refusal. Refetches
 *           and retries after a failure are at most one per `KEYS_RETRY_MS`,
 *           so no visitor can make this Worker call Clerk faster than that.
 */
const KEYS_FRESH_MS = 5 * 60_000
const KEYS_STALE_MS = 60 * 60_000
const KEYS_RETRY_MS = 60_000

interface KeySet {
  keys: ReadonlyMap<string, JsonWebKey>
  /** The last fetch that succeeded; `-Infinity` before the first. */
  loadedAt: number
  /** The last fetch, whichever way it went. */
  attemptedAt: number
  /** Why the last fetch failed, or `null` if it did not. */
  failure: string | null
  pending: Promise<void> | null
}

const keySets = new Map<string, KeySet>()

/**
 * The key a token names, `null` for one this instance does not have, or a
 * throw when nobody could say.
 */
async function signingKey(
  kid: string,
  secretKey: string,
): Promise<JsonWebKey | null> {
  let set = keySets.get(secretKey)
  if (set === undefined) {
    set = {
      keys: new Map(),
      loadedAt: -Infinity,
      attemptedAt: -Infinity,
      failure: null,
      pending: null,
    }
    keySets.set(secretKey, set)
  }
  const held = set.keys.get(kid)
  if (held !== undefined && Date.now() - set.loadedAt < KEYS_FRESH_MS)
    return held
  if (set.pending === null && Date.now() - set.attemptedAt >= KEYS_RETRY_MS)
    set.pending = load(set, secretKey)
  if (set.pending !== null) await set.pending

  const key = set.keys.get(kid)
  if (key !== undefined) {
    if (Date.now() - set.loadedAt < KEYS_STALE_MS) return key
    throw new AccountUnavailableError(set.failure ?? 'keys-expired')
  }
  // Not a key of this instance — unless the instance could not be asked.
  if (set.failure !== null) throw new AccountUnavailableError(set.failure)
  return null
}

/** One fetch of the key set. Never throws: the outcome is written to `set`. */
async function load(set: KeySet, secretKey: string): Promise<void> {
  set.attemptedAt = Date.now()
  try {
    const { keys = [] } = await clientFor(secretKey).jwks.getJwks()
    const held = new Map<string, JsonWebKey>()
    for (const { kid, kty, alg, n, e } of keys)
      if (kty === 'RSA') held.set(kid, { kty, alg, n, e })
    if (held.size === 0) throw new Error('the key set holds no RSA keys')
    set.keys = held
    set.loadedAt = Date.now()
    set.failure = null
  } catch (error) {
    set.failure = isClerkAPIResponseError(error)
      ? `keys-${error.status}`
      : 'keys-unreachable'
    log('error', 'signing keys unavailable', {
      reason: set.failure,
      held: set.keys.size,
      error: errorText(error),
    })
  } finally {
    set.pending = null
  }
}

/**
 * A user's private metadata, as the instance held it at most a minute ago.
 *
 * Private metadata is the one place a grant can live that the visitor can
 * neither read nor write: it is not in the session token, not in the user
 * object the browser sees, and only a secret key can set it. That is what
 * makes it the right home for an authorization flag set by hand in the
 * dashboard — and why the answer costs a round trip to Clerk's API instead of
 * reading a claim. The route that asks is the one that decides what the flags
 * mean; this only fetches them.
 *
 * Held for `GRANT_TTL_MS` per user, and concurrent asks share one call. The
 * capabilities check and the session request arrive seconds apart for the
 * same person, and a socket re-reads a grant on a cadence rather than per
 * message; a minute is the revocation delay that buys. What goes wrong is
 * not held — the next ask asks again.
 *
 * A user who no longer exists has none. Anything else that goes wrong is the
 * deployment's, and throws.
 */
export function privateMetadata(
  userId: string,
  secretKey: string,
): Promise<Flags> {
  const key = `${secretKey}\n${userId}`
  const now = Date.now()
  const held = grants.get(key)
  if (held !== undefined && now - held.at < GRANT_TTL_MS) return held.flags
  // Deleted and set again, so insertion order stays age order and the first
  // entry is always the one to evict.
  grants.delete(key)
  if (grants.size >= GRANT_LIMIT) {
    const oldest = grants.keys().next()
    if (oldest.done !== true) grants.delete(oldest.value)
  }
  const flags = lookUp(userId, secretKey)
  grants.set(key, { at: now, flags })
  void flags.catch(() => {
    if (grants.get(key)?.flags === flags) grants.delete(key)
  })
  return flags
}

type Flags = Readonly<Record<string, unknown>>

const GRANT_TTL_MS = 60_000
/** Far above the accounts this alpha has; a bound on memory, not a working set. */
const GRANT_LIMIT = 1024
const grants = new Map<
  string,
  { readonly at: number; readonly flags: Promise<Flags> }
>()

async function lookUp(userId: string, secretKey: string): Promise<Flags> {
  try {
    const user = await clientFor(secretKey).users.getUser(userId)
    return user.privateMetadata
  } catch (error) {
    if (isClerkAPIResponseError(error) && error.status === 404) return {}
    const reason = isClerkAPIResponseError(error)
      ? `backend-${error.status}`
      : 'backend-unreachable'
    log('error', 'user lookup failed', { reason, error: errorText(error) })
    throw new AccountUnavailableError(reason)
  }
}

/*
 * One Backend API client per key for the life of the isolate. A client is the
 * key plus a set of endpoint objects, and nothing in it belongs to a request,
 * so building one per lookup is work every guide request repeats for nothing.
 */
const clients = new Map<string, ReturnType<typeof createClerkClient>>()

function clientFor(secretKey: string): ReturnType<typeof createClerkClient> {
  let client = clients.get(secretKey)
  if (client === undefined) {
    client = createClerkClient({ secretKey })
    clients.set(secretKey, client)
  }
  return client
}

/** The reason code only. A token is a credential until it expires. */
function refused(reason: string): null {
  log('warn', 'account token refused', { reason })
  return null
}

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The key a token's header names, if it decodes to a header and claims. */
function keyId(token: string): string | null {
  try {
    const { header, payload } = decodeJwt(token)
    return isRecord(header) &&
      typeof header.kid === 'string' &&
      header.kid !== '' &&
      isRecord(payload)
      ? header.kid
      : null
  } catch {
    return null
  }
}

/** Longer than any session token Clerk mints; a bound, not a format check. */
const TOKEN_LIMIT = 8192

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header === null || header.length > TOKEN_LIMIT) return null
  const match = /^Bearer (\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}
