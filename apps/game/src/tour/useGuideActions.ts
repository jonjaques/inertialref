import { useActions } from '../input/useKeymap.ts'
import type { GuideLifetime } from './lifetime.ts'
import type { GuideRuntime } from './runtime.ts'

/** Keyboard controls follow the conversation when its panel is closed. */
export function useGuideActions(guide: GuideLifetime<GuideRuntime>): void {
  useActions(
    ['guide.pause', 'guide.next', 'guide.back', 'guide.end'],
    (id, event) => {
      const runtime = guide.current
      if (event.phase !== 'down' || runtime === null) return
      if (id === 'guide.pause')
        runtime.command(
          runtime.getSnapshot().state === 'paused' ? 'resume' : 'pause',
        )
      if (id === 'guide.next') runtime.command('next')
      if (id === 'guide.back') runtime.command('back')
      if (id === 'guide.end') runtime.end()
    },
  )
}
