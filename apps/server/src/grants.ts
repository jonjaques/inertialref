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
 */

/**
 * The features a grant can open.
 *
 *   tour         The Planetarium guide (`tour/access.ts`).
 *   solo         A solo game.
 *   multiplayer  A multiplayer game.
 *
 * `solo` and `multiplayer` have no gate that reads them. They are named so the
 * flags can be set on accounts ahead of one, and a gate asks for its feature
 * by this name.
 */
export const FEATURES = ['tour', 'solo', 'multiplayer'] as const

export type Feature = (typeof FEATURES)[number]

/** An account's private metadata, as `privateMetadata` hands it over. */
export type Flags = Readonly<Record<string, unknown>>

/** Whether these flags grant `feature`: its own flag, or `admin`. */
export const grants = (flags: Flags, feature: Feature): boolean =>
  flags.admin === true || flags[feature] === true
