import type { ReactNode } from 'react'
import { CloudOff, type LucideIcon } from 'lucide-react'
import { OverlayPage } from './OverlayPage.tsx'

/*
 * The account routes, in a build that offers no accounts.
 *
 * Accounts are Clerk's (`account/accounts.ts`), and they exist only where the
 * build was given a publishable key — the deployment, not a fork and not a
 * keyless `pnpm dev`. The routes are there either way: a service worker
 * precaches the route list, and a link to `/sign-in` from somewhere else should
 * land on a sentence rather than a 404.
 *
 * What they must not do is *pretend*. `docs/design/modes.md` makes solo offline
 * the base case and an account is only ever an addition to a complete game —
 * so these pages say what an account is for, say that this build has none, and
 * never render a credential field that goes nowhere. A sign-in form that
 * silently discards a password is worse than no sign-in page: people reuse
 * passwords, and a form that looks real is one they will type a real one into.
 *
 * This is the shell the account pages share; each page is the sentence that
 * differs.
 */

/** What signing in will eventually buy, from `docs/design/modes.md`. */
const WHAT_AN_ACCOUNT_IS_FOR: readonly string[] = [
  'discovery credit checked against everyone else’s, and attributed publicly',
  'the Almanac and your bookmarks, synced across devices',
  'catalog revisions delivered as they are published',
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
    <OverlayPage title={title} subtitle="not offered by this build">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Icon
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-sky-400/70"
          />
          <p className="text-slate-300">
            This build has no account provider configured. The game is complete
            without one: the universe is derived, saves live in this browser,
            and everything works with no network at all.
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
