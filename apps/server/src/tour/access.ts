import { identify, privateMetadata } from '../account.ts'

/*
 * Who may use the guide.
 *
 * A signed-in account whose private metadata says `admin: true` or
 * `tour: true`, set by hand in Clerk's dashboard. The guide spends the OpenAI
 * project's budget on every minute of conversation, so it is a grant rather
 * than a consequence of having signed up — and private metadata is the grant
 * the visitor can neither see nor write (`account.ts` has why).
 *
 * The account module answers who is asking and hands over the flags; what the
 * flags mean for the guide is decided here and nowhere else.
 */

export interface GuideAccess {
  readonly signedIn: boolean
  readonly authorized: boolean
}

const NOBODY: GuideAccess = { signedIn: false, authorized: false }

/** The two flags that grant the guide. Strictly `true`: a string is not a grant. */
export const grantsGuide = (flags: Readonly<Record<string, unknown>>) =>
  flags.admin === true || flags.tour === true

/**
 * The verdict for one request. Needs the secret key — a JWT key alone can
 * verify a session but cannot read metadata — so a Worker without it grants
 * the guide to nobody.
 */
export async function guideAccess(
  request: Request,
  env: Env,
): Promise<GuideAccess> {
  const secretKey = env.CLERK_SECRET_KEY
  if (!secretKey) return NOBODY
  const status = await identify(request, {
    secretKey,
    jwtKey: env.CLERK_JWT_KEY,
  })
  if (!status.signedIn || status.userId === null) return NOBODY
  return {
    signedIn: true,
    authorized: grantsGuide(await privateMetadata(status.userId, secretKey)),
  }
}
