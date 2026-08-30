import { StrictMode, useEffect } from 'react'
import { MotionConfig } from 'motion/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createConsoleSink, logHub } from '@inertialref/shared'
import { startAnalytics } from './analytics.ts'
import App from './App.tsx'
import { BUILD_ID } from './build.ts'
import { KeymapProvider } from './input/KeymapProvider.tsx'
import { registerServiceWorker } from './net/registerServiceWorker.ts'
import { hrefOf, overlayStore, readLocation } from './pages/overlay.ts'

/*
 * The chrome island.
 *
 * Astro owns the document. The canvas is a second `client:only` island
 * (`scene/SceneBackdrop.tsx`) so this tree can paint without waiting for the
 * catalog or for `three/webgpu`. Site-wide side effects live here because they
 * are still process-wide: a log sink, a third-party tag, a service worker.
 * The layout does not re-run them; the island's module evaluates once.
 */

logHub.addSink(createConsoleSink(console, 'info'))
startAnalytics()

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

/**
 * The last resort, when there is no React left to draw one.
 *
 * A throw at module scope, or a render that fails before any boundary is
 * mounted, takes `hud/ErrorBoundary.tsx` down with everything else — so the
 * failure that most needs saying is the one nothing in the tree can say. This
 * writes into `document.body` rather than `#root` deliberately: after an
 * uncaught error React has unmounted the tree and still owns that container,
 * and writing into a container React owns is how a fatal error becomes two.
 *
 * Inline literals because a stylesheet is not a thing to count on at this
 * point. They are the design system's own tokens, written out.
 */
function reportFatal(cause: unknown): void {
  const existing = document.getElementById('fatal')
  if (existing !== null) return
  const detail = cause instanceof Error ? cause.message : String(cause)
  console.error('InertialRef failed to start', cause)

  const panel = document.createElement('div')
  panel.id = 'fatal'
  panel.setAttribute('role', 'alert')
  // Positioned off the safe insets rather than off the viewport edges. This
  // panel is outside `.hud-layer` by construction — the tree it would have
  // inherited the padding from is the tree that just failed — so it is the one
  // place in the application that spends `env()` itself. `viewport-fit=cover`
  // means the bottom-left corner of the viewport is under the home indicator on
  // a phone, which is where the message nobody can afford to miss would be.
  panel.style.cssText = [
    'position:fixed',
    'bottom:max(0.75rem, env(safe-area-inset-bottom, 0px))',
    'left:max(0.75rem, env(safe-area-inset-left, 0px))',
    'max-width:calc(100vw - max(1.5rem, env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px)))',
    'border:1px solid rgb(251 113 133 / 0.4)',
    'border-radius:0.5rem',
    'background:rgb(2 6 23 / 0.85)',
    'padding:0.5rem 0.75rem',
    'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
    'font-size:12px',
    'line-height:1.3333',
  ].join(';')

  const heading = document.createElement('div')
  heading.style.color = '#fda4af'
  heading.textContent = 'InertialRef did not start'
  const message = document.createElement('div')
  message.style.cssText =
    'margin-top:0.25rem;color:#94a3b8;overflow-wrap:anywhere'
  message.textContent = detail
  const hint = document.createElement('div')
  hint.style.cssText = 'margin-top:0.25rem;color:#475569'
  hint.textContent =
    'full stack in the console · a reload is safe, nothing was saved'

  panel.append(heading, message, hint)
  document.body.append(panel)
}

window.addEventListener('error', (event) => {
  if (event.error !== undefined && event.error !== null)
    reportFatal(event.error)
})
window.addEventListener('unhandledrejection', (event) => {
  reportFatal(event.reason)
})

export default function Root() {
  useEffect(() => {
    document.getElementById('boot')?.setAttribute('hidden', '')
    document.getElementById('doc-ssr')?.setAttribute('hidden', '')
    const sync = (): void => {
      overlayStore.getState().rehydrate(hrefOf(readLocation(window.location)))
      document.getElementById('doc-ssr')?.setAttribute('hidden', '')
    }
    sync()
    document.addEventListener('astro:page-load', sync)
    return () => document.removeEventListener('astro:page-load', sync)
  }, [])

  return (
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <KeymapProvider>
            <App />
          </KeymapProvider>
        </TooltipProvider>
      </MotionConfig>
    </StrictMode>
  )
}
