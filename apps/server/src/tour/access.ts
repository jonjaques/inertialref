import type { GuideRefusal } from '@inertialref/protocol'
import { accountKeys, identify, privateMetadata } from '../account.ts'

/*
 * Who may use the guide, on this deployment.
 *
 * A signed-in account whose private metadata says `admin: true` or
 * `tour: true`, set by hand in Clerk's dashboard. The guide spends the OpenAI
 * project's budget on every minute of conversation, so it is a grant rather
 * than a consequence of having signed up — and private metadata is the grant
 * the visitor can neither see nor write (`account.ts` has why).
 *
 * The account module answers who is asking and hands over the flags; what the
 * flags mean for the guide, and whether this deployment offers the guide at
 * all, is decided here and nowhere else. The route maps the answer to a status
 * code and a sentence and decides nothing of its own.
 */

/**
 * The verdict for one request: the protocol's refusals, and on a grant the
 * account a per-account allowance is keyed on.
 */
export type GuideAccess =
  | { readonly granted: true; readonly userId: string }
  | { readonly granted: false; readonly reason: GuideRefusal }

const refuse = (reason: GuideRefusal): GuideAccess => ({
  granted: false,
  reason,
})

/** The two flags that grant the guide. Strictly `true`: a string is not a grant. */
export const grantsGuide = (flags: Readonly<Record<string, unknown>>) =>
  flags.admin === true || flags.tour === true

/**
 * The verdict for one request on this deployment.
 *
 * The guide is offered when three things hold: a provider key, the guide not
 * switched off, and accounts with a secret key at the host the request came to
 * (`accountKeys`). The secret key is part of it because a JWT key alone can
 * verify a session and cannot read the metadata the grant lives in. Anything
 * short of all three is `unavailable` — the deployment's answer, decided
 * before the visitor's token is read, so a fork with no keys never calls Clerk.
 *
 * A throw is `AccountUnavailableError`: the accounts could not be reached,
 * which the route answers as unavailable too, with the account module's
 * reason in the log.
 */
export async function guideAccess(
  request: Request,
  env: Env,
): Promise<GuideAccess> {
  const keys = accountKeys(env, request)
  const secretKey = keys.secretKey
  if (
    !env.OPENAI_API_KEY ||
    !secretKey ||
    String(env.TOUR_GUIDE_ENABLED) === 'false'
  )
    return refuse('unavailable')
  const status = await identify(request, keys)
  if (!status.signedIn || status.userId === null) return refuse('signed-out')
  return grantsGuide(await privateMetadata(status.userId, secretKey))
    ? { granted: true, userId: status.userId }
    : refuse('not-granted')
}
