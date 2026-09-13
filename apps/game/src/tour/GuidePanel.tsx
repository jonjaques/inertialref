import { useEffect, useState } from 'react'
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
        if (!active) return
        setRuntime(ready)
        void ready.inspect()
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
  return runtime === null ? (
    <p className="type-ui text-slate-400" role="status">
      {failure ?? 'Opening guide…'}
    </p>
  ) : (
    <GuideControls runtime={runtime} />
  )
}
