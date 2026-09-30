import { useEffect, useState } from 'react'
import { useAccount } from '../account/accounts.ts'
import type { PlanetariumContext } from '../planetarium/context.ts'
import type { GuideRuntime } from './runtime.ts'
import { GuideControls } from './GuideControls.tsx'

export function GuidePanel({ guide }: PlanetariumContext) {
  const [runtime, setRuntime] = useState<GuideRuntime | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void guide
      .load()
      .then((ready) => {
        if (active) setRuntime(ready)
      })
      .catch(() => {
        if (active)
          setFailure(
            'The guide panel could not load. Close and reopen it to try again.',
          )
      })
    return () => {
      active = false
    }
  }, [guide])
  /*
   * The capabilities are the Worker's answer for whoever was signed in when
   * they were read. Asked when the runtime arrives, and again on a sign-in, a
   * sign-out or a different account, so the panel never offers Start on the
   * strength of somebody else's grant.
   */
  const { userId } = useAccount()
  useEffect(() => {
    void runtime?.refresh()
  }, [runtime, userId])
  return runtime === null ? (
    <p className="type-ui text-slate-400" role="status">
      {failure ?? 'Opening guide…'}
    </p>
  ) : (
    <GuideControls runtime={runtime} />
  )
}
