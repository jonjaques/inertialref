import {
  type AccountStatus,
  type Feature,
  FEATURES,
} from '@inertialref/protocol'
import { accountKeys, identify, privateMetadata } from './account.ts'

/*
 * What an account's private metadata grants it.
 *
 * Every grant is a flag set by hand in Clerk's dashboard — **Users** → the
 * user → **Metadata** → **Private** — and read by the Worker alone
 * (`privateMetadata` in `account.ts` has why private metadata is the home for
 * it). This module is the one place a flag's name is given a meaning, so a
 * feature asks `grants(flags, 'solo')` and never reads `flags.solo` itself:
 * reading the key directly would skip `admin`, and an admin who is refused a
 * feature they were promised is a bug filed against the dashboard, not here.
 *
 * `admin` grants every feature, including one added after the flag was set.
 * The alternative — an admin carrying every feature flag by hand — is a grant
 * list that goes stale the day a feature ships.
 *
 * A flag is strictly `true`. The dashboard's editor takes any JSON, and
 * `"true"` or `1` typed there is a mistake to refuse rather than a grant to
 * guess at.
 *
 * The feature names are `FEATURES` in `packages/protocol`, not here, because
 * the browser spells them too: the account record carries the ones an
 * account is granted, and the menu offers a mode by them.
 */

/** An account's private metadata, as `privateMetadata` hands it over. */
export type Flags = Readonly<Record<string, unknown>>

/** Whether these flags grant `feature`: its own flag, or `admin`. */
export const grants = (flags: Flags, feature: Feature): boolean =>
  flags.admin === true || flags[feature] === true

/** Every feature these flags grant, in `FEATURES` order. */
export const granted = (flags: Flags): readonly Feature[] =>
  FEATURES.filter((feature) => grants(flags, feature))

/**
 * The answer at `ACCOUNT_PATH`: who is asking, and what they are granted.
 *
 * The browser cannot read private metadata, so this is how it learns which
 * held-out modes to offer — the menu's doors for solo and multiplayer
 * (`apps/game/src/pages/modes.ts`). Only the reading is sent, never the flags:
 * `admin` stays on this side of the wire, and so does anything else a person
 * typed into the dashboard.
 *
 * A grant is not an offer. `tour` is reported for a granted account on a
 * deployment that does not offer the guide, because whether it is offered is
 * `tour/access.ts`'s question and has its own verdict.
 *
 * Nobody signed in is granted nothing and costs no call to Clerk; a signed-in
 * account costs the held lookup `privateMetadata` makes, at most once a
 * minute per user. A throw is `AccountUnavailableError`, as for `identify`.
 */
export async function accountStatus(
  request: Request,
  env: Env,
): Promise<AccountStatus> {
  const keys = accountKeys(env, request)
  const who = await identify(request, keys)
  if (!who.signedIn || who.userId === null || !keys.secretKey)
    return { ...who, grants: [] }
  const flags = await privateMetadata(who.userId, keys.secretKey)
  return { ...who, grants: granted(flags) }
}
