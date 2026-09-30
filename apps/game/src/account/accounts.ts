import { createContext, useContext } from 'react'
import type { Location } from 'react-router'
import {
  HOME,
  PROFILE,
  resolvedLocation,
  SIGN_IN,
  SIGN_UP,
} from '../pages/paths.ts'

/*
 * Accounts, from the client's side: which provider, whether this build has
 * one, who is signed in, and how the provider's navigations become this app's.
 *
 * The provider is Clerk. It signs a visitor in from the browser, holds the
 * session, and hands the page a short-lived token that the Worker verifies
 * (`apps/server/src/account.ts`). Nothing the game simulates depends on it —
 * solo offline is the base case (`docs/design/modes.md`) and an account is an
 * addition to a complete game — so a build without a key is a supported build
 * rather than a broken one: no badge, and account pages that say this build
 * does not offer accounts.
 *
 * Accounts are reached two ways, and which one is a question of where the
 * visitor is standing. From the menu, or by address, `/sign-in`, `/sign-up`
 * and `/profile` are pages of their own over the menu's scene. Inside a mode —
 * the planetarium, flight — the badge opens Clerk's own modal and the address
 * does not change: a flight in progress is not a place to navigate away from
 * to answer "who am I signed in as".
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

/** Who is signed in, as far as this page knows. */
export interface AccountState {
  /** Whether this build has accounts at all. */
  readonly configured: boolean
  /** Whether the provider has answered yet; nothing is known before it does. */
  readonly loaded: boolean
  readonly userId: string | null
}

/**
 * The account state, for everything outside `account/`.
 *
 * Its own context rather than Clerk's hooks, and for two reasons. Clerk's
 * hooks throw outside the provider, and the server-render tests and a fork
 * both draw the shell with no provider at all — this has a default that means
 * "no accounts". And a module that is not about accounts — the guide, the
 * home page — should not know which vendor answers the question.
 * `AccountBridge` is the one writer.
 */
export const AccountContext = createContext<AccountState>({
  configured: false,
  loaded: true,
  userId: null,
})

export const useAccount = (): AccountState => useContext(AccountContext)

/** Whether the tree below is inside the provider. */
export const useAccounts = (): boolean => useContext(AccountContext).configured

/** The account pages: pages of their own, never dialogs over a mode. */
export function isAccountPath(pathname: string): boolean {
  return pathname === SIGN_IN || pathname === SIGN_UP || pathname === PROFILE
}

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
 * Where to be once signed out: where the reader already is, unless that is an
 * account page, which has nothing to show somebody signed out of it.
 */
export function returnAddress(here: Location): string {
  const base = resolvedLocation(here)
  return isAccountPath(base.pathname) ? HOME : hrefOf(base)
}

export interface AccountNavigation {
  readonly to: string
  readonly replace: boolean
}

/**
 * One of Clerk's navigations, as this router has to perform it — or `null`
 * when there is nowhere to go.
 *
 * **Resolved against the current address, not the site root.** Clerk moves
 * between a component's own steps with a bare fragment — `#/security` inside
 * the profile — and a URL resolved against `/` turns that into the menu. React
 * Router would resolve the bare string against the current path, but the
 * decisions here have to be taken about the same address it will land on.
 *
 * A modal finishing where it was opened asks to go to the address the reader
 * is already at; pushing it would add a history entry that goes nowhere, and a
 * navigation to the current address drops whatever `location.state` a dialog
 * behind it was keeping.
 */
export function accountNavigation(
  to: string,
  here: Location,
  replace: boolean,
): AccountNavigation | null {
  const origin = 'https://inertialref.invalid'
  const target = new URL(to, `${origin}${hrefOf(here)}`)
  const signedOut =
    target.pathname === HOME &&
    target.searchParams.get('account') === 'signed-out'
  const next = signedOut ? returnAddress(here) : hrefOf(target)
  if (next === hrefOf(here)) return null
  return { to: next, replace: signedOut || replace }
}
