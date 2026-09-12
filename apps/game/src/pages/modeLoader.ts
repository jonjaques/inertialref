import type { AppMode } from './paths.ts'

/**
 * A promise that says how it stands, in the shape `React.use` reads.
 *
 * `use` returns the value of a thenable whose `status` is `fulfilled`
 * without suspending, and that is the whole reason this is not `React.lazy`:
 * `lazy` learns a chunk has landed only from its own `.then`, a microtask
 * after the first render asks — so a mode whose code was fetched a minute
 * ago still suspends once, the fallback commits, and the mode leaving is
 * unmounted a frame before the mode arriving exists. With transitions off on
 * the router (`ShellRouter.tsx`), that frame is painted, and what it holds is
 * the ship's camera between two pictures that are not it.
 */
export type TrackedPromise<T> = Promise<T> &
  (
    | { readonly status: 'pending' }
    | { readonly status: 'fulfilled'; readonly value: T }
    | { readonly status: 'rejected'; readonly reason: unknown }
  )

/** The same promise while it is being written to; `TrackedPromise` is what a reader sees. */
interface Tracking<T> extends Promise<T> {
  status: 'pending' | 'fulfilled' | 'rejected'
  value?: T
  reason?: unknown
}

function sharedModule<T>(load: () => Promise<T>): () => TrackedPromise<T> {
  let pending: TrackedPromise<T> | null = null
  return () => {
    if (pending === null) {
      const promise = load() as Tracking<T>
      promise.status = 'pending'
      promise.then(
        (value) => {
          promise.status = 'fulfilled'
          promise.value = value
        },
        (reason: unknown) => {
          promise.status = 'rejected'
          promise.reason = reason
        },
      )
      // Every settled shape writes the field its status names, so the
      // mutable record satisfies the union at every moment a reader can see.
      pending = promise as TrackedPromise<T>
    }
    return pending
  }
}

/** Prefetch and the route read the same module promise, including its failure. */
export const modeLoaders = {
  cinema: sharedModule(() =>
    import('../cinema/CinemaMode.tsx').then((module) => ({
      default: module.CinemaMode,
    })),
  ),
  flight: sharedModule(() =>
    import('../flight/FlightMode.tsx').then((module) => ({
      default: module.FlightMode,
    })),
  ),
  planetarium: sharedModule(() =>
    import('../planetarium/PlanetariumMode.tsx').then((module) => ({
      default: module.PlanetariumMode,
    })),
  ),
}

export function preloadMode(mode: AppMode): Promise<unknown> | null {
  return mode === 'menu' || mode === 'docs' ? null : modeLoaders[mode]()
}
