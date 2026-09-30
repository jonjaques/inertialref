import { Link } from 'react-router'
import { SignIn, SignUp, UserProfile, useAuth, useClerk } from '@clerk/react'
import { LogOut } from 'lucide-react'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { HOME, SIGN_IN, SIGN_UP } from '../pages/paths.ts'
import { ServerVerdict } from './ServerVerdict.tsx'
import { SIGNED_OUT_LANDING } from './accounts.ts'
import { PAGE_ELEMENTS } from './appearance.ts'

/**
 * Clerk's sign-in, sign-up and profile, as the body of an account page.
 *
 * **Hash routing**, and it is the one that works for a static site. Clerk
 * walks a visitor through steps — the password, a code, a second factor, an
 * OAuth return — and path routing gives each one an address under the page,
 * `/sign-in/factor-one`. This build writes one HTML file per route and serves
 * `404.html` for anything else, so a reload mid-step, or the provider sending
 * the browser back to `/sign-in/sso-callback`, would land on the not-found
 * page. Under hash routing the step is `/sign-in#/factor-one`: the document is
 * `/sign-in`, which exists, and the fragment never reaches the server.
 *
 * Finishing on a page goes to the menu; a `redirect_url` in the address, which
 * Clerk honors ahead of the fallback, goes wherever it says.
 */
export function AccountForm({
  page,
}: {
  page: 'sign-in' | 'sign-up' | 'profile'
}) {
  const { isLoaded, isSignedIn } = useAuth()
  const clerk = useClerk()

  if (page === 'sign-in')
    return (
      <SignIn
        routing="hash"
        appearance={{ elements: PAGE_ELEMENTS }}
        signUpUrl={SIGN_UP}
        fallbackRedirectUrl={HOME}
        signUpFallbackRedirectUrl={HOME}
      />
    )
  if (page === 'sign-up')
    return (
      <SignUp
        routing="hash"
        appearance={{ elements: PAGE_ELEMENTS }}
        signInUrl={SIGN_IN}
        fallbackRedirectUrl={HOME}
        signInFallbackRedirectUrl={HOME}
      />
    )

  /*
   * Clerk's profile throws `cannot_render_user_missing` for a visitor who is
   * not signed in, and a cold load of `/profile` is exactly that visitor. So
   * the component is only mounted for somebody it can describe.
   */
  if (!isLoaded) return null
  if (!isSignedIn)
    return (
      <p className="type-body text-slate-300">
        Nobody is signed in on this device.{' '}
        <Link
          to={SIGN_IN}
          className={`text-sky-300 underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          Sign in
        </Link>{' '}
        to see your account.
      </p>
    )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ServerVerdict />
        <Action
          label="Sign out"
          icon={LogOut}
          onClick={() =>
            void clerk.signOut({ redirectUrl: SIGNED_OUT_LANDING })
          }
        />
      </div>
      <UserProfile routing="hash" appearance={{ elements: PAGE_ELEMENTS }} />
    </div>
  )
}
