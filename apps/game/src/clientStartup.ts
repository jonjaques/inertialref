import { createConsoleSink, logHub } from '@inertialref/shared'
import { startAnalytics } from './analytics.ts'
import { BUILD_ID } from './build.ts'
import { isTimingLevel, setTimingLevel } from './engine/browserTiming.ts'
import { registerServiceWorker } from './net/registerServiceWorker.ts'
import { QUERY } from './pages/paths.ts'
import { installSchedulerYield } from './render/schedulerYield.ts'
import { read, TIMING_LEVEL } from './state/preferences.ts'

let started = false

/** Process-wide browser services start before catalog I/O or renderer boot. */
export function startClient(): void {
  if (started) return
  started = true

  // compileAsync yields between objects, including in hidden tabs where an
  // animation frame cannot finish boot. Install before importing the scene.
  installSchedulerYield()
  logHub.addSink(createConsoleSink(console, 'info'))

  // An effect inside App misses the catalog and renderer startup spans.
  const asked = new URLSearchParams(window.location.search).get(QUERY.timing)
  setTimingLevel(isTimingLevel(asked) ? asked : read(TIMING_LEVEL))
  startAnalytics()

  // The readiness adapter also covers hydration after the load event. A
  // listener alone would miss registration on that first visit.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    registerServiceWorker({
      page: {
        readyState: () => document.readyState,
        onLoad: (run) => window.addEventListener('load', run, { once: true }),
      },
      register: (url) => navigator.serviceWorker.register(url),
      buildId: BUILD_ID,
    })
  }
}
