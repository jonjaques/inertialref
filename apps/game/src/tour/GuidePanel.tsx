import { useEffect, useState } from 'react'
import type { PlanetariumContext } from '../planetarium/context.ts'
import type { GuideRuntime } from './runtime.ts'
import { GuideControls } from './GuideControls.tsx'

export function GuidePanel({ guide, guideAccess }: PlanetariumContext) {
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
   * The planetarium's access check already asked the Worker for whoever is
   * signed in; the runtime takes that answer rather than asking again every
   * time the panel is opened, docked or floated. A new account is a new answer
   * from the check, and it reaches the runtime here.
   */
  useEffect(() => {
    if (runtime !== null && guideAccess !== null) runtime.adopt(guideAccess)
  }, [runtime, guideAccess])
  return runtime === null ? (
    <p className="type-ui text-slate-400" role="status">
      {failure ?? 'Opening guide…'}
    </p>
  ) : (
    <GuideControls runtime={runtime} />
  )
}
