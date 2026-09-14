import { useActions } from '../input/useKeymap.ts'
import type { GuideLifetime } from './lifetime.ts'
import type { GuideRuntime } from './runtime.ts'

/** Keyboard controls follow the conversation when its panel is closed. */
export function useGuideActions(guide: GuideLifetime<GuideRuntime>): void {
  useActions(['guide.pause', 'guide.end'], (id, event) => {
    const runtime = guide.current
    if (event.phase !== 'down' || runtime === null) return
    if (id === 'guide.pause') {
      if (runtime.getSnapshot().paused) runtime.resume()
      else runtime.pause()
    }
    if (id === 'guide.end') void runtime.end()
  })
}
