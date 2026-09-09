import { getLogger, getTimer, type Span } from '@inertialref/shared'
import { BOOT_PHASE } from './frameTiming.ts'
import {
  readCatalog,
  SOL_ONLY_CATALOG,
  type StarCatalog,
} from '@inertialref/universe'
// `?url` and not an inline import, for two reasons that agree.
//
// The license one is the hard constraint: the packed catalog is Adapted
// Material under CC BY-SA 4.0 (docs/spikes.md §4), so it ships as its own asset
// with its own notice beside it. A base64 blob compiled into `index.js` invites
// exactly the argument the separate file forecloses.
//
// The practical one agrees anyway: the two files are 850 KB together, Vite
// would refuse to inline them, and as assets they are cacheable and
// precacheable independently of the bundle.
import volumeUrl from '../../../../data/catalog/stars-150ly.irsc?url'
import skyUrl from '../../../../data/catalog/stars-sky.irsc?url'

/*
 * The browser half of the catalog port.
 *
 * `packages/universe` decodes bytes and knows nothing about where they came
 * from; `apps/headless` reads the same files off disk. See
 * `apps/headless/src/catalog.ts`.
 */

const log = getLogger('game.catalog')
const timer = getTimer('game.catalog')

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Fetch and decode the packed catalog, or fall back to one star.
 *
 * A failed fetch degrades to a smaller galaxy rather than a blank screen: the
 * simulation, the flight model and everything procedural work identically
 * without it. That also makes the offline path the ordinary one — the service
 * worker precaches this like any other asset, and a cold load with no network
 * gets Sol and a procedural sky instead of an error.
 *
 * Two files, fetched together and degrading separately. The volume is the
 * generation input and the one `main.tsx` cannot do without; the sky is the
 * distant bright stars the draw adds on top, and a volume without it is a
 * correct neighbourhood under a sky with no Orion in it — a smaller lie than
 * Sol alone, so the volume is kept when only the sky fails.
 */
export async function loadStarCatalog(): Promise<StarCatalog> {
  /*
   * Two spans, because they fail differently and the fix differs with them.
   *
   * `main.tsx` awaits this before the first render — the catalog is a
   * *generation input*, so a world built without it is a different world — which
   * makes it the very first thing on the boot track and the one entry that
   * delays everything after it. A slow fetch is a network or service-worker
   * problem; a slow decode is 850 KB of ours. One span could not tell them
   * apart, and on an offline launch the first is nearly free while on a cold
   * one it is most of the wait. The two fetches run concurrently, so the fetch
   * span is the longer of the two rather than their sum.
   */
  /*
   * Both spans are held out here so the failure path can close whichever one
   * was open. A span left open emits nothing, so a fallback would silently drop
   * the entry that says how long the failure took — which on a timeout, or on a
   * truncated file that throws out of `readCatalog`, is the whole story. Both
   * are closed in the `catch` and `Span.end` is idempotent, so the one that
   * already finished is unaffected.
   */
  const span = timer.span('catalog.fetch', BOOT_PHASE)
  let decode: Span | null = null
  try {
    const [volume, sky] = await Promise.all([
      fetchBytes(volumeUrl),
      fetchBytes(skyUrl).catch((cause: unknown) => {
        log.warn('no sky catalog; the distant bright stars are absent', {
          cause: String(cause),
          url: skyUrl,
        })
        return undefined
      }),
    ])
    span.end()
    decode = timer.span('catalog.decode', BOOT_PHASE)
    let catalog: StarCatalog
    try {
      catalog = readCatalog(volume, sky)
    } catch (cause) {
      if (sky === undefined) throw cause
      log.warn('invalid sky catalog; keeping the local volume', {
        cause: String(cause),
      })
      catalog = readCatalog(volume)
    }
    decode.end()
    log.info('catalog loaded', {
      version: catalog.version,
      systems: catalog.stars.length,
      sky: catalog.sky.length,
    })
    return catalog
  } catch (cause) {
    span.end()
    decode?.end()
    log.warn('no star catalog; falling back to Sol only', {
      cause: String(cause),
      url: volumeUrl,
    })
    return SOL_ONLY_CATALOG
  }
}
