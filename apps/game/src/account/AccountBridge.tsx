import { type ReactNode, useEffect } from 'react'
import { useAuth } from '@clerk/react'
import { identifyAccount } from '../telemetry/client.ts'
import { AccountContext } from './accounts.ts'

/**
 * Clerk's answer to "who is signed in", republished as this app's own
 * `AccountContext` — the one place outside a Clerk component that calls a
 * Clerk hook.
 *
 * Children are passed through rather than rendered, so a sign-in re-renders
 * the context's readers and not the shell: `AccountProvider` hands this the
 * same element tree on every render.
 *
 * The same answer goes to PostHog. `identifyAccount` reconciles against the
 * SDK's own persisted identity, so this effect is idempotent and needs no
 * memory of what it sent before.
 */
export function AccountBridge({ children }: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth()
  const accountUserId = userId ?? null
  useEffect(() => {
    if (isLoaded) identifyAccount(accountUserId)
  }, [isLoaded, accountUserId])

  return (
    <AccountContext
      value={{ configured: true, loaded: isLoaded, userId: accountUserId }}
    >
      {children}
    </AccountContext>
  )
}
