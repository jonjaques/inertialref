import type { ConnectionState } from '../net/health.ts'

/*
 * How the connection reads.
 *
 * Five states rather than a boolean, because the four ways of not being online
 * want four different reactions from whoever is looking: wait, plug the network
 * in, the server is down, or this build and that server disagree about what the
 * universe looks like. A single "offline" collapses all of them into "try again
 * later", and only one of them is that.
 *
 * None of it is an error state. Offline-first is the requirement — a
 * single-player universe needs no server — so this is a readout in the same
 * sense that the altitude is.
 */

export const CONNECTION_LABEL: Readonly<Record<ConnectionState, string>> = {
  checking: 'checking',
  online: 'online',
  offline: 'offline',
  unreachable: 'no server',
  incompatible: 'mismatch',
}

/*
 * The one place slate-500 survives, and it is deliberate.
 *
 * Everywhere else the grade went to 400, because slate-500 tops out at 4.24:1
 * on an opaque slate-950 panel and never reaches the 4.5:1 a readout needs. The
 * pip is not a readout — it is a single `●`, a non-text indicator, which WCAG
 * holds to 3:1, and it measures 3.2:1 against the dock with a star behind it.
 *
 * Moving it would cost the thing this file exists for: `checking` and `offline`
 * are two of the five states and both are gray. At 400 they would be the same
 * gray, and "waiting" and "playing offline" want different reactions.
 */
const TONE: Readonly<Record<ConnectionState, string>> = {
  checking: 'text-slate-500',
  online: 'text-emerald-400',
  // Not a warning color. Being offline is a supported way to play.
  offline: 'text-slate-400',
  unreachable: 'text-amber-400',
  incompatible: 'text-rose-400',
}

export const connectionTone = (state: ConnectionState): string => TONE[state]

/** "just now" / "12s ago" / "4m ago", from a `performance.now()` reading. */
export function sinceText(checkedAt: number | null): string {
  if (checkedAt === null) return 'never'
  const seconds = Math.max(
    0,
    Math.round((performance.now() - checkedAt) / 1000),
  )
  if (seconds < 2) return 'just now'
  if (seconds < 90) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}
