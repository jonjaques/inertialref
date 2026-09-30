import { createContext, useContext } from 'react'
import type { Location } from 'react-router'
import {
  HOME,
  PROFILE,
  resolvedLocation,
  SIGN_IN,
  SIGN_UP,
} from '../pages/paths.ts'
import { SITE } from '../site.ts'

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
 * instance. Each Cloudflare environment builds with its own: the production
 * instance's in Production, the development instance's in Previews Base,
 * beside the matching `CLERK_SECRET_KEY` on the Worker.
 * `apps/game/.env.example` documents it.
 */
const BUILD_KEY: string = usablePublishableKey(
  import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
)

/**
 * The key this page signs in with: the build's, unless this is a production
 * build on a host Clerk's production instance does not serve.
 *
 * Decided from the page's host at module load, before the first render, and
 * never after: the provider wraps the canvas's host, and mounting it or
 * removing it once the tree exists remounts the renderer. The prerender has
 * no host and is written for the canonical one.
 */
export const PUBLISHABLE_KEY: string = keyForHost(
  BUILD_KEY,
  typeof window === 'undefined' ? SITE.host : window.location.hostname,
)

/**
 * Whether this build has accounts but this page's host does not — the
 * production build on its second host.
 */
export const ACCOUNTS_ELSEWHERE: boolean =
  BUILD_KEY !== '' && PUBLISHABLE_KEY === ''

/**
 * A key, or nothing on a host its instance does not serve.
 *
 * A live key is the production instance's, which Clerk configures for one
 * domain and whose Frontend API refuses a page on any other origin
 * (`origin_invalid`): on the second host every sign-in would fail, so that
 * host has no accounts at all, and without an account nobody is offered the
 * guide. The Worker makes the same decision (`apps/server/src/origins.ts`).
 * A test key is the development instance's, which answers any origin — every
 * Worker Preview and `localhost`.
 */
export function keyForHost(key: string, hostname: string): string {
  return key.startsWith('pk_live_') && hostname !== SITE.host ? '' : key
}

/**
 * The key, if Clerk can use it, or nothing.
 *
 * A publishable key is `pk_test_` or `pk_live_` and then the instance's
 * Frontend API host in base64, ending in `$`. Anything else — the placeholder
 * a Workers Builds variable holds until the real key replaces it, a secret key
 * pasted into the wrong box — would reach Clerk as an instance that does not
 * exist, and the build is better off with no accounts than with a badge that
 * never loads.
 */
export function usablePublishableKey(key: string): string {
  const match = /^pk_(?:test|live)_([A-Za-z0-9+/]+={0,2})$/.exec(key)
  if (match === null) return ''
  try {
    return atob(match[1]!).endsWith('$') ? key : ''
  } catch {
    return ''
  }
}

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
