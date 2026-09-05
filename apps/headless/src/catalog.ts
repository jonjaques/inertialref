import { readFileSync } from 'node:fs'
import { getLogger } from '@inertialref/shared'
import {
  readCatalog,
  SOL_ONLY_CATALOG,
  type StarCatalog,
} from '@inertialref/universe'

/*
 * The host half of the catalog port.
 *
 * `packages/universe` decodes bytes and knows nothing about where they came
 * from — it has to run in a browser, a worker and Node, and only one of those
 * has a filesystem. Node reads the committed assets off disk; the browser
 * fetches them as build assets. Same bytes, same decoder, two ten-line loaders.
 */

const log = getLogger('headless.catalog')

const VOLUME = new URL(
  '../../../data/catalog/stars-150ly.irsc',
  import.meta.url,
)
const SKY = new URL('../../../data/catalog/stars-sky.irsc', import.meta.url)

/**
 * Load the packed catalog, or fall back to one star.
 *
 * A missing asset degrades to a smaller galaxy rather than a failure to start:
 * the runner's job is to prove the simulation core works, and it can do that
 * without 7,123 real stars. `pnpm catalog:build` is what puts it back. The two
 * files degrade separately — a volume without its sky is the local
 * neighbourhood under a sky with no Orion in it, which is a smaller lie than
 * Sol alone.
 */
export function loadStarCatalog(): StarCatalog {
  let volume: Uint8Array
  try {
    volume = readFileSync(VOLUME)
  } catch (cause) {
    log.warn('no star catalog; falling back to Sol only', {
      cause: String(cause),
      hint: 'pnpm catalog:build',
    })
    return SOL_ONLY_CATALOG
  }
  let sky: Uint8Array | undefined
  try {
    sky = readFileSync(SKY)
  } catch (cause) {
    log.warn('no sky catalog; the distant bright stars are absent', {
      cause: String(cause),
      hint: 'pnpm catalog:build',
    })
  }
  try {
    const catalog = readCatalog(volume, sky)
    log.info('catalog loaded', {
      version: catalog.version,
      systems: catalog.stars.length,
      sky: catalog.sky.length,
    })
    return catalog
  } catch (cause) {
    log.warn('no star catalog; falling back to Sol only', {
      cause: String(cause),
      hint: 'pnpm catalog:build',
    })
    return SOL_ONLY_CATALOG
  }
}
