import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { BrowserRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createConsoleSink, logHub } from '@inertialref/shared'
import { startAnalytics } from './analytics.ts'
import App from './App.tsx'
import { registerServiceWorker } from './net/registerServiceWorker.ts'
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

/*
 * Analytics, wired here for the same reason the log sink is: loading a third
 * party tag is a process-wide side effect and belongs to the process's entry
 * point, not to a component that might mount twice.
 *
 * It is a no-op unless this is a production build on the canonical host with no
 * Global Privacy Control set, so a dev server, `pnpm preview`, a Wrangler
 * preview URL and a fork all measure nothing. `analytics.ts` has the argument.
 * Individual page views come from `pages/DocumentMeta.tsx`, which is inside the
 * router and therefore knows when the address changed.
 */
startAnalytics()

/*
 * The last resort, when there is no React left to draw one.
 *
 * A throw at module scope, or a render that fails before any boundary is
 * mounted, takes `hud/ErrorBoundary.tsx` down with everything else — so the
 * failure that most needs saying is the one nothing in the tree can say. This
 * writes into `document.body` rather than `#root` deliberately: after an
 * uncaught error React has unmounted the tree and still owns that container,
 * and writing into a container React owns is how a fatal error becomes two.
 *
 * Same reason as `index.html` for the inline literals — they are the design
 * system's tokens, and by this point a stylesheet is not a thing to count on.
 */
function reportFatal(cause: unknown): void {
  const existing = document.getElementById('fatal')
  if (existing !== null) return
  const detail = cause instanceof Error ? cause.message : String(cause)
  console.error('InertialRef failed to start', cause)

  const panel = document.createElement('div')
  panel.id = 'fatal'
  panel.setAttribute('role', 'alert')
  panel.style.cssText = [
    'position:fixed',
    'bottom:0.75rem',
    'left:0.75rem',
    'max-width:calc(100vw - 1.5rem)',
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

const root = document.getElementById('root')
if (root === null) {
  reportFatal(new Error('#root is missing from index.html'))
  throw new Error('#root is missing from index.html')
}

/*
 * The catalog is awaited before the first render.
 *
 * It is a *generation input*, not a decoration: the world is built from a seed
 * and a catalog together, so a world constructed before it arrives is a
 * different world and would have to be thrown away and rebuilt — replacing the
 * ship, the frames and the starfield a second or two after the player is already
 * flying. One fetch of a precached 460 KB asset is the cheaper trade, and a
 * failed fetch falls back rather than blocking.
 */
try {
  const catalog = await loadStarCatalog()
  createRoot(root, {
    /*
     * Errors that reached the top of the tree without a boundary catching them.
     *
     * The overlay's boundaries cover the panels, the strip and the cutscene
     * layer; what they cannot cover is `App` itself, the `<Canvas>` mount, or
     * anything that throws before they exist. React unmounts the whole tree for
     * those, which in this app means the canvas goes with it — the same black
     * screen, arriving before there is any chrome left to explain it.
     */
    onUncaughtError: (cause: unknown) => reportFatal(cause),
  }).render(
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
            <App catalog={catalog} />
          </TooltipProvider>
        </MotionConfig>
      </BrowserRouter>
    </StrictMode>,
  )
} catch (cause) {
  // The synchronous half: a module that failed to evaluate, a catalog decode
  // that got past its own fallback, a `createRoot` that refused the container.
  reportFatal(cause)
}

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
 * The thirty-six lines that used to be here are `net/registerServiceWorker.ts`
 * now, with the page-readiness and registration dependencies injected. What
 * they hid was a seam: "the page is ready" and "install the worker" were
 * related only by module evaluation order, which is the thing that broke.
 */
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
