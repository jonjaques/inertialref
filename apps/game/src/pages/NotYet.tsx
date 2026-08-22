import type { ReactNode } from 'react'
import { CloudOff, type LucideIcon } from 'lucide-react'
import { OverlayPage } from './OverlayPage.tsx'

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
 *
 * This is the shell all four share; each page is the sentence that differs.
 */

/** What signing in will eventually buy, from `docs/design/modes.md`. */
const WHAT_AN_ACCOUNT_IS_FOR: readonly string[] = [
  'discovery credit checked against everyone else’s, and attributed publicly',
  'the Almanac and your bookmarks, synced across devices',
  'catalogue revisions delivered as they are published',
]

export function NotYet({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: LucideIcon
  children?: ReactNode
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

        <p className="flex items-center gap-1.5 text-slate-400">
          <CloudOff aria-hidden className="size-3.5" />
          nothing on this page sends anything anywhere
        </p>
      </div>
    </OverlayPage>
  )
}
