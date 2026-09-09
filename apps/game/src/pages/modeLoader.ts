import type { AppMode } from './paths.ts'

function sharedModule<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => (pending ??= load())
}

/** Prefetch and React.lazy read the same module promise, including its failure. */
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
