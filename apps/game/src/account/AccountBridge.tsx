import { type ReactNode, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/react'
import { AccountContext } from './accounts.ts'

interface IdentityState {
  initialized: boolean
  userId: string | null
}

/** Synchronize Clerk's persisted browser identity with the browser SDK. */
function usePostHogIdentity(isLoaded: boolean, userId: string | null): void {
  const identity = useRef<IdentityState>({ initialized: false, userId: null })

  useEffect(() => {
    if (!isLoaded) return

    const previous = identity.current
    const next = userId
    identity.current = { initialized: true, userId: next }

    if (previous.initialized && previous.userId === next) return

    void import('../posthog.ts')
      .then(({ isPostHogStarted, posthog }) => {
        // Account state can change while the browser-only module is loading.
        if (!isPostHogStarted() || identity.current.userId !== next) return

        if (previous.initialized && previous.userId !== null) posthog.reset()
        if (next !== null) posthog.identify(next)
      })
      .catch(() => undefined)
  }, [isLoaded, userId])
}

/**
 * Clerk's answer to "who is signed in", republished as this app's own
 * `AccountContext` — the one place outside a Clerk component that calls a
 * Clerk hook.
 *
 * Children are passed through rather than rendered, so a sign-in re-renders
 * the context's readers and not the shell: `AccountProvider` hands this the
 * same element tree on every render.
 */
export function AccountBridge({ children }: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth()
  const accountUserId = userId ?? null
  usePostHogIdentity(isLoaded, accountUserId)

  return (
    <AccountContext
      value={{ configured: true, loaded: isLoaded, userId: accountUserId }}
    >
      {children}
    </AccountContext>
  )
}
