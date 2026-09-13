import { UNAVAILABLE_GUIDE, type GuideHostPort } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { GuideRuntime } from './runtime.ts'
import { GuideLifetime } from './lifetime.ts'

/** Importing the mode admits no guide code, media, timer, or network request. */
export function createGuide(engine: GameEngine): GuideLifetime<GuideRuntime> {
  return new GuideLifetime(async () => {
    const { createGuideRuntime } = await import('./browser.ts')
    return createGuideRuntime(engine)
  })
}

/** A diagnostic request joins this mode's runtime rather than constructing another. */
export function mountGuide(
  engine: GameEngine,
  guide: GuideLifetime<GuideRuntime>,
): () => void {
  const release = guide.acquire()
  let tracing = false
  const port: GuideHostPort = {
    status: () =>
      guide.current?.diagnostics() ?? {
        ...UNAVAILABLE_GUIDE,
        available: true,
        state: 'idle',
      },
    ask: async (text) => {
      const runtime = await guide.load()
      if (engine.guide !== port) return UNAVAILABLE_GUIDE
      await runtime.ask(text)
      return runtime.diagnostics()
    },
    trace: (enabled) => {
      if (enabled !== undefined) tracing = enabled
      if (guide.current !== null) return guide.current.trace(enabled)
      if (enabled === true)
        void guide.load().then(
          (runtime) => {
            if (engine.guide === port) runtime.trace(tracing)
          },
          () => {},
        )
      return []
    },
  }
  engine.guide = port
  return () => {
    if (engine.guide === port) engine.guide = null
    release()
  }
}
