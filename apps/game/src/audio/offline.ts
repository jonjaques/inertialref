import type { SoundtrackFile } from '@inertialref/protocol'
import { fileUrl } from './files.ts'
import type { OfflineSnapshot, SoundtrackStore } from './soundtrackStore.ts'

/*
 * The tracks a player keeps on this device: the soundtrack's offline tier.
 *
 * Two tiers, and the line between them is the player's to draw. Online, every
 * track streams by byte range from the Worker, and nothing is stored but what
 * the browser's own HTTP cache decides to keep. A track the player *keeps* is
 * downloaded whole into `inertialref-music`, and from then on the service
 * worker answers every range of it from there — online or off, and across
 * builds, because a content-addressed name can never go stale. The whole
 * soundtrack is a few hundred megabytes, which is too much to take from
 * somebody's phone unasked and nothing to somebody who installed the game to
 * play on a plane; so it is a choice, one track or one category or all of it,
 * with the size beside the switch.
 *
 * **The page downloads, not the worker.** A download the page makes can say
 * how far along it is, which a background fetch in the worker cannot do
 * portably, and the page is where the progress is drawn. The cost is that
 * closing the tab stops it; a half-kept track is not kept, and the switch
 * says so.
 *
 * **Nothing is believed that has not been checked.** A download whose length
 * is not the catalog's is discarded: a captive portal's login page and a
 * connection cut at 60% are both a 200, and a kept track that is either is a
 * track that fails exactly when there is no network to fail over to.
 */

/** Keep in step with `apps/game/public/sw.js`, which serves from it. */
export const MUSIC_CACHE = 'inertialref-music'

const available = (): boolean =>
  typeof caches !== 'undefined' && typeof window !== 'undefined'

export class OfflineLibrary {
  readonly #store: SoundtrackStore
  /** In-flight downloads, so a second press of Keep does not start a second. */
  readonly #pending = new Map<string, AbortController>()
  /**
   * Files waiting to be kept, oldest first.
   *
   * One download at a time, because "keep everything" is fifty files and the
   * connection that has to carry them is also carrying the track that is
   * playing: fifty parallel fetches would starve the stream the listener is
   * hearing in order to fill a cache they will hear later.
   */
  readonly #queue: SoundtrackFile[] = []
  #draining = false

  constructor(store: SoundtrackStore) {
    this.#store = store
  }

  #set(change: Partial<OfflineSnapshot>): void {
    this.#store.setState((held) => ({
      offline: { ...held.offline, ...change },
    }))
  }

  isKept(name: string): boolean {
    return this.#store.getState().offline.kept.includes(name)
  }

  /** Read the cache and the storage estimate back into the store. */
  async refresh(): Promise<void> {
    if (!available()) {
      this.#set({ supported: false })
      return
    }
    try {
      const cache = await caches.open(MUSIC_CACHE)
      const keys = await cache.keys()
      const kept = keys
        .map((request) => new URL(request.url).pathname)
        .filter((path) => path.startsWith('/media/music/'))
        .map((path) => path.slice('/media/'.length))
      this.#set({ supported: true, kept })
    } catch {
      // Storage denied (a private window, site data blocked): no offline tier,
      // and streaming is unaffected.
      this.#set({ supported: false, kept: [] })
      return
    }
    await this.#measure()
  }

  async #measure(): Promise<void> {
    const storage =
      typeof navigator === 'undefined' ? undefined : navigator.storage
    try {
      const estimate = await storage?.estimate()
      const persisted = (await storage?.persisted?.()) ?? null
      this.#set({
        usage:
          estimate?.usage === undefined || estimate.quota === undefined
            ? null
            : { used: estimate.usage, quota: estimate.quota },
        persisted,
      })
    } catch {
      // An estimate is a readout; failing to get one changes nothing.
    }
  }

  /**
   * Download `file` whole and keep it.
   *
   * Asks once for persistent storage first: without it, a browser under disk
   * pressure may evict the origin's caches, which for a kept soundtrack is
   * the one eviction somebody would notice — on a plane. The answer is the
   * browser's, and kept tracks work either way.
   */
  async keep(file: SoundtrackFile): Promise<void> {
    if (!available() || this.isKept(file.name) || this.#pending.has(file.name))
      return
    const abort = new AbortController()
    this.#pending.set(file.name, abort)
    this.#progress(file.name, 0)
    try {
      if (this.#store.getState().offline.persisted !== true) {
        await navigator.storage?.persist?.().catch(() => false)
      }
      const url = fileUrl(file)
      const response = await fetch(url, { signal: abort.signal })
      if (!response.ok || response.body === null) {
        throw new Error(`the server answered ${response.status}`)
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.byteLength
        this.#progress(file.name, Math.min(0.99, received / file.bytes))
      }
      if (received !== file.bytes) {
        throw new Error(
          `received ${received} bytes of ${file.bytes}; not keeping a partial file`,
        )
      }
      const cache = await caches.open(MUSIC_CACHE)
      await cache.put(
        url,
        new Response(new Blob(chunks as BlobPart[]), {
          headers: {
            'content-type': response.headers.get('content-type') ?? 'audio/mp4',
            'content-length': String(received),
          },
        }),
      )
      this.#set({ failure: null })
    } catch (cause) {
      if (!abort.signal.aborted) {
        this.#set({
          failure: `could not keep ${file.name.split('/').at(-1)}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        })
      }
    } finally {
      this.#pending.delete(file.name)
      this.#progress(file.name, null)
      await this.refresh()
    }
  }

  /** Keep each of `files` that is not kept yet, one after another. */
  keepAll(files: readonly SoundtrackFile[]): void {
    for (const file of files) {
      if (
        this.isKept(file.name) ||
        this.#pending.has(file.name) ||
        this.#queue.some((queued) => queued.name === file.name)
      )
        continue
      this.#queue.push(file)
    }
    this.#set({ queued: this.#queue.length })
    void this.#drain()
  }

  /** Stop a keep of many: drop what is waiting and abort what is downloading. */
  stop(): void {
    this.#queue.length = 0
    this.#set({ queued: 0 })
    for (const abort of this.#pending.values()) abort.abort()
  }

  async #drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    try {
      for (;;) {
        const file = this.#queue.shift()
        if (file === undefined) break
        this.#set({ queued: this.#queue.length })
        await this.keep(file)
      }
    } finally {
      this.#draining = false
    }
  }

  /** Remove every kept track, and stop anything still downloading. */
  async releaseAll(): Promise<void> {
    this.stop()
    if (!available()) return
    try {
      await caches.delete(MUSIC_CACHE)
    } catch {
      // As in refresh: nothing to release where nothing could be kept.
    }
    await this.refresh()
  }

  /** Stop keeping `file`, or stop downloading it. */
  async release(file: SoundtrackFile): Promise<void> {
    this.#pending.get(file.name)?.abort()
    if (!available()) return
    try {
      await (await caches.open(MUSIC_CACHE)).delete(fileUrl(file))
    } catch {
      // As in refresh: nothing to release where nothing could be kept.
    }
    await this.refresh()
  }

  #progress(name: string, fraction: number | null): void {
    this.#store.setState((held) => {
      const downloading = { ...held.offline.downloading }
      if (fraction === null) delete downloading[name]
      else downloading[name] = fraction
      return { offline: { ...held.offline, downloading } }
    })
  }
}
