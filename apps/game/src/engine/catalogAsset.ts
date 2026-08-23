import { getLogger } from '@inertialref/shared'
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
  try {
    const response = await fetch(catalogUrl)
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`)
    const catalog = readCatalog(new Uint8Array(await response.arrayBuffer()))
    log.info('catalog loaded', {
      version: catalog.version,
      systems: catalog.stars.length,
    })
    return catalog
  } catch (cause) {
    log.warn('no star catalog; falling back to Sol only', {
      cause: String(cause),
      url: catalogUrl,
    })
    return SOL_ONLY_CATALOG
  }
}
