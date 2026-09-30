import { useEffect, useState } from 'react'
import { useAccount } from '../account/accounts.ts'
import { sessionHeaders } from '../account/token.ts'

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

/** Whether the guide's panel belongs in this visitor's menu. */
export function useGuideAccess(): boolean {
  const { userId } = useAccount()
  const [answer, setAnswer] = useState<{
    readonly userId: string
    readonly granted: boolean
  } | null>(null)
  useEffect(() => {
    if (userId === null) return
    let live = true
    void askWorker().then((granted) => {
      if (live) setAnswer({ userId, granted })
    })
    return () => {
      live = false
    }
  }, [userId])
  // Compared rather than cleared, so an answer about the previous account is
  // never read as one about this one.
  return userId !== null && answer?.userId === userId && answer.granted
}

async function askWorker(): Promise<boolean> {
  try {
    const headers = await sessionHeaders()
    if (!headers.has('Authorization')) return false
    const response = await fetch('/api/tour/capabilities', {
      headers,
      cache: 'no-store',
    })
    if (!response.ok) return false
    const body = (await response.json()) as {
      available?: unknown
      authorized?: unknown
    }
    return body.available === true && body.authorized === true
  } catch {
    return false
  }
}
