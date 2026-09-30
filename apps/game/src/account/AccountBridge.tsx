import type { ReactNode } from 'react'
import { useAuth } from '@clerk/react'
import { AccountContext } from './accounts.ts'

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
  return (
    <AccountContext
      value={{ configured: true, loaded: isLoaded, userId: userId ?? null }}
    >
      {children}
    </AccountContext>
  )
}
