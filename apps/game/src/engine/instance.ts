import type { StarCatalog } from '@inertialref/universe'
import { GameEngine } from './GameEngine.ts'

/*
 * The engine, as a module singleton.
 *
 * Two islands share it — the backdrop that constructs it and the chrome that
 * calls it — and a React context cannot: they are separate trees. The same
 * shape as `engineStore.ts` and `keymapStore.ts`. A second copy would be a
 * second world.
 *
 * Construction waits on the packed catalog. `currentEngine` is null until
 * then, which is a reachable state the chrome already handles: the store
 * starts empty and the engine-shaped parts render when there is an engine.
 */

let singleton: GameEngine | null = null

export function engineInstance(catalog: StarCatalog): GameEngine {
  singleton ??= new GameEngine({
    seed:
      new URLSearchParams(window.location.search).get('seed') ?? 'inertialref',
    catalog,
  })
  return singleton
}

/** Null until the backdrop has the catalog. Chrome keys off the store. */
export function currentEngine(): GameEngine | null {
  return singleton
}
