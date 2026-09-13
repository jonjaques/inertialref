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
