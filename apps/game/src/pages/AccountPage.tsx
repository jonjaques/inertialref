import { Link } from 'react-router'
import { ArrowLeft, CloudOff } from 'lucide-react'
import { AccountForm } from '../account/AccountForm.tsx'
import { useAccounts } from '../account/accounts.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { Logomark } from '../icons/Logomark.tsx'
import {
  ACCOUNT_PAGE,
  type AccountPageId,
  WHAT_AN_ACCOUNT_IS_FOR,
} from './accountPages.ts'
import { FooterLink } from './FooterLink.tsx'
import { HOME } from './paths.ts'
import { Poster } from './Poster.tsx'

/**
 * `/sign-in`, `/sign-up` and `/profile`: pages of the menu, over the menu's
 * scene, reached from the front door or by address.
 *
 * Pages rather than dialogs, because arriving at one is arriving at a place —
 * a link in an email, a bookmark, the front door's own links — and a dialog
 * over the menu is a place pretending to be an interruption. Inside a mode,
 * where there is something to interrupt, the badge opens Clerk's modal
 * instead (`account/AccountButton.tsx`) and none of this is involved.
 *
 * A build without accounts still answers these addresses, with a sentence: a
 * service worker precaches the route list, and a link to `/sign-in` from
 * somewhere else should land on an explanation rather than a 404. What it must
 * never do is render a credential field that goes nowhere — people reuse
 * passwords, and a form that looks real is one they will type a real one into.
 */
export function AccountPage({ page }: { page: AccountPageId }) {
  const accounts = useAccounts()
  const { title, lead } = ACCOUNT_PAGE[page]
  return (
    <Poster>
      <header>
        <Link
          to={HOME}
          aria-label="Back to the menu"
          className={`inline-flex rounded ${FOCUS_RING}`}
        >
          <Logomark className="h-7 w-auto" />
        </Link>
        <h1 className="type-title mt-5 text-slate-50">{title}</h1>
        <p className="type-body mt-2 max-w-[38ch] text-slate-400">{lead}</p>
      </header>

      <section
        aria-label={title}
        className={page === 'profile' ? 'max-w-[52rem]' : 'max-w-[26rem]'}
      >
        {accounts ? (
          <AccountForm page={page} />
        ) : (
          <div className="type-body flex max-w-[33rem] flex-col gap-3">
            <p className="text-slate-300">
              This build has no account provider configured. The game is
              complete without one: the universe is derived, saves live in this
              browser, and everything works with no network at all.
            </p>
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
            <p className="type-ui flex items-center gap-1.5 text-slate-400">
              <CloudOff aria-hidden className="size-3.5" />
              nothing on this page sends anything anywhere
            </p>
          </div>
        )}
      </section>

      <footer className="type-ui flex flex-wrap items-center gap-x-5 gap-y-2">
        <FooterLink to={HOME} icon={ArrowLeft} label="Back to the menu" />
      </footer>
    </Poster>
  )
}
