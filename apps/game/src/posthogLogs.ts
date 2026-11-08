import { isPostHogStarted, posthog } from './posthog.ts'

/** Structured lifecycle logs owned exclusively by the PostHog integration. */
export const posthogLog = {
  clientStarted(timingLevel: string): void {
    if (!isPostHogStarted()) return
    posthog.logger.info('game client services started', {
      timing_level: timingLevel,
    })
  },

  interactiveRuntimeLoaded(): void {
    if (!isPostHogStarted()) return
    posthog.logger.info('interactive runtime loaded')
  },

  interactiveRuntimeFailed(): void {
    if (!isPostHogStarted()) return
    posthog.logger.warn('interactive runtime failed to load')
  },
}
