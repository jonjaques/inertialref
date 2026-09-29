import { type ReactNode, useCallback, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ClerkProvider } from '@clerk/react'
import { SIGN_IN, SIGN_UP } from '../pages/paths.ts'
import {
  accountNavigation,
  AccountsContext,
  PUBLISHABLE_KEY,
  SIGNED_OUT_LANDING,
} from './accounts.ts'
import { APPEARANCE } from './appearance.ts'

/**
 * The identity provider, around the whole shell — or nothing, in a build
 * without a key.
 *
 * Inside `ShellRouter` because Clerk navigates, and every one of its
 * navigations has to be the router's: a `window.location` assignment reloads
 * the document, and a reload here rebuilds the renderer, the catalog and the
 * scene for a hop from one sign-in step to the next.
 *
 * Mounted unconditionally once there is a key, and that is a constraint, not a
 * preference. The provider wraps the canvas's host, so adding it later — after
 * the boot, say, to keep Clerk's script off the critical path — would change
 * the tree above `GameLoader` and remount the renderer. What Clerk costs at
 * boot is its script, fetched from its own origin in parallel with the
 * catalog.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()

  /*
   * The router functions are handed to Clerk once, when its instance is
   * created, and never again — `ClerkProvider` forwards later prop changes for
   * the appearance and nothing else. So they must be stable and read the
   * location at the moment Clerk calls them, which is what the ref is for.
   * Written in a layout effect, never during render: a write during render is
   * one React may throw away.
   */
  const current = useRef({ navigate, location })
  useLayoutEffect(() => {
    current.current = { navigate, location }
  })
  const go = useCallback((to: string, replace: boolean): Promise<void> => {
    const { navigate: push, location: here } = current.current
    const next = accountNavigation(to, here, replace)
    return Promise.resolve(
      push(next.to, { replace: next.replace, state: next.state }),
    )
  }, [])
  const routerPush = useCallback((to: string) => go(to, false), [go])
  const routerReplace = useCallback((to: string) => go(to, true), [go])

  if (PUBLISHABLE_KEY === '') return children
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      routerPush={routerPush}
      routerReplace={routerReplace}
      signInUrl={SIGN_IN}
      signUpUrl={SIGN_UP}
      afterSignOutUrl={SIGNED_OUT_LANDING}
      appearance={APPEARANCE}
    >
      <AccountsContext value>{children}</AccountsContext>
    </ClerkProvider>
  )
}
