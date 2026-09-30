import { createClerkClient, verifyToken } from '@clerk/backend'
import {
  isClerkAPIResponseError,
  TokenVerificationError,
  TokenVerificationErrorReason,
} from '@clerk/backend/errors'
import { decodeJwt } from '@clerk/backend/jwt'
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
 * **Verified here, not by `authenticateRequest`.** That call is Clerk's answer
 * for a server that renders documents: it reads the cookie, compares it with
 * `__client_uat`, and answers a stale one with a redirect handshake. None of
 * that applies to a JSON endpoint behind `runWorkerFirst`, and all of it needs
 * the publishable key as well. `verifyToken` is the part underneath it.
 */

/** The two ways this deployment can check a signature, from the Worker's secrets. */
export interface AccountKeys {
  /**
   * `CLERK_SECRET_KEY`. Enough on its own: the instance's signing keys are
   * fetched with it once per isolate and cached.
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
 * Failures that are the deployment's, not the visitor's.
 *
 * Answering these as "signed out" would send a visitor with a perfectly good
 * session round a sign-in loop that cannot fix a secret nobody set. They throw,
 * and the route answers 503 — the same split the guide makes between a 4xx
 * and a misconfigured provider.
 */
const DEPLOYMENT_FAULTS: ReadonlySet<string> = new Set([
  TokenVerificationErrorReason.InvalidSecretKey,
  TokenVerificationErrorReason.LocalJWKMissing,
  TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  TokenVerificationErrorReason.RemoteJWKInvalid,
  TokenVerificationErrorReason.RemoteJWKMissing,
  TokenVerificationErrorReason.JWKFailedToResolve,
])

export class AccountUnavailableError extends Error {}

export async function identify(
  request: Request,
  keys: AccountKeys,
): Promise<AccountStatus> {
  if (!keys.secretKey && !keys.jwtKey) return UNCONFIGURED
  const token = bearer(request)
  if (token === null) return SIGNED_OUT

  /*
   * An empty list is not "no restriction" here, though it is to Clerk: its
   * check skips the claim entirely when there are no parties. A request to a
   * host this Worker does not recognize has no page it could have come from.
   */
  const parties = siteOrigins(request)
  if (parties.length === 0) {
    refused('unrecognized-host')
    return SIGNED_OUT
  }

  /*
   * The token's shape is judged here, before Clerk sees it. `verifyToken`
   * destructures the header ahead of its own error handling, so a header that
   * decodes to JSON `null` escapes as a `TypeError` — which the catch below
   * cannot tell from a key set that failed to parse, and would answer with a
   * 503 and an error record that any visitor could provoke at will. A header
   * with no `kid` is refused here too, rather than costing a key-set fetch.
   */
  if (!namesKey(token)) {
    refused('token-malformed')
    return SIGNED_OUT
  }

  let claims: Awaited<ReturnType<typeof verifyToken>>
  try {
    claims = await verifyToken(token, {
      ...(keys.jwtKey
        ? { jwtKey: keys.jwtKey }
        : { secretKey: keys.secretKey }),
      authorizedParties: [...parties],
    })
  } catch (error) {
    /*
     * The package's root export throws where its internal one returns a
     * result, and not only `TokenVerificationError`: a key-set fetch that
     * comes back as an HTML error page surfaces as the `SyntaxError` from
     * parsing it. Anything that is not a verdict on the token is therefore
     * the deployment's fault, whatever its class.
     */
    const reason =
      error instanceof TokenVerificationError ? error.reason : 'unexpected'
    if (reason === 'unexpected' || DEPLOYMENT_FAULTS.has(reason)) {
      log('error', 'account keys unusable', {
        reason,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      })
      throw new AccountUnavailableError(reason)
    }
    refused(reason)
    return SIGNED_OUT
  }

  /*
   * A pending session has signed in and not finished what the instance
   * requires of it — choosing an organization, say. Clerk's own request
   * check treats it as signed out by default, and so does this.
   */
  if (claims.sts === 'pending') return SIGNED_OUT
  return { configured: true, signedIn: true, userId: claims.sub }
}

/**
 * A user's private metadata, as the instance holds it now.
 *
 * Private metadata is the one place a grant can live that the visitor can
 * neither read nor write: it is not in the session token, not in the user
 * object the browser sees, and only a secret key can set it. That is what
 * makes it the right home for an authorization flag set by hand in the
 * dashboard — and why the answer costs a round trip to Clerk's API instead of
 * reading a claim. The route that asks is the one that decides what the flags
 * mean; this only fetches them.
 *
 * A user who no longer exists has none. Anything else that goes wrong is the
 * deployment's, and throws, for the reason `DEPLOYMENT_FAULTS` gives.
 */
export async function privateMetadata(
  userId: string,
  secretKey: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const user = await clientFor(secretKey).users.getUser(userId)
    return user.privateMetadata
  } catch (error) {
    if (isClerkAPIResponseError(error) && error.status === 404) return {}
    const reason = isClerkAPIResponseError(error)
      ? `backend-${error.status}`
      : 'backend-unreachable'
    log('error', 'user lookup failed', {
      reason,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    })
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
function refused(reason: string): void {
  log('warn', 'account token refused', { reason })
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether a token decodes to a header that names its key, and to claims. */
function namesKey(token: string): boolean {
  try {
    const { header, payload } = decodeJwt(token)
    return (
      isRecord(header) && typeof header.kid === 'string' && isRecord(payload)
    )
  } catch {
    return false
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
