import { createInlineWorker } from '@inertialref/workers'
import { MemorySaveStore } from '@inertialref/persistence'
import { createGameTaskRegistry } from '../workers/registry.ts'
import { GameEngine } from './GameEngine.ts'

/**
 * The client, under Node — the one recipe both engine suites build from.
 *
 * `GameEngine` takes every seam it needs as an argument, which is what makes
 * it reachable outside a browser at all: an inline worker in place of the
 * pool, a memory store in place of IndexedDB, and a fake clock so frame
 * timings are exact rather than whatever the machine happened to be doing.
 *
 * Its own module rather than a helper in a test file, because the two files
 * that need it are two vitest projects — `gameEngine.test.ts` in the per-turn
 * suite and `gameEngine.descent.slow.test.ts` in the slow one — and a test
 * file cannot import a helper from the other without running its tests too.
 *
 * The registry is the game's own rather than the shared one, so the inline
 * pool a test drives serves exactly the names the browser's workers do.
 */
export function headlessEngine(): GameEngine {
  const registry = createGameTaskRegistry()
  let clock = 0
  return new GameEngine({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    store: new MemorySaveStore(),
    now: () => (clock += 16),
  })
}
