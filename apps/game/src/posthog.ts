import posthog from 'posthog-js'

const PROJECT_TOKEN = import.meta.env.PUBLIC_POSTHOG_PROJECT_TOKEN
const HOST = import.meta.env.PUBLIC_POSTHOG_HOST

let started = false

/** Whether browser instrumentation has been initialized with valid configuration. */
export function isPostHogStarted(): boolean {
  return started
}

/** Initialize PostHog once when browser services start. */
export function startPostHog(): void {
  if (started) return

  if (!PROJECT_TOKEN) {
    if (import.meta.env.DEV) {
      console.error(
        new Error(
          'PUBLIC_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once PUBLIC_POSTHOG_PROJECT_TOKEN is configured',
        ),
      )
    }
    return
  }

  if (!HOST) {
    if (import.meta.env.DEV) {
      console.error(
        new Error(
          'PUBLIC_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once PUBLIC_POSTHOG_HOST is configured',
        ),
      )
    }
    return
  }

  started = true
  posthog.init(PROJECT_TOKEN, {
    api_host: HOST,
    defaults: '2026-01-30',
    logs: {
      serviceName: 'inertialref-game-web',
      environment: import.meta.env.PROD ? 'production' : 'development',
    },
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
  })
}

export { posthog }
