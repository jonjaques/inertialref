import { StrictMode, useEffect, useState } from 'react'
import { MotionConfig } from 'motion/react'
import { BrowserRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createConsoleSink, logHub } from '@inertialref/shared'
import type { StarCatalog } from '@inertialref/universe'
import { startAnalytics } from './analytics.ts'
import App from './App.tsx'
import { BUILD_ID } from './build.ts'
import { loadStarCatalog } from './engine/catalogAsset.ts'
import { KeymapProvider } from './input/KeymapProvider.tsx'
import { registerServiceWorker } from './net/registerServiceWorker.ts'

/*
 * The client's island.
 *
 * Astro owns the document. This module is what `client:only="react"` mounts
 * into `#root`, and the side effects that used to live in a Vite entry live
 * here because they are still process-wide: a log sink, a third-party tag, a
 * service worker. The layout does not re-run them; the island's module
 * evaluates once.
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
  // `textContent`, never `innerHTML`: this string came from a thrown error, and
  // an error message is the last place to start trusting markup.
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
  const [catalog, setCatalog] = useState<StarCatalog | null>(null)

  useEffect(() => {
    void loadStarCatalog().then(setCatalog, reportFatal)
  }, [])

  useEffect(() => {
    if (catalog === null) return
    document.getElementById('boot')?.setAttribute('hidden', '')
  }, [catalog])

  if (catalog === null) return null

  return (
    <StrictMode>
      {/*
       * The router wraps the whole tree, but it does not *own* the view: the
       * routed pages render inside `.hud-layer` (see `pages/ModeRoutes.tsx`), so
       * `<Canvas>` is never inside a route and a navigation cannot remount the
       * renderer.
       *
       * `useTransitions={false}` is a deliberate opt-out. React Router v8 wraps
       * router state updates in `startTransition` by default, and its own
       * guidance is to turn that off for applications built on
       * `useSyncExternalStore` — which this one is: `state/engineStore.ts`
       * republishes an engine snapshot eight times a second and a
       * `useSyncExternalStore` update cannot be a transition, so every sample
       * would force a synchronous update through a router mid-transition.
       * There is nothing to gain here in exchange — no route does data loading
       * and none of them suspend.
       */}
      <BrowserRouter useTransitions={false}>
        {/*
         * Reduced motion, honored globally rather than per animation.
         * `reducedMotion="user"` drops transform and layout animations for
         * anyone whose system asks for that, and leaves opacity alone — so a
         * page still fades in and simply does not travel. It cannot reach the
         * cutscene director or the scene, which are camera moves in a
         * simulation rather than interface motion.
         */}
        <MotionConfig reducedMotion="user">
          {/*
           * One tooltip provider for the whole tree.
           *
           * Radix requires an ancestor provider and it is what shares the
           * "one is already open, skip the delay" timer between them — per
           * tooltip, every hover would wait the full delay again, which on a
           * transport bar of five icon-only buttons is the behavior that
           * makes people give up on tooltips.
           *
           * The delay and the container both live in the wrapper now — 350 ms
           * (a hint, not a popover trailing the pointer), and a portal *into*
           * `.hud-layer`. The chip grew the panel material — translucent, with
           * a backdrop filter — and a backdrop filter samples what is behind
           * it, which on the extended path includes a star's disk above
           * diffuse white; that is exactly the case `dynamic-range-limit:
           * standard` exists for, so the content has to render inside the
           * clamped layer. `components/ui/tooltip.tsx` carries both decisions
           * and the reasoning.
           */}
          <TooltipProvider>
            {/* Above the router and outside every mode: the keyboard outlives
                a navigation, and rebuilding the one window listener per route
                would drop a held axis at the moment the mode changed. */}
            <KeymapProvider>
              <App catalog={catalog} />
            </KeymapProvider>
          </TooltipProvider>
        </MotionConfig>
      </BrowserRouter>
    </StrictMode>
  )
}
