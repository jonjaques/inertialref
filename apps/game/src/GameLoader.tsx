import { useEffect, useState } from 'react'
import { GameRuntimeBoundary } from './GameRuntimeBoundary.tsx'
import { loadRuntime } from './runtimeLoader.ts'

export default function GameLoader() {
  const [runtime, setRuntime] = useState<Awaited<
    ReturnType<typeof loadRuntime>
  > | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Hydration keeps the server's readable page intact while the browser loads
  // the scene. Replaying this effect shares the same import and catalog fetch.
  useEffect(() => {
    let active = true
    void loadRuntime().then(
      (loaded) => {
        if (active) setRuntime(loaded)
      },
      (cause: unknown) => {
        console.error('The interactive view could not start', cause)
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
    return () => {
      active = false
    }
  }, [])

  if (error !== null) {
    return (
      <div className="hud-layer pointer-events-none absolute">
        <div
          role="alert"
          className="type-readout pointer-events-auto absolute bottom-3 left-3 z-50 max-w-[min(36rem,calc(100%-1.5rem))] rounded border border-rose-400/40 bg-slate-950/85 px-3 py-2 text-slate-300"
        >
          <p className="text-rose-300">The interactive view could not start.</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      </div>
    )
  }
  if (runtime === null) return null
  const { App, catalog } = runtime
  return (
    <GameRuntimeBoundary>
      <App catalog={catalog} />
    </GameRuntimeBoundary>
  )
}
