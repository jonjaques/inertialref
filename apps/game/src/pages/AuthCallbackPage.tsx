import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { FOCUS_RING } from '../hud/focus.ts'
import { OverlayPage } from './OverlayPage.tsx'
import { HOME, PROFILE } from './paths.ts'

/**
 * Where an identity provider comes back to.
 *
 * A real route rather than a placeholder, because the two things it has to get
 * right are true whether or not there is a provider on the other end: it must
 * consume the parameters out of the URL rather than leave a code or a token
 * sitting in the address bar to be copied into a bug report, and it must send
 * the browser somewhere. Both are one-liners now and both are the parts people
 * forget when the provider is added under time pressure.
 */
export function AuthCallbackPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [state] = useState(() => ({
    error: params.get('error'),
    // Presence only, never the value — this string ends up in a log line one
    // careless afternoon, and a code is a credential until it is redeemed.
    hadCode: params.get('code') !== null,
  }))

  useEffect(() => {
    if (state.error !== null) return
    /*
     * `replace`, so the callback URL is not in the history.
     *
     * A back button that returns to a spent authorization code is at best a
     * confusing error and at worst a code replayed from a shared machine.
     */
    const timer = window.setTimeout(() => {
      void navigate(state.hadCode ? PROFILE : HOME, { replace: true })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [navigate, state])

  return (
    <OverlayPage title="signing in" subtitle="finishing up">
      {state.error === null ? (
        <p role="status" className="text-slate-400">
          Returning you to the game…
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-rose-300">Sign-in did not complete.</p>
          {/* The provider's own error code, which is safe to show and is the
              only thing that makes a support question answerable. */}
          <p className="type-micro text-slate-400">{state.error}</p>
          <Button
            asChild
            variant="outline"
            size="xs"
            className={`self-start rounded border-slate-700 bg-transparent px-2 py-1 font-normal text-slate-300 shadow-none hover:border-sky-500/60 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
          >
            <Link to={HOME} replace>
              back to the menu
            </Link>
          </Button>
        </div>
      )}
    </OverlayPage>
  )
}
