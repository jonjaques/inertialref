import { Link, useLocation } from 'react-router'
import { SignIn, SignUp, UserProfile, useAuth } from '@clerk/react'
import { FOCUS_RING } from '../hud/focus.ts'
import { OverlayPage } from '../pages/OverlayPage.tsx'
import { SIGN_IN, SIGN_UP } from '../pages/paths.ts'
import { useOverlay } from '../pages/useOverlay.ts'
import { ServerVerdict } from './ServerVerdict.tsx'
import { returnAddress } from './accounts.ts'

/**
 * Clerk's sign-in, sign-up and profile, as dialogs over the running mode.
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
 * Every step still goes through the router Clerk was given, so the mode
 * behind stays mounted from the first step to the last (`accountNavigation`).
 * Finishing — signing in, signing up — returns to that mode, which closes the
 * dialog without touching what it was open over.
 */
export function AccountDialog({
  page,
}: {
  page: 'sign-in' | 'sign-up' | 'profile'
}) {
  const { isLoaded, isSignedIn } = useAuth()
  const { keep } = useOverlay()
  const back = returnAddress(useLocation())

  /*
   * Clerk's profile throws `cannot_render_user_missing` for a visitor who is
   * not signed in, and a cold load of `/profile` is exactly that visitor. So
   * the component is only mounted for somebody it can describe; everybody
   * else gets the sentence and the way in, over the same mode.
   */
  if (page === 'profile')
    return (
      <OverlayPage title="account" subtitle="yours, and optional" wide>
        {isSignedIn ? (
          <div className="flex flex-col gap-3">
            <ServerVerdict />
            <UserProfile routing="hash" />
          </div>
        ) : (
          isLoaded && (
            <p className="text-slate-300">
              Nobody is signed in on this device.{' '}
              <Link
                to={SIGN_IN}
                state={keep}
                replace
                className={`text-sky-300 underline-offset-2 hover:underline ${FOCUS_RING}`}
              >
                Sign in
              </Link>{' '}
              to see your account.
            </p>
          )
        )}
      </OverlayPage>
    )

  return (
    <OverlayPage
      title={page === 'sign-in' ? 'sign in' : 'sign up'}
      subtitle="optional — the game is complete without one"
    >
      {page === 'sign-in' ? (
        <SignIn
          routing="hash"
          signUpUrl={SIGN_UP}
          fallbackRedirectUrl={back}
          signUpFallbackRedirectUrl={back}
        />
      ) : (
        <SignUp
          routing="hash"
          signInUrl={SIGN_IN}
          fallbackRedirectUrl={back}
          signInFallbackRedirectUrl={back}
        />
      )}
    </OverlayPage>
  )
}
