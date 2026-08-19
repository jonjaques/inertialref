import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

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
      console.warn('service worker registration failed; the game still runs online', cause)
    })
  })
}
