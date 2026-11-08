import { useEffect, useState } from 'react'
import { GameRuntimeBoundary } from './GameRuntimeBoundary.tsx'
import { loadRuntime } from './runtimeLoader.ts'
import { runtimeFailure, useRuntimeFailure } from './runtimeFailure.ts'
import { RuntimeNotice } from './RuntimeNotice.tsx'

export default function GameLoader() {
  const [runtime, setRuntime] = useState<Awaited<
    ReturnType<typeof loadRuntime>
  > | null>(null)
  const failure = useRuntimeFailure()

  // Hydration keeps the server's readable page intact while the browser loads
  // the scene. Replaying this effect shares the same import and catalog fetch.
  useEffect(() => {
    let active = true
    void loadRuntime().then(
      (loaded) => {
        if (!active) return
        setRuntime(loaded)
        void import('./posthogLogs.ts')
          .then(({ posthogLog }) => posthogLog.interactiveRuntimeLoaded())
          .catch(() => undefined)
      },
      (cause: unknown) => {
        console.error('The interactive view could not start', cause)
        if (!active) return
        runtimeFailure.report('runtime', cause)
        void import('./posthogLogs.ts')
          .then(({ posthogLog }) => posthogLog.interactiveRuntimeFailed())
          .catch(() => undefined)
      },
    )
    return () => {
      active = false
    }
  }, [])

  if (failure !== null) return <RuntimeNotice failure={failure} />
  if (runtime === null) return null
  const { App, catalog } = runtime
  return (
    <GameRuntimeBoundary>
      <App catalog={catalog} />
    </GameRuntimeBoundary>
  )
}
