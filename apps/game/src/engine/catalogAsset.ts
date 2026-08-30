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
// The practical one agrees anyway: it is 460 KB, Vite would refuse to inline it,
// and as an asset it is cacheable and precacheable independently of the bundle.
import catalogUrl from '../../../../data/catalog/stars-150ly.irsc?url'

/*
 * The browser half of the catalog port.
 *
 * `packages/universe` decodes bytes and knows nothing about where they came
 * from; `apps/headless` reads the same file off disk. See
 * `apps/headless/src/catalog.ts`.
 */

const log = getLogger('game.catalog')
const timer = getTimer('game.catalog')

/**
 * Fetch and decode the packed catalog, or fall back to one star.
 *
 * A failed fetch degrades to a smaller galaxy rather than a blank screen: the
 * simulation, the flight model and everything procedural work identically
 * without it. That also makes the offline path the ordinary one — the service
 * worker precaches this like any other asset, and a cold load with no network
 * gets Sol and a procedural sky instead of an error.
 */
export async function loadStarCatalog(): Promise<StarCatalog> {
  /*
   * Two spans, because they fail differently and the fix differs with them.
   *
   * `main.tsx` awaits this before the first render — the catalog is a
   * *generation input*, so a world built without it is a different world — which
   * makes it the very first thing on the boot track and the one entry that
   * delays everything after it. A slow fetch is a network or service-worker
   * problem; a slow decode is 460 KB of ours. One span could not tell them
   * apart, and on an offline launch the first is nearly free while on a cold
   * one it is most of the wait.
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
    const response = await fetch(catalogUrl)
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    span.end()
    decode = timer.span('catalog.decode', BOOT_PHASE)
    const catalog = readCatalog(bytes)
    decode.end()
    log.info('catalog loaded', {
      version: catalog.version,
      systems: catalog.stars.length,
    })
    return catalog
  } catch (cause) {
    span.end()
    decode?.end()
    log.warn('no star catalog; falling back to Sol only', {
      cause: String(cause),
      url: catalogUrl,
    })
    return SOL_ONLY_CATALOG
  }
}
