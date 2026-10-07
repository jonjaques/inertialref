import { UNAVAILABLE_GUIDE, type GuideHostPort } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { GuideRuntime } from './runtime.ts'
import { GuideLifetime } from './lifetime.ts'
import type { GuideAccessOwner } from './verdict.ts'

/** Importing the mode admits no guide code, media, timer, or network request. */
export function createGuide(
  engine: GameEngine,
  access: GuideAccessOwner,
): GuideLifetime<GuideRuntime> {
  return new GuideLifetime(async () => {
    const { createGuideRuntime } = await import('./browser.ts')
    return createGuideRuntime(engine, access)
  })
}

/**
 * A diagnostic request joins this mode's runtime rather than constructing
 * another, and the mode's verdict governs both.
 *
 * Losing the grant ends a live session. Withdrawing the panel withdraws the
 * only Pause and End on screen, so a sign-out, or a switch to another account,
 * while a conversation is running would otherwise leave the microphone open
 * and the voice talking with nothing visible to stop either. `end` is a no-op
 * for a runtime that is offline or not loaded.
 */
export function mountGuide(
  engine: GameEngine,
  guide: GuideLifetime<GuideRuntime>,
  access: GuideAccessOwner,
): () => void {
  const release = guide.acquire()
  const unsubscribe = access.subscribe(() => {
    if (access.current().state !== 'granted') void guide.current?.end()
  })
  let tracing = false
  const port: GuideHostPort = {
    status: () => {
      if (guide.current !== null) return guide.current.diagnostics()
      // No runtime loaded: what the verdict says, so a visitor without the
      // grant reads as unavailable rather than as an idle guide.
      const verdict = access.current()
      return {
        ...UNAVAILABLE_GUIDE,
        available: verdict.state === 'granted',
        state:
          verdict.state === 'granted'
            ? 'idle'
            : verdict.state === 'checking'
              ? 'checking'
              : verdict.reason,
      }
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
    unsubscribe()
    if (engine.guide === port) engine.guide = null
    release()
  }
}
