/** Startup ports keep module loading and catalog I/O independently testable. */
export interface RuntimeLoading<App, Catalog> {
  prepare(): Promise<void>
  app(): Promise<App>
  catalog(): Promise<Catalog>
}

export function createRuntimeLoader<App, Catalog>(
  ports: RuntimeLoading<App, Catalog>,
) {
  let pending: Promise<{ App: App; catalog: Catalog }> | null = null
  return () => {
    pending ??= ports.prepare().then(async () => {
      const [App, catalog] = await Promise.all([ports.app(), ports.catalog()])
      return { App, catalog }
    })
    return pending
  }
}

/** One browser startup, shared by StrictMode's effect replay and every mode. */
export const loadRuntime = createRuntimeLoader({
  prepare: async () => {
    if (!beginGraphicsSession()) {
      const cause = new Error(
        'The previous tab ended with an active graphics session.',
      )
      runtimeFailure.report('restart', cause)
      throw cause
    }
    const { startClient } = await import('./clientStartup.ts')
    startClient()
  },
  app: async () => (await import('./App.tsx')).default,
  catalog: async () => {
    const { loadStarCatalog } = await import('./engine/catalogAsset.ts')
    return loadStarCatalog()
  },
})
import { beginGraphicsSession } from './graphicsSession.ts'
import { runtimeFailure } from './runtimeFailure.ts'
