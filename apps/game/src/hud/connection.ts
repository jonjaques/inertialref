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

const TONE: Readonly<Record<ConnectionState, string>> = {
  checking: 'text-slate-500',
  online: 'text-emerald-400',
  // Not a warning colour. Being offline is a supported way to play.
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
