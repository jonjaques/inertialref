import { useEffect, useSyncExternalStore } from 'react'
import { useAccount } from '../account/accounts.ts'
import { sessionHeaders } from '../account/token.ts'
import { askGuideVerdict, type GuideVerdict } from './capabilities.ts'
import type { GuideAccess, GuideAccessOwner } from './verdict.ts'

/*
 * Whether the planetarium offers the guide to whoever is signed in.
 *
 * The grant is `admin` or `tour` in the account's private metadata, which the
 * browser cannot read — so this asks the Worker, which can
 * (`apps/server/src/tour/access.ts`). Once per signed-in user: a sign-in, a
 * sign-out or a different account asks again, and nobody signed in is never
 * offered it and never asks.
 *
 * This is what the menu shows, not what the guide permits. The Worker refuses
 * a session to an account without the grant whatever this answered, which is
 * why a failed ask is simply "not offered" rather than an error on screen.
 *
 * Deliberately free of the guide's runtime: the mode imports this on mount,
 * and the runtime, its media and its timers load only when the panel opens.
 */

/** The mode's verdict, kept in step with whoever is signed in. */
export function useGuideAccess(owner: GuideAccessOwner): GuideAccess {
  const { userId } = useAccount()
  useEffect(() => owner.forUser(userId), [owner, userId])
  return useSyncExternalStore(owner.subscribe, owner.current, owner.current)
}

/** The Worker's verdict for whoever the session token names. */
export async function askWorker(): Promise<GuideVerdict | null> {
  try {
    const headers = await sessionHeaders()
    if (!headers.has('Authorization')) return null
    return await askGuideVerdict(headers)
  } catch {
    return null
  }
}
