/*
 * Installing the service worker.
 *
 * Offline-first is one well-tested module — `public/sw.js`, whose routing is
 * executed against stubbed globals in `serviceWorker.test.ts` — plus the lines
 * that put it there, which were untested and are where the shipped bug was
 * (`3ed4872`): registration listened for a `load` event that had already fired.
 *
 * The seam is between **"the page is ready"** and **"install the worker"**, and
 * it used to be implicit in module evaluation order — which is exactly the
 * thing that broke. `main.tsx` awaits the packed catalog at module scope, and
 * that await resolves *after* load: measured on a cold visit to a review app,
 * load at 761 ms and the 460 KB catalog at 969 ms. A bare
 * `addEventListener('load', …)` is therefore a listener for an event that has
 * been and gone.
 *
 * It looked fine, which is the worst part. A registration persists across
 * visits, so the *second* visit to an origin — where the catalog comes out of
 * the HTTP cache and resolves before load — registers one, and every visit
 * after that is controlled. What was broken was the first visit to any origin,
 * which is exactly the visit where "install it and it works on a plane" has to
 * be true. It surfaced on a review app because that is the only origin nobody
 * had ever opened twice.
 *
 * Deferring to `load` at all is still right when it has not fired: the worker's
 * install fetches `/`, `/index.html` and the icons, and doing that while the
 * page is still pulling its own critical path is bandwidth taken from the thing
 * the player is waiting for.
 */

/**
 * What registration needs of the page. Injected, because both halves of the
 * bug — the readiness test and the listener — live here.
 */
export interface RegistrationPage {
  /** `document.readyState`. `'complete'` means `load` has already fired. */
  readyState(): DocumentReadyState
  /** Call `run` once, when `load` fires. */
  onLoad(run: () => void): void
}

/** What registration needs of the browser. `navigator.serviceWorker.register`. */
export type RegisterWorker = (url: string) => Promise<unknown>

export interface RegistrationOptions {
  readonly page: RegistrationPage
  readonly register: RegisterWorker
  /**
   * The build this bundle is.
   *
   * It rides on the URL because `public/sw.js` is copied verbatim and never
   * compiled, so nothing can be injected into it. Registering a *different* URL
   * is what makes the browser install a new worker, and the worker reads the id
   * back off its own location to name its cache (`sw.js`'s `BUILD`) — which is
   * how a deploy stops inheriting the last one's precached `index.html`.
   */
  readonly buildId: string
  readonly warn?: (message: string, cause: unknown) => void
}

/** The URL a build registers. One definition; `sw.js` reads the id back. */
export const serviceWorkerUrl = (buildId: string): string =>
  `/sw.js?build=${encodeURIComponent(buildId)}`

/**
 * Register the service worker, now or at `load`, exactly once.
 *
 * A failed registration warns and returns: the game runs online without one,
 * and throwing out of module scope would cost the session for a feature that is
 * an optimization on the first visit.
 */
export function registerServiceWorker(options: RegistrationOptions): void {
  const warn =
    options.warn ??
    ((message, cause) => {
      console.warn(message, cause)
    })

  let registered = false
  const install = (): void => {
    // `once: true` on the listener is not enough on its own: a caller that
    // both tested `readyState` and attached a listener would register twice.
    if (registered) return
    registered = true
    void options.register(serviceWorkerUrl(options.buildId)).catch((cause) => {
      warn(
        'service worker registration failed; the game still runs online',
        cause,
      )
    })
  }

  if (options.page.readyState() === 'complete') install()
  else options.page.onLoad(install)
}
