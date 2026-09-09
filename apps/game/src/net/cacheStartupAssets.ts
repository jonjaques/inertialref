interface AssetController {
  postMessage(message: { type: 'CACHE_ASSETS'; urls: string[] }): void
}

export interface StartupAssetPage {
  readonly origin: string
  controller(): AssetController | null
  onControllerChange(run: () => void): void
  /** Buffered resource timing includes files loaded before hydration. */
  observeResources(run: (names: readonly string[]) => void): () => void
  onPageHide(run: () => void): void
}

/** Cache the files a first visit loads before its worker can intercept them. */
export function cacheStartupAssets(page: StartupAssetPage): void {
  const seen = new Set<string>()
  const pending = new Set<string>()
  const flush = () => {
    const controller = page.controller()
    if (controller === null) return
    const urls = [...pending]
    for (let index = 0; index < urls.length; index += 64) {
      const batch = urls.slice(index, index + 64)
      try {
        controller.postMessage({ type: 'CACHE_ASSETS', urls: batch })
        for (const url of batch) pending.delete(url)
      } catch {
        // A retiring worker can reject a message; the next controller retries.
        return
      }
    }
  }
  page.onControllerChange(flush)
  const stop = page.observeResources((names) => {
    for (const name of names) {
      const url = new URL(name, page.origin)
      if (
        url.origin !== page.origin ||
        !url.pathname.startsWith('/assets/') ||
        url.pathname.endsWith('.map') ||
        seen.has(url.href)
      )
        continue
      seen.add(url.href)
      pending.add(url.href)
    }
    flush()
  })
  page.onPageHide(stop)
}
