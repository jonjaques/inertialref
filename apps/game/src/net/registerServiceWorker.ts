/**
 * Register after load to keep install fetches off the document's critical path.
 * Hydration can finish after load, so readiness must be tested before listening.
 * The script URL carries the build id because public/sw.js is copied verbatim.
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
  /** Names the worker's build cache through its registration URL. */
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
