import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/react'
import {
  CloudOff,
  LoaderCircle,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react'
import { askServer, CHECKING, type ServerAccount } from '../net/account.ts'

/**
 * One line under the profile: whether the server agrees about who this is.
 *
 * The profile is Clerk's, and Clerk's answer is the browser's. This is the
 * Worker's, which is the one anything recorded will be attributed under — so
 * a mismatch is worth a sentence rather than a silence, and the four ways it
 * can come out each have a different remedy.
 */
export function ServerVerdict() {
  const { getToken, userId } = useAuth()
  const [verdict, setVerdict] = useState<ServerAccount>(CHECKING)

  /*
   * Asked again when the signed-in user changes, and only then. `getToken`
   * hands back a cached token until it is near expiry, so a second ask for the
   * same user is cheap, but there is nothing new to learn from it either.
   */
  useEffect(() => {
    let live = true
    setVerdict(CHECKING)
    void (async () => {
      const answer = await askServer(await getToken())
      if (live) setVerdict(answer)
    })()
    return () => {
      live = false
    }
  }, [getToken, userId])

  const [Icon, line, tone] = describe(verdict, userId ?? null)
  return (
    <p
      role="status"
      className={`type-readout flex items-center gap-1.5 rounded border border-slate-800 px-2 py-1 ${tone}`}
    >
      <Icon
        aria-hidden
        className={`size-3.5 shrink-0 ${verdict.state === 'checking' ? 'animate-spin motion-reduce:animate-none' : ''}`}
      />
      {line}
    </p>
  )
}

function describe(
  verdict: ServerAccount,
  userId: string | null,
): readonly [LucideIcon, string, string] {
  if (verdict.state === 'checking')
    return [LoaderCircle, 'Asking the server…', 'text-slate-400']
  if (verdict.state === 'unreachable')
    return [
      CloudOff,
      `The server could not be asked (${verdict.detail}). You are signed in on this device.`,
      'text-slate-400',
    ]
  const { status } = verdict
  if (!status.configured)
    return [
      ShieldOff,
      'This server does not check accounts, so nothing is attributed to you here.',
      'text-slate-400',
    ]
  if (status.signedIn && status.userId === userId)
    return [ShieldCheck, 'The server recognizes this account.', 'text-sky-200']
  return [
    ShieldAlert,
    'The server could not verify this session. Signing out and in again renews it.',
    'text-rose-300',
  ]
}
