import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createConsoleSink, logHub } from '@inertialref/shared'
import App from './App.tsx'
import { BUILD_ID } from './build.ts'
import { loadStarCatalog } from './engine/catalogAsset.ts'
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

/*
 * The catalogue is awaited before the first render.
 *
 * It is a *generation input*, not a decoration: the world is built from a seed
 * and a catalogue together, so a world constructed before it arrives is a
 * different world and would have to be thrown away and rebuilt — replacing the
 * ship, the frames and the starfield a second or two after the player is already
 * flying. One fetch of a precached 460 KB asset is the cheaper trade, and a
 * failed fetch falls back rather than blocking.
 */
const catalog = await loadStarCatalog()

createRoot(root).render(
  <StrictMode>
    <App catalog={catalog} />
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
 *
 * The build id rides on the URL because `public/sw.js` is copied verbatim and
 * never compiled, so nothing can be injected into it. Registering a different
 * URL is what makes the browser install a new worker, and the worker reads the
 * id back off its own location to name its cache — which is how a deploy stops
 * inheriting the last one's precached index.html.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const url = `/sw.js?build=${encodeURIComponent(BUILD_ID)}`
    void navigator.serviceWorker.register(url).catch((cause: unknown) => {
      console.warn(
        'service worker registration failed; the game still runs online',
        cause,
      )
    })
  })
}
