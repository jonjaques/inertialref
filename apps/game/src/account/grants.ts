import { useEffect, useSyncExternalStore } from 'react'
import type { Feature } from '@inertialref/protocol'
import { askServer } from '../net/account.ts'
import { useAccount } from './accounts.ts'
import { sessionToken } from './token.ts'

/*
 * What the signed-in account is granted, as the Worker reads it.
 *
 * The grants are flags in the account's private metadata, which the browser
 * cannot read, so the Worker reads them and answers with the features they
 * open (`apps/server/src/grants.ts`) on the account record. This holds that
 * answer for the page: asked once per signed-in user, cleared on a sign-out,
 * asked again for a different account, and never asked for nobody.
 *
 * This is what the menu offers, not what anything permits. A failed ask is
 * "granted nothing" rather than an error on screen, because the worst a wrong
 * answer can do here is show or hide a door, and a door to a mode the build
 * already serves at its address opens nothing the address did not.
 *
 * One store for the page rather than state in the menu: the menu unmounts
 * whenever a mode opens, and coming back to it should not ask again.
 */

export interface GrantsOwner {
  current(): readonly Feature[]
  subscribe(listener: () => void): () => void
  /** Ask for this user, or settle nobody without asking. The same user is a no-op. */
  forUser(userId: string | null): void
}

const NONE: readonly Feature[] = []

/**
 * `ask` is the Worker's reading for whoever the session token names. An
 * answer that lands after the account changed is about the previous one, and
 * is dropped.
 */
export function createGrants(
  ask: () => Promise<readonly Feature[]>,
): GrantsOwner {
  const listeners = new Set<() => void>()
  let held = NONE
  // `undefined` until the first `forUser`, so a signed-out first call settles.
  let user: string | null | undefined = undefined
  let asking = 0

  const publish = (next: readonly Feature[]): void => {
    if (next.length === 0 && held.length === 0) return
    held = next.length === 0 ? NONE : next
    for (const listener of listeners) listener()
  }

  return {
    current: () => held,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    forUser(userId) {
      if (userId === user) return
      user = userId
      const ticket = ++asking
      publish(NONE)
      if (userId === null) return
      void ask().then(
        (features) => {
          if (ticket === asking) publish(features)
        },
        () => {},
      )
    },
  }
}

/** The Worker's reading for the session's account, or none for anything else. */
async function askWorker(): Promise<readonly Feature[]> {
  const token = await sessionToken()
  if (token === null) return NONE
  const answer = await askServer(token)
  return answer.state === 'answered' && answer.status.signedIn
    ? answer.status.grants
    : NONE
}

const PAGE_GRANTS = createGrants(askWorker)

/** The features granted to whoever is signed in; none until the Worker says. */
export function useGrants(
  owner: GrantsOwner = PAGE_GRANTS,
): readonly Feature[] {
  const { loaded, userId } = useAccount()
  /*
   * Only once the provider has loaded: `userId` is null before then as well
   * as for nobody, and settling on the first would ask nothing for a visitor
   * who is about to turn out to be signed in.
   */
  useEffect(() => {
    if (loaded) owner.forUser(userId)
  }, [owner, loaded, userId])
  return useSyncExternalStore(owner.subscribe, owner.current, () => NONE)
}
