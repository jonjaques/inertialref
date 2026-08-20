import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createConsoleSink, logHub } from '@inertialref/shared'
import App from './App.tsx'
import './index.css'

/*
 * Logging is wired here rather than in the engine's constructor.
 *
 * `logHub` is module-global, so attaching a sink is a process-wide side effect
 * and belongs to the process's entry point — the headless runner does the same
 * thing in its own `main`. Constructing an engine used to attach one, which
 * meant every engine built in a test added another console sink to the same
 * hub.
 */
logHub.addSink(createConsoleSink(console, 'info'))

const root = document.getElementById('root')
if (root === null) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/*
 * Offline-first (spec §9).
 *
 * Registered only in production builds: a service worker in front of Vite's dev
 * server intercepts HMR and module requests and turns every edit into a
 * debugging session about caching.
 *
 * Once installed there is nothing else to fetch — the universe is generated
 * from a seed and saves live in IndexedDB — so the game is fully playable with
 * no server.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((cause: unknown) => {
      console.warn(
        'service worker registration failed; the game still runs online',
        cause,
      )
    })
  })
}
