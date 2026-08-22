import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { CloudOff, LogIn, UserRound, UserRoundPlus } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import { OverlayPage } from './OverlayPage.tsx'
import { HOME, PROFILE, SIGN_IN, SIGN_UP } from './paths.ts'

/*
 * The account routes: reserved, wired, and honest about being unbuilt.
 *
 * They exist now because two of the three are expensive to add later. A redirect
 * URI is registered with an identity provider ahead of time and changing it is a
 * coordinated deploy on both sides; and a service worker precaches a route list,
 * so a path that did not exist at install time is a path an offline client
 * cannot reach until the worker updates. Reserving `/sign-in`, `/sign-up`,
 * `/profile` and `/auth/callback` costs four route entries today.
 *
 * What they must not do is *pretend*. `docs/design/modes.md` makes solo offline
 * the base case and an account is only ever an addition to a complete game —
 * so these pages say what an account will be for, say that it does not exist
 * yet, and never render a credential field that goes nowhere. A sign-in form
 * that silently discards a password is worse than no sign-in page: people reuse
 * passwords, and a form that looks real is one they will type a real one into.
 */

/** What signing in will eventually buy, from `docs/design/modes.md`. */
const WHAT_AN_ACCOUNT_IS_FOR: readonly string[] = [
  'discovery credit checked against everyone else’s, and attributed publicly',
  'the Almanac and your bookmarks, synced across devices',
  'catalogue revisions delivered as they are published',
]

function NotYet({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof LogIn
  children?: React.ReactNode
}) {
  return (
    <OverlayPage title={title} subtitle="not built yet — the seam is">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Icon
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-sky-400/70"
          />
          <p className="text-slate-300">
            Accounts are designed and not built. The game is complete without
            one: the universe is derived, saves live in this browser, and
            everything works with no network at all.
          </p>
        </div>

        <ul className="flex flex-col gap-1 border-y border-slate-800 py-2">
          {WHAT_AN_ACCOUNT_IS_FOR.map((line) => (
            <li key={line} className="flex gap-2 text-slate-400">
              <span aria-hidden className="text-sky-400/60">
                ·
              </span>
              {line}
            </li>
          ))}
        </ul>

        {children}

        <p className="flex items-center gap-1.5 text-slate-500">
          <CloudOff aria-hidden className="size-3.5" />
          nothing on this page sends anything anywhere
        </p>
      </div>
    </OverlayPage>
  )
}

export function SignInPage() {
  return (
    <NotYet title="sign in" icon={LogIn}>
      <p className="text-slate-400">
        No account?{' '}
        <Link
          to={SIGN_UP}
          replace
          className={`text-sky-300 underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          the same page, in the other direction
        </Link>
        .
      </p>
    </NotYet>
  )
}

export function SignUpPage() {
  return (
    <NotYet title="sign up" icon={UserRoundPlus}>
      <p className="text-slate-400">
        Already have one?{' '}
        <Link
          to={SIGN_IN}
          replace
          className={`text-sky-300 underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          sign in
        </Link>
        .
      </p>
    </NotYet>
  )
}

export function ProfilePage() {
  return (
    <NotYet title="profile" icon={UserRound}>
      <p className="text-slate-400">
        Your discoveries are recorded locally in the meantime, and a save is
        under 700 bytes — the Almanac has somewhere to sync *from* whenever this
        is built.
      </p>
    </NotYet>
  )
}

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
     * A back button that returns to a spent authorisation code is at best a
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
        <p className="text-slate-400">Returning you to the game…</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-rose-300">Sign-in did not complete.</p>
          {/* The provider's own error code, which is safe to show and is the
              only thing that makes a support question answerable. */}
          <p className="font-mono text-[10px] text-slate-500">{state.error}</p>
          <Link
            to={HOME}
            replace
            className={`self-start rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-sky-500/60 hover:text-sky-200 ${FOCUS_RING}`}
          >
            back to the menu
          </Link>
        </div>
      )}
    </OverlayPage>
  )
}
