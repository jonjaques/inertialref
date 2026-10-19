import { createInlineWorker } from '@inertialref/workers'
import { MemorySaveStore } from '@inertialref/persistence'
import { createGameTaskRegistry } from '../workers/registry.ts'
import { createThreadWorkerPort } from './threadWorker.ts'
import { GameEngine, type GameEngineOptions } from './GameEngine.ts'

/**
 * The client, under Node — the one recipe both engine suites build from.
 *
 * `GameEngine` takes every seam it needs as an argument, which is what makes
 * it reachable outside a browser at all: Node workers in place of the
 * browser's, a memory store in place of IndexedDB, and a fake clock so frame
 * timings are exact rather than whatever the machine happened to be doing.
 *
 * Its own module rather than a helper in a test file, because the two files
 * that need it are two vitest projects — `gameEngine.test.ts` in the per-turn
 * suite and `gameEngine.descent.slow.test.ts` in the slow one — and a test
 * file cannot import a helper from the other without running its tests too.
 *
 * The registry is the game's own rather than the shared one, so the pool a
 * test drives serves exactly the names the browser's workers do.
 *
 * `threads` picks the transport. Inline, the default, runs the host loop on a
 * microtask and answers inside the frame that asked, which is what the
 * per-turn suite wants. Threads run the same
 * loop in `universe.thread.ts`, one per `poolSize()`, for a test whose cost is
 * the field itself — each thread pays about 230 ms to load its modules, and
 * the slow descent pays it once against minutes of generation. Both clone
 * every message and honor the transfer list, so neither is a mock.
 */
export function headlessEngine(
  options: Pick<GameEngineOptions, 'catalog' | 'heightfieldArchive'> & {
    readonly threads?: boolean
  } = {},
): GameEngine {
  const { threads = false, ...rest } = options
  const registry = createGameTaskRegistry()
  let clock = 0
  return new GameEngine({
    ...rest,
    seed: 'inertialref',
    workers: threads
      ? () => createThreadWorkerPort()
      : () => createInlineWorker(registry),
    store: new MemorySaveStore(),
    now: () => (clock += 16),
  })
}
