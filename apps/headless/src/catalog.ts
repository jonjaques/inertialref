import { readFileSync } from 'node:fs'
import { getLogger } from '@inertialref/shared'
import {
  readCatalog,
  SOL_ONLY_CATALOG,
  type StarCatalog,
} from '@inertialref/universe'

/*
 * The host half of the catalogue port.
 *
 * `packages/universe` decodes bytes and knows nothing about where they came
 * from — it has to run in a browser, a worker and Node, and only one of those
 * has a filesystem. Node reads the committed asset off disk; the browser fetches
 * it as a build asset. Same bytes, same decoder, two ten-line loaders.
 */

const log = getLogger('headless.catalog')

const ASSET = new URL('../../../data/catalog/stars-150ly.irsc', import.meta.url)

/**
 * Load the packed catalogue, or fall back to one star.
 *
 * A missing asset degrades to a smaller galaxy rather than a failure to start:
 * the runner's job is to prove the simulation core works, and it can do that
 * without 7,123 real stars. `pnpm catalog:build` is what puts it back.
 */
export function loadStarCatalog(): StarCatalog {
  try {
    const catalog = readCatalog(readFileSync(ASSET))
    log.info('catalogue loaded', {
      version: catalog.version,
      systems: catalog.stars.length,
    })
    return catalog
  } catch (cause) {
    log.warn('no star catalogue; falling back to Sol only', {
      cause: String(cause),
      hint: 'pnpm catalog:build',
    })
    return SOL_ONLY_CATALOG
  }
}
