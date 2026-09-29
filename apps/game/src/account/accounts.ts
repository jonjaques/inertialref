import { createContext, useContext } from 'react'
import type { Location } from 'react-router'
import {
  HOME,
  isOverlayPath,
  overlayState,
  resolvedLocation,
  type OverlayLocationState,
} from '../pages/paths.ts'

/*
 * Accounts, from the client's side: which provider, whether this build has
 * one, and how its navigations become this app's.
 *
 * The provider is Clerk. It signs a visitor in from the browser, holds the
 * session, and hands the page a short-lived token that the Worker verifies at
 * `ACCOUNT_PATH` (`apps/server/src/account.ts`). Nothing the game simulates
 * depends on it — solo offline is the base case (`docs/design/modes.md`) and
 * an account is an addition to a complete game — so a build without a key is
 * a supported build rather than a broken one: no badge, and account pages
 * that say this deployment does not offer accounts.
 */

/**
 * The instance's publishable key, a build variable of the client.
 *
 * `PUBLIC_` because this is an Astro build and Astro exposes nothing else to
 * the browser. Not a secret — it is in the bundle and names the instance — and
 * still not in the repository, for the reason the analytics id is not: a fork
 * built from a committed key would sign its visitors into somebody else's
 * instance. `apps/game/.env.example` documents it.
 */
export const PUBLISHABLE_KEY: string =
  import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''

/**
 * Whether the tree below is inside the provider.
 *
 * Asked rather than inferred from the key, because the key is a build
 * constant and the provider is a render: the server-render tests draw the
 * account pages with no provider at all, and a Clerk hook called outside one
 * throws. A component reads this and only then renders the half that calls
 * Clerk.
 */
export const AccountsContext = createContext(false)

export const useAccounts = (): boolean => useContext(AccountsContext)

/**
 * Where Clerk is told to go after a sign-out, as a marker rather than a place.
 *
 * `ClerkProvider` captures its options once, when the instance is created, and
 * passes later changes through only for the appearance and the localization —
 * so an `afterSignOutUrl` computed from the location would be the location of
 * the first render forever. The marker is recognized by `accountNavigation`
 * and replaced with wherever the reader actually is. It is still a real
 * address: if Clerk ever navigates the window rather than the router, it
 * lands on the menu with a stray query, which is harmless.
 */
export const SIGNED_OUT_LANDING = `${HOME}?account=signed-out`

const hrefOf = (location: Pick<Location, 'pathname' | 'search' | 'hash'>) =>
  `${location.pathname}${location.search}${location.hash}`

/**
 * Where to go once an account dialog is done with — signed in, signed out, or
 * dismissed: the mode behind it, or the menu when there is none.
 *
 * "None" includes a cold load of an account page, whose resolved location is
 * the dialog itself; landing there after signing out would show a profile to
 * nobody.
 */
export function returnAddress(here: Location): string {
  const base = resolvedLocation(here)
  return isOverlayPath(base.pathname) ? HOME : hrefOf(base)
}

export interface AccountNavigation {
  readonly to: string
  readonly replace: boolean
  readonly state?: OverlayLocationState
}

/**
 * One of Clerk's navigations, as this router has to perform it.
 *
 * Clerk moves between its own pages — sign-in to sign-up, a sign-in step to
 * the next, the profile's sections — through the `routerPush` it was given,
 * and it knows nothing about the background location that keeps a mode alive
 * behind a dialog. Passed through bare, the first hop from `/sign-in` to
 * `/sign-up` would clear `location.state`, `ModeRoutes` would re-resolve at
 * the dialog's own path, and the planetarium behind it would unmount — the
 * failure `useOverlay` describes, reached from a library this time.
 *
 * So an account dialog is opened over the mode that is actually running —
 * `resolvedLocation`, which is the background when a dialog is already up —
 * and anything that is not a dialog is an ordinary navigation that closes one.
 * A cold-loaded dialog has no mode behind it, and carries none on: naming the
 * dialog itself as the background would make closing `/sign-up` open
 * `/sign-in`. That is `useOverlay`'s `keep`, for the same reason.
 */
export function accountNavigation(
  to: string,
  here: Location,
  replace: boolean,
): AccountNavigation {
  const target = new URL(to, 'https://inertialref.invalid')
  if (
    target.pathname === HOME &&
    target.searchParams.get('account') === 'signed-out'
  )
    return { to: returnAddress(here), replace: true }
  const base = resolvedLocation(here)
  if (isOverlayPath(target.pathname) && !isOverlayPath(base.pathname))
    return { to, replace, state: overlayState(base) }
  return { to, replace }
}
